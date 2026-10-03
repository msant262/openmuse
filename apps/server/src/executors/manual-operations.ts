import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type { CompletionAssessment } from "../../../../packages/domain/src/runtime.ts";
import type { Auth } from "../auth.ts";
import { computerCommandSchema, computerPathSchema, computerWriteSchema } from "../computer.ts";
import { type ComputerBackend, commandReceiptSchema, mediaSchema } from "../computer-contract.ts";
import { bindingHash } from "../conversation-inbox.ts";
import type { AgentService } from "../engine/service.ts";
import type { TaskContext } from "../engine/worker.ts";
import { AppError } from "../errors.ts";
import type { Files } from "../files.ts";
import { backgroundFailure } from "../log.ts";
import { safeOperationId, sha256Schema } from "./protocol.ts";

const requestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.enum(["start", "stop"]), args: z.object({}) }),
  z.object({ method: z.literal("execute"), args: computerCommandSchema }),
  z.object({ method: z.enum(["list", "read", "mkdir", "export"]), args: computerPathSchema }),
  z.object({ method: z.literal("write"), args: computerWriteSchema }),
  z.object({
    method: z.literal("import"),
    args: computerPathSchema.extend({ fileId: z.string().min(1) }),
  }),
  z.object({ method: z.enum(["transcribe", "preview"]), args: mediaSchema }),
  z.object({
    method: z.enum(["capture", "trash"]),
    args: z.object({ artifactId: safeOperationId, expectedVersion: sha256Schema }),
  }),
  z.object({
    method: z.literal("restore"),
    args: z.object({ versionId: safeOperationId, expectedCurrentVersion: sha256Schema.nullable() }),
  }),
]);
export type ManualNativeRequest = z.infer<typeof requestSchema>;
type ManualRecord = {
  id: string;
  deviceId: string;
  requestId: string;
  binding: string;
  request: ManualNativeRequest;
  initialUpdatedAt: string;
  result?: unknown;
};
export const nativeDeviceRequests = new AsyncLocalStorage<{ owner: string; deviceId: string }>();
const scope = new AsyncLocalStorage<{ owner: string; deviceId: string }>();
export const currentManualNativeScope = () => scope.getStore();

/** Typed requests are admitted by the existing TaskWorker, including after restart.
 * A model cannot select this path: the private request record is written by these
 * authenticated routes, never by createTask input or task state supplied by a tool.
 */
