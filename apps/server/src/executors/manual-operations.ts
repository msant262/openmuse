import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type { ComputerCommand } from "../../../../packages/domain/src/computer.ts";
import type { CompletionAssessment } from "../../../../packages/domain/src/runtime.ts";
import type { Auth } from "../auth.ts";
import { computerCommandSchema, computerPathSchema, computerWriteSchema } from "../computer.ts";
import { type ComputerBackend, commandReceiptSchema, mediaSchema } from "../computer-contract.ts";
import { bindingHash } from "../conversation-inbox.ts";
import { RuntimePausedError } from "../engine/runtime-pause.ts";
import type { AgentService } from "../engine/service.ts";
import { TaskOutcomeUnknownError, TaskSupersededError } from "../engine/task-journal.ts";
import { LostLeaseError, type TaskContext } from "../engine/worker.ts";
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
    method: z.literal("transcribe_attachment"),
    args: z.object({
      fileId: z.string().min(1).max(256),
      language: z.enum(["auto", "pt", "en", "de"]).default("auto"),
      includeSubtitles: z.boolean().default(false),
      threadId: z
        .string()
        .min(1)
        .max(256)
        .regex(/^[\w.-]+$/)
        .optional(),
    }),
  }),
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
function pendingResult(value: unknown): value is {
  taskId: string;
  pending: true;
  status: "queued" | "running";
  stage?: "publishing";
  message?: string;
} {
  return Boolean(
    value &&
      typeof value === "object" &&
      "pending" in value &&
      (value as { pending?: unknown }).pending === true,
  );
}
function storedTranscription(receipt: ComputerCommand): ComputerCommand {
  if (receipt.kind !== "transcribe" || !receipt.result) return receipt;
  const { text: _boundedText, ...metadata } = receipt.result;
  return { ...receipt, stdout: "", result: metadata };
}
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
        ...(request.method === "transcribe_attachment"
          ? { originThreadId: request.args.threadId }
          : {}),
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
    return {
      taskId: task.id,
      result: await scope.run({ owner, deviceId }, () => this.visibleResult(owner, record)),
    };
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
      if (record.request.method === "transcribe_attachment" && receipt.status === "succeeded")
        return this.publishTranscription(owner, task, context, record, receipt);
      await this.agent.db.compareAndSwap(
        owner,
        "native-manual-operations",
        record.id,
        { binding: record.binding },
        { result: storedTranscription(receipt) },
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
        ...(receipt.kind === "transcribe" && receipt.result?.text
          ? { result: receipt.result.text }
          : {}),
        state: task.state,
      };
    }
    const request = requestSchema.parse(record.request);
    if (!(await this.computer.snapshot(owner)).connected)
      return {
        status: "waiting_resource",
        question: "Waiting for the Lenovo computer to reconnect; the saved request remains queued",
        nextRunAt: new Date(Date.now() + 15000).toISOString(),
      };
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
    if (
      command.success &&
      request.method === "transcribe_attachment" &&
      command.data.status === "succeeded"
    )
      return this.publishTranscription(owner, task, context, record, command.data);
    if (command.success && command.data.status !== "succeeded")
      return { status: "failed", error: command.data.stderr || "Computer operation failed" };
    const completion = await this.assess(owner, task);
    return {
      status: completion.status === "verified" ? "succeeded" : "waiting_input",
      completion,
      state: task.state,
    };
  }
  private async publishTranscription(
    owner: string,
    task: AgentTask,
    context: TaskContext,
    record: ManualRecord,
    receipt: ComputerCommand,
  ): Promise<Partial<AgentTask>> {
    if (!(await this.computer.snapshot(owner)).connected) {
      await context.holdAdmission();
      return {
        status: "waiting_job",
        nextRunAt: new Date(Date.now() + 15000).toISOString(),
        state: { ...task.state, waitingComputerCommandId: receipt.id },
      };
    }
    const publication = await scope.run({ owner, deviceId: record.deviceId }, () =>
      this.visibleResult(
        owner,
        { ...record, result: storedTranscription(receipt) },
        { task, context },
      ),
    );
    if (pendingResult(publication)) {
      await context.holdAdmission();
      return {
        status: "waiting_job",
        nextRunAt: new Date(Date.now() + 5000).toISOString(),
        state: { ...task.state, waitingComputerCommandId: receipt.id },
      };
    }
    if (
      publication &&
      typeof publication === "object" &&
      "status" in publication &&
      publication.status === "error"
    )
      return {
        status: "failed",
        error: String(
          "error" in publication ? publication.error : "Transcription publication failed",
        ),
      };
    const attachments =
      publication && typeof publication === "object" && "attachments" in publication
        ? (publication.attachments as { fileId?: string }[])
        : [];
    const completion = await this.assess(
      owner,
      task,
      [receipt.result?.textPath, receipt.result?.srtPath].filter(
        (path): path is string => typeof path === "string",
      ),
    );
    return {
      status: completion.status === "verified" ? "succeeded" : "waiting_input",
      completion,
      artifactIds: [
        ...new Set([
          ...(task.artifactIds ?? []),
          ...attachments.flatMap((file) => (file.fileId ? [file.fileId] : [])),
        ]),
      ],
      state: task.state,
    };
  }
  private async assess(
    owner: string,
    task: AgentTask,
    publishedTranscriptPaths: string[] = [],
  ): Promise<CompletionAssessment> {
    const current = await this.agent.getTask(owner, task.id);
    let operations = await this.agent.journal.operations(owner, task.id);
    const physical = operations.filter((op) => op.nativeEnvelope);
    const transcriptReadPath = (op: (typeof physical)[number]) => {
      const args = op.args;
      return !op.effect &&
        op.nativeEnvelope?.kind === "file" &&
        op.nativeEnvelope.inspection === true &&
        args &&
        typeof args === "object" &&
        "operation" in args &&
        args.operation === "read_binary" &&
        "path" in args &&
        typeof args.path === "string" &&
        publishedTranscriptPaths.includes(args.path)
        ? args.path
        : undefined;
    };
    const recoveredRead = (failed: (typeof physical)[number]) => {
      const path = transcriptReadPath(failed);
      return (
        path !== undefined &&
        physical.some(
          (op) =>
            op.status === "succeeded" &&
            op.revision === failed.revision &&
            op.executorId === failed.executorId &&
            op.createdAt >= failed.createdAt &&
            transcriptReadPath(op) === path,
        )
      );
    };
    // A transport exception leaves the SDK wrappers uncertain even when the exact
    // native child has a definitive failed receipt. Reconcile only a one-child,
    // read-only transcript chain, after that output has actually been published.
    // Unknown native receipts and compound/mutating operations remain untouched.
    if (Number(current.state.desiredRevision ?? 0) === 0) {
      for (const failed of physical) {
        if (failed.status !== "failed" || failed.revision !== 0 || !recoveredRead(failed)) continue;
        const primitive = operations.find((op) => op.id === failed.parentOperationId);
        const wrapper = operations.find((op) => op.id === primitive?.parentOperationId);
        if (
          !primitive ||
          !wrapper ||
          primitive.nativeEnvelope ||
          wrapper.nativeEnvelope ||
          primitive.effect ||
          wrapper.effect ||
          primitive.revision !== 0 ||
          wrapper.revision !== 0 ||
          wrapper.toolName !== "manual_native.read_transcript_output" ||
          primitive.toolName !== "primitive.manual_native.read_transcript_output" ||
          !wrapper.args ||
          typeof wrapper.args !== "object" ||
          !("path" in wrapper.args) ||
          wrapper.args.path !== transcriptReadPath(failed) ||
          operations.filter((op) => op.parentOperationId === primitive.id).length !== 1 ||
          operations.filter((op) => op.parentOperationId === wrapper.id).length !== 1
        )
          continue;
        for (const parent of [primitive, wrapper]) {
          if (!["dispatching", "running", "outcome_unknown"].includes(parent.status)) continue;
          await this.agent.journal.recordReceipt(
            owner,
            parent.id,
            { status: "failed", reconciledFrom: failed.id, inspection: true },
            "failed",
            (parent.sequence ?? 0) + 1,
          );
        }
      }
      operations = await this.agent.journal.operations(owner, task.id);
    }
    const confirmed =
      Number(current.state.desiredRevision ?? 0) === 0 &&
      physical.length > 0 &&
      physical.every(
        (op) =>
          op.revision === 0 &&
          (op.status === "succeeded" ||
            // A failed, side-effect-free output read can be superseded by a verified
            // read of that same published transcript. Never ignore failed mutations
            // or unknown outcomes, and retain the failed read in the audit journal.
            (op.status === "failed" && recoveredRead(op))),
      ) &&
      !operations.some((op) => ["running", "dispatching", "outcome_unknown"].includes(op.status));
    return {
      status: confirmed ? "verified" : "unverified",
      checks: [
        {
          criterionId: "observed-result",
          passed: confirmed,
          evidenceIds: confirmed
            ? physical.filter((op) => op.status === "succeeded").map((op) => op.id)
            : [],
        },
      ],
      remaining: confirmed ? [] : ["The exact native operation has no complete current receipt"],
    };
  }
  private async visibleResult(
    owner: string,
    record: ManualRecord,
    publication?: { task: AgentTask; context: TaskContext },
  ): Promise<unknown> {
    if (record.result === undefined) return undefined;
    if (this.computer.recovery) {
      for (const operation of await this.agent.journal.operations(owner, record.id)) {
        if (!operation.nativeEnvelope) continue;
        const receipt = operation.receipt as { data?: Record<string, unknown> } | undefined;
        const data = receipt?.data;
        if (typeof data?.artifactId !== "string") continue;
        if (
          await this.computer.recovery.registry.publicationConflict(
            owner,
            operation.executorId,
            data,
          )
        )
          throw new AppError(
            "Origin artifact changed before publication was confirmed; inspect the current file",
            409,
          );
      }
    }
    if (record.request.method === "export") {
      const result = record.result as { id?: unknown };
      if (typeof result.id === "string") return this.files.get(owner, result.id);
    }
    if (record.request.method !== "transcribe_attachment") return record.result;
    const saved = record.result as {
      status?: string;
      attachments?: { fileId?: string; name?: string }[];
    };
    if (saved.status === "error" || saved.attachments?.length) return record.result;
    const parsed = commandReceiptSchema.safeParse(record.result);
    if (!parsed.success || parsed.data.kind !== "transcribe") return record.result;
    let receipt = parsed.data;
    if (receipt.status === "running") {
      if (!this.computer.command) return { taskId: record.id, pending: true, status: "running" };
      try {
        receipt = await this.computer.command(owner, receipt.id);
      } catch (error) {
        if (error instanceof AppError && error.status === 503)
          return { taskId: record.id, pending: true, status: "running" };
        throw error;
      }
    }
    if (receipt.status === "running")
      return { taskId: record.id, pending: true, status: "running" };
    if (receipt.status !== "succeeded") return receipt;

    const fail = async (message: string) => {
      const result = { taskId: record.id, status: "error" as const, error: message };
      await this.agent.db.compareAndSwap(
        owner,
        "native-manual-operations",
        record.id,
        { binding: record.binding },
        { result },
      );
      return result;
    };
    if (!receipt.result?.textPath)
      return fail("Transcription finished without publishing its complete .txt output.");
    if (record.request.args.includeSubtitles && !receipt.result.srtPath)
      return fail("Transcription finished without the requested .srt output.");
    if (!publication)
      return {
        taskId: record.id,
        pending: true,
        status: "running",
        stage: "publishing",
        message:
          "The transcript is ready on the Lenovo; publication will resume when it reconnects.",
      };
    let completed: Awaited<ReturnType<typeof this.agent.media.completed>>;
    try {
      completed = await this.agent.media.completed(owner, this.computer, receipt, {
        readOutput: async (path, outputId) => {
          let output: { name: string; bytes: Uint8Array } | undefined;
          await this.agent.journal.run(
            owner,
            publication.task,
            {
              id: `transcript-read-${outputId}-${publication.task.state.appliedRevision ?? 0}-${publication.task.attempts}`,
              name: "manual_native.read_transcript_output",
              args: { commandId: receipt.id, outputId, path },
            },
            async () => {
              output = await this.computer.fileBytes(owner, path, {
                idempotencyKey: `media-output:${outputId}:attempt-${publication.task.attempts}`,
                signal: publication.context.signal,
              });
              return {
                path,
                name: output.name,
                size: output.bytes.length,
                sha256: createHash("sha256").update(output.bytes).digest("hex"),
              };
            },
            false,
          );
          if (!output) throw new AppError("Native transcript output needs a fresh read", 503);
          return output;
        },
        beforePublish: publication.context.guard,
      });
    } catch (error) {
      if (
        error instanceof RuntimePausedError ||
        error instanceof LostLeaseError ||
        error instanceof TaskSupersededError ||
        publication.context.signal.aborted
      )
        throw error;
      if (error instanceof TaskOutcomeUnknownError)
        return {
          taskId: record.id,
          pending: true,
          status: "running",
          stage: "publishing",
          message:
            "The transcript output read is awaiting reconciliation; it will resume without repeating transcription.",
        };
      if (
        (error instanceof AppError && error.status === 503) ||
        (error instanceof Error && ["ComputerBusyError", "ResourceBusyError"].includes(error.name))
      )
        return {
          taskId: record.id,
          pending: true,
          status: "running",
          stage: "publishing",
          message:
            "The transcript is ready on the Lenovo; publication will resume when it reconnects.",
        };
      return fail("The completed transcript could not be published to this account's files.");
    }
    const attachments = "attachments" in completed ? (completed.attachments ?? []) : [];
    if (!attachments.some((file) => file.name.toLowerCase().endsWith(".txt")))
      return fail("The complete transcript .txt attachment is unavailable.");
    if (
      record.request.args.includeSubtitles &&
      !attachments.some((file) => file.name.toLowerCase().endsWith(".srt"))
    )
      return fail("The requested subtitle .srt attachment is unavailable.");
    const safeCompleted =
      completed.kind === "transcribe" ? storedTranscription(completed) : completed;
    await this.agent.db.compareAndSwap(
      owner,
      "native-manual-operations",
      record.id,
      { binding: record.binding },
      { result: safeCompleted },
    );
    return safeCompleted;
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
      case "transcribe_attachment": {
        if (!computer.media) throw new AppError("Native transcription is unavailable", 503);
        const file = await this.files.get(owner, request.args.fileId);
        if (!/^(?:audio|video)\//.test(file.mimeType))
          throw new AppError("Choose an audio or video attachment", 422);
        const extension =
          file.name
            .split(".")
            .at(-1)
            ?.replace(/[^a-z0-9]/gi, "")
            .slice(0, 12) || "bin";
        const path = `/workspace/voice-${taskId}.${extension}`;
        await computer.writeBytes(owner, path, await this.files.bytes(owner, file.id));
        return computer.media(
          owner,
          "transcribe",
          {
            path,
            language: request.args.language,
            background: true,
            ...(request.args.includeSubtitles ? { srtPath: `/workspace/voice-${taskId}.srt` } : {}),
          },
          options,
        );
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
    app.get("/requests/:taskId", async (c) => {
      const token = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
      const device = await auth.devices.identity(token);
      const owner = c.get("owner");
      const record = await this.agent.db.get<ManualRecord>(
        owner,
        "native-manual-operations",
        c.req.param("taskId"),
      );
      if (!record || record.deviceId !== device.deviceId)
        throw new AppError("Computer request is unavailable for this device", 404);
      const result = await scope.run({ owner, deviceId: record.deviceId }, () =>
        this.visibleResult(owner, record),
      );
      if (pendingResult(result)) return c.json(result, 202);
      if (result !== undefined)
        return c.json(
          result && typeof result === "object" && "status" in result && result.status === "error"
            ? result
            : { taskId: record.id, result },
        );
      const task = await this.agent.getTask(owner, record.id);
      if (["failed", "cancelled", "waiting_input"].includes(task.status)) {
        if (record.request.method === "transcribe_attachment")
          return c.json({
            taskId: task.id,
            status: "error",
            error: task.error ?? task.question ?? "Native transcription failed.",
          });
        return c.json(
          {
            taskId: task.id,
            status: task.status,
            error:
              task.error ??
              task.question ??
              "Inspect the retained computer receipt before retrying",
            code: "COMPUTER_INSPECTION_REQUIRED",
          },
          409,
        );
      }
      return c.json(
        {
          taskId: task.id,
          status: task.status === "running" || task.status === "waiting_job" ? "running" : "queued",
          pending: true,
        },
        202,
      );
    });
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
      "/transcribe-attachment": "transcribe_attachment",
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
      if (accepted.result !== undefined)
        return c.json(accepted.result as object, pendingResult(accepted.result) ? 202 : 200);
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
        if (record?.result !== undefined) {
          const result = await scope.run({ owner: c.get("owner"), deviceId: record.deviceId }, () =>
            this.visibleResult(c.get("owner"), record),
          );
          return c.json(result as object, pendingResult(result) ? 202 : 200);
        }
        const task = await this.agent.getTask(c.get("owner"), accepted.taskId);
        if (["failed", "cancelled", "waiting_input"].includes(task.status)) {
          if (method === "transcribe_attachment")
            return c.json({
              taskId: task.id,
              status: "error",
              error: task.error ?? task.question ?? "Native transcription failed.",
            });
          return c.json(
            { taskId: task.id, status: task.status, error: task.error ?? task.question },
            409,
          );
        }
        if (c.req.raw.signal.aborted) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < until);
      const task = await this.agent.getTask(c.get("owner"), accepted.taskId);
      return c.json(
        {
          taskId: task.id,
          status: task.status === "running" || task.status === "waiting_job" ? "running" : "queued",
          pending: true,
          requestId,
        },
        202,
      );
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
