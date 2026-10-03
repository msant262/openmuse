import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  browserBodyHash,
  verifyBrowserExecutor,
} from "../../../packages/domain/src/browser-executor.ts";
import { WorkerError } from "./errors.ts";

type Result = { status: number; data: unknown };
type State = {
  epoch: number;
  fence: number;
  tasks: Record<string, { revision: number; bindingFence: number }>;
};
/** Outer per-profile queue validates authority again at dispatch. The existing
 * BrowserManager still owns Chromium/SSRF/download/control queues and cleanup. */
export class BrowserExecutorGate {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly options: {
    token: string;
    dataDir: string;
    executorId: string;
    instanceId: string;
  };
  constructor(options: { token: string; dataDir: string; executorId: string; instanceId: string }) {
    this.options = options;
  }
  async run(
    encoded: string,
    request: { sessionId: string; method: string; path: string; body: string },
    dispatch: () => Promise<Result>,
  ): Promise<Result> {
    const authorization = verifyBrowserExecutor(this.options.token, encoded);
    if (
      !authorization ||
      authorization.sessionId !== request.sessionId ||
      authorization.profileId !== request.sessionId ||
      authorization.method !== request.method ||
      authorization.path !== request.path ||
      authorization.bodyHash !== browserBodyHash(request.body)
    )
      throw new WorkerError(
        "INVALID_BROWSER_AUTHORITY",
        "Browser authority does not match the request.",
        409,
      );
    if (
      authorization.executorId !== this.options.executorId ||
      authorization.instanceId !== this.options.instanceId ||
      authorization.sessionGeneration !== `${this.options.instanceId}:${request.sessionId}` ||
      authorization.expiresAt <= Date.now()
    )
      throw new WorkerError(
        "STALE_BROWSER_BINDING",
        "Browser lifecycle or authority expired. Obtain a fresh observation.",
        409,
      );
    if (
      authorization.operationClass !== "mutable" &&
      !(
        (["/sessions", "/sessions/human"].includes(request.path) && request.method === "POST") ||
        (/^\/sessions\/[^/]+\/(read|snapshot|screenshot|agent-screenshot|control)$/.test(
          request.path,
        ) &&
          request.method === "GET") ||
        ((request.path.endsWith("/inspect") || request.path.endsWith("/search")) &&
          request.method === "POST")
      )
    )
      throw new WorkerError(
        "INVALID_BROWSER_AUTHORITY",
        "Only concrete reading operations may use read authority.",
        409,
      );
    const key = createHash("sha256").update(request.sessionId).digest("hex");
    const next = (this.queues.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (authorization.expiresAt <= Date.now())
          throw new WorkerError(
            "STALE_BROWSER_BINDING",
            "Browser authority expired while queued.",
            409,
          );
        const directory = join(this.options.dataDir, ".executor-authority");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, `${key}.json`);
        const read = async <T>(file: string): Promise<T | undefined> => {
          try {
            return JSON.parse(await readFile(file, "utf8")) as T;
          } catch (error) {
            if ((error as { code?: string }).code === "ENOENT") return;
            throw error;
          }
        };
        const write = async (file: string, value: unknown) => {
          const temporary = `${file}.${randomUUID()}.tmp`;
          await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
          await rename(temporary, file);
        };
        const previous = await read<State>(path),
          task = previous?.tasks[authorization.taskId];
        if (
          (previous &&
            (authorization.epoch < previous.epoch || authorization.fence < previous.fence)) ||
          (task &&
            (authorization.revision < task.revision ||
              authorization.bindingFence < task.bindingFence))
        )
          throw new WorkerError(
            "STALE_BROWSER_BINDING",
            "Browser profile fence or task revision is stale.",
            409,
          );
        await write(path, {
          epoch: authorization.epoch,
          fence: authorization.fence,
          tasks: {
            ...previous?.tasks,
            [authorization.taskId]: {
              revision: authorization.revision,
              bindingFence: authorization.bindingFence,
            },
          },
        });
        const receiptPath = join(
          directory,
          `${createHash("sha256").update(authorization.operationId).digest("hex")}.receipt.json`,
        );
        const digest = browserBodyHash(JSON.stringify(authorization));
        if (authorization.operationClass === "mutable" && request.method === "POST") {
          const receipt = await read<{ digest: string; status: string; result?: Result }>(
            receiptPath,
          );
          if (receipt) {
            if (receipt.digest !== digest)
              throw new WorkerError(
                "INVALID_BROWSER_AUTHORITY",
                "Browser operation ID belongs to another request.",
                409,
              );
            if (receipt.status === "succeeded" && receipt.result) return receipt.result;
            throw new WorkerError(
              "OUTCOME_UNKNOWN",
              "The browser operation was already dispatched. Inspect its outcome before another action.",
              409,
            );
          }
          await write(receiptPath, { digest, status: "dispatching" });
        }
        const result = await dispatch();
        if (authorization.operationClass === "mutable" && request.method === "POST")
          await write(receiptPath, { digest, status: "succeeded", result });
        return result;
      });
    this.queues.set(key, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(key) === next) this.queues.delete(key);
    }
  }
}