export class ManualNativeOperations {
  constructor(
    readonly agent: AgentService,
    private readonly computer: ComputerBackend,
    private readonly files: Files,
  ) {}
  async enqueue(owner: string, deviceId: string, requestId: string, raw: unknown) {
    const request = requestSchema.parse(raw);
    safeOperationId.parse(requestId);
    await this.device(owner, deviceId);
    await this.agent.runtimePause.assertResumed(owner);
    const binding = bindingHash(request);
    const task = await this.agent.createTask(
      owner,
      {
        kind: "agent",
        title: `Computer: ${request.method}`,
        prompt: `Perform the requested computer ${request.method} operation and retain its receipt`,
      },
      `native-manual:${deviceId}:${requestId}`,
      true,
    );
    const value: ManualRecord = {
      id: task.id,
      deviceId,
      requestId,
      binding,
      request,
      initialUpdatedAt: task.updatedAt,
    };
    const record =
      (await this.agent.db.insertIfAbsent(owner, "native-manual-operations", value)) ??
      (await this.agent.db.get<ManualRecord>(owner, "native-manual-operations", task.id));
    if (!record || record.deviceId !== deviceId || record.binding !== binding)
      throw new AppError("Manual request ID belongs to a different operation", 409);
    // Only the initial held construction may enqueue. A retry never resumes a
    // user-paused/cancelled task or repeats a finished physical intention.
    if (task.status === "paused" && task.attempts === 0 && task.state.nativeManualReady !== true)
      await this.agent.db.compareAndSwapTask(
        owner,
        task.id,
        { status: "paused", attempts: 0, updatedAt: record.initialUpdatedAt },
        { status: "queued", state: { ...task.state, nativeManualReady: true } },
      );
    return { taskId: task.id, result: await this.visibleResult(owner, record) };
  }
  private async device(owner: string, id: string) {
    const device = await this.agent.db.get<{ owner: string; revokedAt: number | null }>(
      "system",
      "device-sessions",
      id,
    );
    if (!device || device.owner !== owner || device.revokedAt !== null)
      throw new AppError("Manual native operation requires a paired device", 403);
  }
  async execute(
    owner: string,
    task: AgentTask,
    context: TaskContext,
  ): Promise<Partial<AgentTask> | undefined> {
    const record = await this.agent.db.get<ManualRecord>(
      owner,
      "native-manual-operations",
      task.id,
    );
    if (!record) return undefined;
    await this.device(owner, record.deviceId);
    if (Number(task.state.appliedRevision ?? 0) !== 0)
      return {
        status: "waiting_input",
        question:
          "This typed computer request has changed direction. Inspect its receipt and submit the revised operation explicitly.",
      };
    const completed = task.state.completedComputerJob;
    if (completed && typeof completed === "object") {
      const finished = completed as { id: string; status: string };
      const receipt = await this.computer.command?.(owner, finished.id);
      if (!receipt) throw new AppError("Native command receipt is unavailable", 503);
      await this.agent.db.compareAndSwap(
        owner,
        "native-manual-operations",
        record.id,
        { binding: record.binding },
        { result: receipt },
      );
      const completion = await this.assess(owner, task);
      return {
        status:
          receipt.status !== "succeeded"
            ? "failed"
            : completion.status === "verified"
              ? "succeeded"
              : "waiting_input",
        completion,
        state: task.state,
      };
    }
    const request = requestSchema.parse(record.request);
    let result: unknown;
    try {
      result = await scope.run({ owner, deviceId: record.deviceId }, () =>
        this.agent.journal.run(
          owner,
          task,
          { id: "manual", name: `manual_native.${request.method}`, args: request.args },
          () => this.invoke(owner, request, task.id, context),
          !["list", "read", "export"].includes(request.method),
        ),
      );
    } catch (error) {
      const operations = await this.agent.journal.operations(owner, task.id);
      const uncertain = operations.filter(
        (op) => op.effect && ["running", "dispatching", "outcome_unknown"].includes(op.status),
      );
      if (!uncertain.length) throw error;
      const physicalPending = uncertain.some(
        (op) =>
          op.nativeEnvelope &&
          (op.receipt as { data?: { cleanupConfirmed?: boolean } } | undefined)?.data
            ?.cleanupConfirmed !== true,
      );
      if (physicalPending) await context.holdAdmission();
      return {
        status: "waiting_input",
        question:
          "The native result is uncertain. Its receipt is retained; inspect it before another operation.",
        state: { ...task.state, nativeCleanupPending: physicalPending },
      };
    }
    await this.agent.db.compareAndSwap(
      owner,
      "native-manual-operations",
      record.id,
      { binding: record.binding },
      { result },
    );
    const command = commandReceiptSchema.safeParse(result);
    if (command.success && command.data.status === "running") {
      await context.holdAdmission();
      return {
        status: "waiting_job",
        state: { ...task.state, waitingComputerCommandId: command.data.id },
      };
    }
    if (command.success && command.data.status !== "succeeded")
      return { status: "failed", error: command.data.stderr || "Computer operation failed" };
    const completion = await this.assess(owner, task);
    return {
      status: completion.status === "verified" ? "succeeded" : "waiting_input",
      completion,
      state: task.state,
    };
  }
  private async assess(owner: string, task: AgentTask): Promise<CompletionAssessment> {
    const current = await this.agent.getTask(owner, task.id);
    const operations = await this.agent.journal.operations(owner, task.id);
    const physical = operations.filter((op) => op.nativeEnvelope);
    const confirmed =
      Number(current.state.desiredRevision ?? 0) === 0 &&
      physical.length > 0 &&
      physical.every((op) => op.revision === 0 && op.status === "succeeded") &&
      !operations.some((op) => ["running", "dispatching", "outcome_unknown"].includes(op.status));
    return {
      status: confirmed ? "verified" : "unverified",
      checks: [
        {
          criterionId: "observed-result",
          passed: confirmed,
          evidenceIds: confirmed ? physical.map((op) => op.id) : [],
        },
      ],
      remaining: confirmed ? [] : ["The exact native operation has no complete current receipt"],
    };
  }
  private async visibleResult(owner: string, record: ManualRecord) {
    if (record.result === undefined || !this.computer.recovery) return record.result;
    for (const operation of await this.agent.journal.operations(owner, record.id)) {
      if (!operation.nativeEnvelope) continue;
      const receipt = operation.receipt as { data?: Record<string, unknown> } | undefined;
      const data = receipt?.data;
      if (typeof data?.artifactId !== "string") continue;
      if (
        await this.computer.recovery.registry.publicationConflict(owner, operation.executorId, data)
      )
        throw new AppError(
          "Origin artifact changed before publication was confirmed; inspect the current file",
          409,
        );
    }
    return record.result;
  }
  private async invoke(
    owner: string,
    request: ManualNativeRequest,
    taskId: string,
    context: TaskContext,
  ): Promise<unknown> {
    const computer = this.computer;
    const options = {
      signal: context.signal,
      idempotencyKey: `manual:${taskId}`,
      onDispatch: () => context.holdAdmission(),
    };
    switch (request.method) {
      case "start":
        return computer.start(owner);
      case "stop":
        return computer.stop(owner);
      case "execute":
        return computer.execute(owner, request.args, options);
      case "list":
        return computer.list(owner, request.args.path);
      case "read":
        return computer.read(owner, request.args.path);
      case "write":
        return computer.write(owner, request.args.path, request.args.text);
      case "mkdir":
        return computer.mkdir(owner, request.args.path);
      case "import":
        return computer.writeBytes(
          owner,
          request.args.path,
          await this.files.bytes(owner, request.args.fileId),
        );
      case "export": {
        const { name, bytes } = await computer.fileBytes(owner, request.args.path);
        return this.files.importAttachment(owner, name, bytes, `Computer: ${request.args.path}`);
      }
      case "transcribe":
      case "preview": {
        if (!computer.media) throw new AppError("Native media is unavailable", 503);
        return computer.media(owner, request.method, request.args, options);
      }
      case "capture":
      case "trash": {
        if (!computer.recovery) throw new AppError("Native recovery is unavailable", 503);
        return computer.recovery[request.method](
          owner,
          taskId,
          request.args.artifactId,
          request.args.expectedVersion,
          taskId,
        );
      }
      case "restore": {
        if (!computer.recovery) throw new AppError("Native recovery is unavailable", 503);
        return computer.recovery.restore(
          owner,
          request.args.versionId,
          request.args.expectedCurrentVersion,
          taskId,
        );
      }
    }
  }
  routes(auth: Auth) {
    const app = new Hono<{ Variables: { owner: string } }>();
    const routes = {
      "/start": "start",
      "/stop": "stop",
      "/commands": "execute",
      "/files/read": "read",
      "/files/write": "write",
      "/files/mkdir": "mkdir",
      "/files/import": "import",
      "/files/export": "export",
      "/transcribe": "transcribe",
      "/preview": "preview",
      "/file-versions/capture": "capture",
      "/file-versions/trash": "trash",
      "/file-versions/restore": "restore",
    } as const;
    const perform = async (
      c: Context<{ Variables: { owner: string } }>,
      method: string,
      raw: Record<string, unknown>,
    ) => {
      const token = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
      const device = await auth.devices.identity(token);
      const requestId =
        z.string().optional().parse(raw.requestId) ??
        c.req.header("Idempotency-Key") ??
        randomUUID();
      const accepted = await this.enqueue(c.get("owner"), device.deviceId, requestId, {
        method,
        args: raw,
      });
      if (accepted.result !== undefined) return c.json(accepted.result as object);
      void this.agent.worker
        .tick()
        .catch((error) => backgroundFailure("dispatch manual native task", error));
      const until = Date.now() + 10000;
      do {
        const record = await this.agent.db.get<ManualRecord>(
          c.get("owner"),
          "native-manual-operations",
          accepted.taskId,
        );
        if (record?.result !== undefined)
          return c.json((await this.visibleResult(c.get("owner"), record)) as object);
        const task = await this.agent.getTask(c.get("owner"), accepted.taskId);
        if (["failed", "cancelled", "waiting_input"].includes(task.status))
          return c.json(
            { taskId: task.id, status: task.status, error: task.error ?? task.question },
            409,
          );
        if (c.req.raw.signal.aborted) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < until);
      const task = await this.agent.getTask(c.get("owner"), accepted.taskId);
      return c.json({ taskId: task.id, status: task.status, pending: true, requestId }, 202);
    };
    for (const [path, method] of Object.entries(routes))
      app.post(path, async (c) =>
        perform(
          c,
          method,
          ["start", "stop"].includes(method)
            ? {}
            : z.record(z.string(), z.unknown()).parse(await c.req.json()),
        ),
      );
    app.get("/files", (c) => perform(c, "list", { path: c.req.query("path") ?? "/workspace" }));
    return app;
  }
}
