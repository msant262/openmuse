import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import { attachmentLimit } from "../../../packages/domain/src/attachments.ts";
import type {
  ComputerCommand,
  ComputerDirectory,
  ComputerSnapshot,
} from "../../../packages/domain/src/computer.ts";
import { base64Limit, decodeBase64 } from "./base64.ts";
import { computerCommandSchema, workspacePath } from "./computer.ts";
import { commandReceiptSchema, mediaSchema } from "./computer-contract.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { RuntimePause, RuntimePausedError } from "./engine/runtime-pause.ts";
import { AppError } from "./errors.ts";

type Intent = ComputerCommand & { binding: string };
export class ComputerBusyError extends AppError {
  readonly notDispatched = true;
  constructor() {
    super(
      "The personal computer is busy. This operation was not dispatched; retry with the same operation ID.",
      409,
    );
    this.name = "ComputerBusyError";
  }
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const stateSchema = z.object({
  status: z.enum(["running", "stopped"]),
  message: z.string().max(500).optional(),
  commands: z.array(commandReceiptSchema).max(100),
});
/** No host process, Docker socket or shell fallback: all execution goes to the guarded sidecar. */
export class RpcComputerService {
  constructor(
    readonly db: Store,
    readonly config: Config,
    private readonly upstream: typeof fetch = fetch,
  ) {}
  private enabled() {
    if (
      !this.config.computerEnabled ||
      !this.config.computerUrl ||
      !this.config.computerToken ||
      this.config.computerToken.length < 32 ||
      this.config.computerProfile !== "open"
    )
      throw new AppError("Configure the guarded open RPC computer before using it", 503);
  }
  private async request(path: string, body?: unknown, signal?: AbortSignal) {
    this.enabled();
    let response: Response;
    try {
      response = await this.upstream(`${this.config.computerUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(30000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.computerToken}`,
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch {
      throw new AppError(
        "Computer connection was interrupted. Existing commands will not be retried.",
        503,
      );
    }
    if (!response.ok) {
      if (response.status === 409) {
        const payload = await response
          .clone()
          .json()
          .catch(() => undefined);
        if (
          payload &&
          typeof payload === "object" &&
          "code" in payload &&
          payload.code === "busy" &&
          "notDispatched" in payload &&
          payload.notDispatched === true
        )
          throw new ComputerBusyError();
      }
      const status =
        response.status === 404
          ? 404
          : response.status === 422
            ? 422
            : response.status === 401
              ? 503
              : 503;
      throw new AppError(
        status === 404
          ? "Computer receipt not found"
          : status === 422
            ? "Computer request failed. Check path, size, active jobs and operation ID."
            : "Computer egress protection or RPC is unavailable; the operation was not confirmed",
        status,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new AppError("Computer response is empty", 502);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 36 * 1024 * 1024) {
          await reader.cancel();
          throw new AppError("Computer response is too large", 502);
        }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("Computer returned an invalid response", 502);
    }
  }
  private async bind(owner: string) {
    this.enabled();
    const id = hash(this.config.computerDeploymentId ?? this.config.computerUrl ?? "computer");
    await this.db.insertIfAbsent("__computer__", "rpc-owner", { id, owner });
    if (
      (await this.db.get<{ id: string; owner: string }>("__computer__", "rpc-owner", id))?.owner !==
      owner
    )
      throw new AppError("This personal computer belongs to another owner", 403);
  }
  private async save(owner: string, expected: ComputerCommand, raw: unknown) {
    const receipt = commandReceiptSchema.parse(raw);
    if (
      receipt.id !== expected.id ||
      receipt.command !== expected.command ||
      receipt.cwd !== expected.cwd ||
      receipt.kind !== expected.kind ||
      receipt.timeoutMs !== expected.timeoutMs ||
      receipt.background !== expected.background
    )
      throw new AppError("Computer receipt does not match its owned command", 502);
    const previous = await this.db.get<Intent>(owner, "computer-commands", receipt.id);
    await this.db.put(owner, "computer-commands", {
      ...receipt,
      ...(previous?.binding && { binding: previous.binding }),
    });
    return receipt;
  }
  async command(owner: string, id: string): Promise<ComputerCommand> {
    await this.bind(owner);
    const command = await this.db.get<Intent>(owner, "computer-commands", id);
    if (!command) throw new AppError("Computer command not found", 404);
    if (command.status !== "running") return commandReceiptSchema.parse(command);
    try {
      return await this.save(owner, command, await this.request(`/rpc/jobs/${command.id}`));
    } catch (error) {
      if (!(error instanceof AppError) || error.status !== 404) throw error;
      const missing = {
        ...command,
        status: "interrupted" as const,
        completedAt: new Date().toISOString(),
        stderr:
          "Computer receipt is missing; outcome unknown. Inspect files before repeating work.",
      };
      await this.db.put(owner, "computer-commands", missing);
      return commandReceiptSchema.parse(missing);
    }
  }
  async snapshot(owner: string): Promise<ComputerSnapshot> {
    const commands = (await this.db.list<Intent>(owner, "computer-commands"))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 100);
    const base = {
      enabled: Boolean(this.config.computerEnabled),
      provider: "rpc" as const,
      workspacePath: "/workspace" as const,
      network: "public-only" as const,
      profile: "open" as const,
      maxTimeoutMs: this.config.computerCommandTimeoutMs ?? 1800000,
      commands: commands.map((c) => commandReceiptSchema.parse(c)),
    };
    if (!base.enabled) return { ...base, status: "unconfigured" };
    try {
      await this.bind(owner);
      const remote = stateSchema.parse(await this.request("/rpc/status"));
      for (const command of commands.filter((c) => c.status === "running"))
        await this.command(owner, command.id);
      return {
        ...base,
        status: remote.status,
        ...(remote.message && { message: remote.message }),
        commands: (await this.db.list<Intent>(owner, "computer-commands"))
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
          .slice(0, 100)
          .map((c) => commandReceiptSchema.parse(c)),
      };
    } catch (error) {
      return {
        ...base,
        status: "error",
        message: error instanceof AppError ? error.message : "Computer response is invalid",
      };
    }
  }
  async start(owner: string) {
    await this.bind(owner);
    await new RuntimePause(this.db).assertResumed(owner);
    stateSchema.parse(await this.request("/rpc/start", {}));
    return this.snapshot(owner);
  }
  async stop(owner: string) {
    await this.bind(owner);
    stateSchema.parse(await this.request("/rpc/stop", {}));
    return this.snapshot(owner);
  }
  async cancel(owner: string, id: string) {
    const owned = await this.db.get<Intent>(owner, "computer-commands", id);
    if (!owned) throw new AppError("Computer command not found", 404);
    await this.bind(owner);
    return this.save(owner, owned, await this.request(`/rpc/jobs/${owned.id}/cancel`, {}));
  }
  execute(
    owner: string,
    raw: unknown,
    options: {
      idempotencyKey?: string;
      signal?: AbortSignal;
      dispatchGuard?: () => Promise<void>;
      onDispatch?: (receiptId: string) => Promise<void>;
    } = {},
  ) {
    const args = computerCommandSchema.parse(raw);
    return this.submit(owner, { ...args, cwd: workspacePath(args.cwd), kind: "command" }, options);
  }
  media(
    owner: string,
    kind: "transcribe" | "preview",
    raw: unknown,
    options: {
      idempotencyKey?: string;
      signal?: AbortSignal;
      dispatchGuard?: () => Promise<void>;
      onDispatch?: (receiptId: string) => Promise<void>;
    } = {},
  ) {
    const { timeoutMs, background, ...parameters } = mediaSchema.parse(raw);
    for (const value of [
      parameters.path,
      parameters.textPath,
      parameters.srtPath,
      parameters.outputPath,
    ])
      if (value) workspacePath(value);
    return this.submit(
      owner,
      {
        kind,
        command: `${kind} ${parameters.path}`,
        cwd: "/workspace",
        parameters,
        timeoutMs,
        background,
      },
      options,
    );
  }
  private async submit(
    owner: string,
    args: {
      command: string;
      cwd: string;
      kind: "command" | "transcribe" | "preview";
      parameters?: unknown;
      timeoutMs?: number;
      background?: boolean;
    },
    options: {
      idempotencyKey?: string;
      signal?: AbortSignal;
      dispatchGuard?: () => Promise<void>;
      onDispatch?: (receiptId: string) => Promise<void>;
    },
  ): Promise<ComputerCommand> {
    await this.bind(owner);
    const timeoutMs = args.timeoutMs ?? this.config.computerCommandTimeoutMs ?? 1800000;
    if (timeoutMs > (this.config.computerCommandTimeoutMs ?? 1800000))
      throw new AppError("Command timeout exceeds configured computer maximum", 422);
    const request = { ...args, timeoutMs, background: args.background ?? false };
    const binding = hash(JSON.stringify(request));
    const id = hash(`${owner}:${options.idempotencyKey ?? randomUUID()}`);
    const prior = await this.db.get<Intent>(owner, "computer-commands", id);
    if (prior) {
      if (prior.binding !== binding)
        throw new AppError("Operation ID already belongs to different arguments", 409);
      if (prior.status === "rejected_not_dispatched") {
        if (!(await this.db.resetRejectedComputerCommand(owner, id, binding)))
          throw new AppError("This operation is already being retried", 409);
        return this.submit(owner, args, options);
      }
      return this.command(owner, id);
    }
    options.signal?.throwIfAborted();
    const intent: Intent = {
      id,
      command: args.command,
      cwd: args.cwd,
      kind: args.kind,
      timeoutMs,
      background: request.background,
      status: "running",
      stdout: "",
      stderr: "",
      truncated: false,
      startedAt: new Date().toISOString(),
      binding,
    };
    if (!(await this.db.insertIfAbsent(owner, "computer-commands", intent)))
      return this.submit(owner, args, options);
    try {
      await options.onDispatch?.(id);
    } catch (error) {
      await this.db.put(owner, "computer-commands", {
        ...intent,
        status: "failed",
        completedAt: new Date().toISOString(),
        stderr: "Dispatch ownership was not confirmed; no RPC request was sent.",
      });
      throw error;
    }
    let receipt: ComputerCommand;
    try {
      // This guard is the final local check after ownership/audit persistence.
      await options.dispatchGuard?.();
      receipt = await this.save(
        owner,
        intent,
        await this.request("/rpc/jobs", { ...request, id }, options.signal),
      );
    } catch (error) {
      if (error instanceof ComputerBusyError) {
        const rejected: Intent = {
          ...intent,
          status: "rejected_not_dispatched",
          completedAt: new Date().toISOString(),
          stderr: "The computer was busy. This operation was not dispatched and can be retried.",
        };
        await this.db.put(owner, "computer-commands", rejected);
        return commandReceiptSchema.parse(rejected);
      }
      if (error instanceof RuntimePausedError) {
        await this.db.put(owner, "computer-commands", {
          ...intent,
          status: "rejected_not_dispatched",
          completedAt: new Date().toISOString(),
          stderr: "Global pause prevented dispatch. This operation was not sent.",
        });
        throw error;
      }
      await this.db.put(owner, "computer-commands", {
        ...intent,
        status: "interrupted",
        completedAt: new Date().toISOString(),
        stderr: "Submission outcome is unknown; inspect files before repeating work.",
      });
      throw error;
    }
    if (request.background) return receipt;
    const deadline = Date.now() + timeoutMs + 10000;
    while (receipt.status === "running" && Date.now() < deadline) {
      if (options.signal?.aborted) {
        await this.cancel(owner, id);
        options.signal.throwIfAborted();
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      receipt = await this.command(owner, id);
    }
    return receipt;
  }
  private async file(
    owner: string,
    operation: string,
    path: string,
    extra: Record<string, unknown> = {},
  ) {
    await this.bind(owner);
    if (["write", "mkdir", "write_binary"].includes(operation))
      await new RuntimePause(this.db).assertResumed(owner);
    return this.request("/rpc/files", { operation, path: workspacePath(path), ...extra });
  }
  async list(owner: string, path = "/workspace"): Promise<ComputerDirectory> {
    return z
      .object({
        path: z.string(),
        entries: z
          .array(
            z.object({
              name: z.string(),
              path: z.string(),
              type: z.enum(["file", "directory", "symlink"]),
              size: z.number().min(0),
            }),
          )
          .max(1000),
      })
      .parse(await this.file(owner, "list", path));
  }
  async read(owner: string, path: string) {
    return z
      .object({ path: z.string(), text: z.string().max(262144) })
      .parse(await this.file(owner, "read", path));
  }
  async write(owner: string, path: string, text: string) {
    if (Buffer.byteLength(text) > 262144)
      throw new AppError("Text files must be 256 KB or smaller", 413);
    return z.object({ path: z.string() }).parse(await this.file(owner, "write", path, { text }));
  }
  async mkdir(owner: string, path: string) {
    return z.object({ path: z.string() }).parse(await this.file(owner, "mkdir", path));
  }
  async writeBytes(owner: string, path: string, bytes: Uint8Array) {
    if (bytes.length > attachmentLimit)
      throw new AppError("Attachments must be 25 MB or smaller", 413);
    return z.object({ path: z.string() }).parse(
      await this.file(owner, "write_binary", path, {
        base64: Buffer.from(bytes).toString("base64"),
      }),
    );
  }
  async fileBytes(owner: string, path: string) {
    const result = z
      .object({
        path: z.string(),
        base64: z.string().max(base64Limit(attachmentLimit)),
      })
      .parse(await this.file(owner, "read_binary", path));
    if (result.path !== workspacePath(path))
      throw new AppError("Computer returned a different file", 502);
    const bytes = decodeBase64(result.base64, attachmentLimit);
    if (!bytes) throw new AppError("Computer returned invalid or oversized base64 file data", 502);
    return { name: posix.basename(result.path), bytes };
  }
  async writePdf(owner: string, path: string, bytes: Uint8Array) {
    if (bytes.length > 10 * 1024 * 1024 || Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-")
      throw new AppError("Choose a PDF of 10 MB or smaller", 422);
    return this.writeBytes(owner, path, bytes);
  }
  async pdfBytes(owner: string, path: string) {
    const result = await this.fileBytes(owner, path);
    if (
      result.bytes.length > 10 * 1024 * 1024 ||
      result.bytes.subarray(0, 5).toString() !== "%PDF-"
    )
      throw new AppError("Choose a PDF of 10 MB or smaller", 422);
    return result;
  }
}
