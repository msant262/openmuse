import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { Message } from "@ag-ui/core";
import { z } from "zod";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type { ComputerCommand } from "../../../../packages/domain/src/computer.ts";
import {
  type OperationStatus,
  operationIntentSchema,
  type ResourceLease,
} from "../../../../packages/domain/src/runtime.ts";
import { bindingHash } from "../conversation-inbox.ts";
import type { Store } from "../db.ts";
import { AppError, NativePreflightRejection } from "../errors.ts";
import type { Files } from "../files.ts";
import { ResourceBusyError } from "./resource-leases.ts";
import { RuntimePause, RuntimePausedError } from "./runtime-pause.ts";
import { completedMessages, publicJournalValue, publicToolArguments } from "./task-history.ts";
import { TaskValidityExpiredError } from "./task-timing.ts";
import { LostLeaseError } from "./worker.ts";

const journalOperationSchema = operationIntentSchema
  .extend({
    toolName: z.string().min(1).max(256),
    args: z.unknown(),
    effect: z.boolean(),
    runToken: z.string().min(1),
    resourceLeaseIds: z.array(z.string()),
    createdAt: z.iso.datetime(),
    receipt: z.unknown().optional(),
    sequence: z.number().int().nonnegative().optional(),
    toolCallId: z.string().optional(),
    resourceHoldTaskId: z.string().optional(),
    physicalOperationId: z.string().optional(),
    parentOperationId: z.string().optional(),
    targetOperationId: z.string().optional(),
    manualRequestId: z.string().optional(),
    nativeEnvelope: z.record(z.string(), z.unknown()).optional(),
    browserBinding: z.string().optional(),
    dispatchedAt: z.string().optional(),
    rejection: z.string().optional(),
  })
  .strict();
export type JournalOperation = z.infer<typeof journalOperationSchema>;
export type TaskCheckpoint = {
  id: string;
  taskId: string;
  appliedRevision: number;
  mailboxSeq: number;
  messages: Message[];
  pendingOperationIds: string[];
};
export class TaskSupersededError extends AppError {
  constructor() {
    super("A newer direction superseded this intention before dispatch", 409);
    this.name = "TaskSupersededError";
  }
}
export class TaskOutcomeUnknownError extends AppError {
  constructor(readonly operationIds: string[]) {
    super("A dispatched operation requires reconciliation before another effect", 409);
    this.name = "TaskOutcomeUnknownError";
  }
}
type Scope = {
  journal: TaskJournal;
  owner: string;
  operation: JournalOperation;
  task: AgentTask;
  primitive?: JournalOperation;
};
const dispatchScope = new AsyncLocalStorage<Scope>();
function primitiveOperationId(parentId: string, physicalTaskId: string) {
  const legacy = `primitive:${parentId}:${physicalTaskId}`;
  return legacy.length <= 256
    ? legacy
    : `primitive:${createHash("sha256")
        .update(JSON.stringify([parentId, physicalTaskId]))
        .digest("hex")}`;
}
/** Trusted task scope is propagated through nested/parallel async tool calls. */
export async function authorizeTaskEffect(resources?: ResourceLease[], physicalTaskId?: string) {
  const scope = dispatchScope.getStore();
  if (scope) {
    let operation = scope.operation;
    if (resources && physicalTaskId) {
      const id = primitiveOperationId(scope.operation.id, physicalTaskId);
      operation = await scope.journal.prepare(scope.owner, {
        ...scope.operation,
        id,
        toolCallId: undefined,
        toolName: `primitive.${scope.operation.toolName}`,
        parentOperationId: scope.operation.id,
        status: "queued",
        sequence: undefined,
        receipt: undefined,
        createdAt: new Date().toISOString(),
      });
      operation =
        (await scope.journal.bindResources(scope.owner, id, physicalTaskId, resources)) ??
        operation;
      scope.primitive = operation;
      // The parent SDK call is the durable intention; each physical primitive
      // gets its own final barrier, including compound upload/command tools.
      if (scope.operation.status === "queued") {
        const parent = await scope.journal.db.get<JournalOperation>(
          scope.owner,
          "task-operations",
          scope.operation.id,
        );
        if (parent?.status === "queued") {
          await scope.journal.bindResources(scope.owner, parent.id, physicalTaskId, resources);
          await scope.journal.authorizeDispatch(
            scope.owner,
            parent.id,
            parent.revision,
            parent.runToken,
            resources,
          );
        }
      }
    }
    await scope.journal.authorizeDispatch(
      scope.owner,
      operation.id,
      operation.revision,
      operation.runToken,
      resources,
    );
  }
}
export async function validateTaskEffect() {
  const scope = dispatchScope.getStore();
  if (scope)
    await scope.journal.authorizeDispatch(
      scope.owner,
      scope.operation.id,
      scope.operation.revision,
      scope.operation.runToken,
      undefined,
      true,
    );
}
export function taskOperationId() {
  return dispatchScope.getStore()?.operation.id;
}
export function currentTaskScope() {
  return dispatchScope.getStore();
}
const terminal = new Set<OperationStatus>([
  "succeeded",
  "failed",
  "rejected_not_dispatched",
  "superseded",
]);
export class TaskJournal {
  evidenceBefore?: (owner: string, task: AgentTask) => Promise<void>;
  constructor(readonly db: Store) {}
  async operations(owner: string, taskId: string) {
    return this.db.taskOperations<JournalOperation>(owner, taskId);
  }
  async requiredHistoryIds(owner: string, taskId: string) {
    return (await this.operations(owner, taskId))
      .filter(
        (op) =>
          !op.parentOperationId &&
          !op.nativeEnvelope &&
          op.effect &&
          ["dispatching", "running", "outcome_unknown", "succeeded"].includes(op.status),
      )
      .map((op) => op.toolCallId ?? op.id);
  }
  async reconcileFiles(owner: string, taskId: string, files: Files) {
    const ids: string[] = [];
    for (const op of await this.operations(owner, taskId)) {
      if (
        !/^(create_document|inspect_document|import_pdf|fill_pdf|export_computer_(pdf|file)|manual_native\.export)$/.test(
          op.toolName,
        ) ||
        !["dispatching", "outcome_unknown"].includes(op.status)
      )
        continue;
      const recovered = await files.reconcilePublications(owner, op.id);
      if (!recovered.length) continue;
      const operations = await this.operations(owner, taskId);
      const children = operations.filter((child) => child.parentOperationId === op.id);
      for (const child of children) {
        if (
          child.nativeEnvelope ||
          child.revision !== op.revision ||
          !["dispatching", "outcome_unknown"].includes(child.status)
        )
          continue;
        const descendants = operations.filter((item) => item.parentOperationId === child.id);
        const publication = recovered.find(
          (file) => child.id === primitiveOperationId(op.id, `file-publication:${file.id}`),
        );
        const read = descendants.length === 1 ? descendants[0] : undefined;
        const args = read?.args as { operation?: string; path?: string } | undefined;
        const readReceipt = read?.receipt as
          | { status?: string; data?: { sha256?: string } }
          | undefined;
        const publishedRead =
          read &&
          !read.effect &&
          read.toolName === "native.file" &&
          read.nativeEnvelope?.kind === "file" &&
          read.status === "succeeded" &&
          read.revision === op.revision &&
          args?.operation === "read_binary" &&
          readReceipt?.status === "succeeded" &&
          !operations.some((item) => item.parentOperationId === read.id);
        if (
          (publication && descendants.length === 0 && child.resourceLeaseIds.length === 0) ||
          publishedRead
        )
          await this.recordReceipt(
            owner,
            child.id,
            publication
              ? { fileId: publication.id, reconciled: true }
              : { nativeOperationId: read?.id, reconciled: true },
            "succeeded",
            (child.sequence ?? 0) + 1,
          );
      }
      // A verified local artifact cannot prove that an unrelated external effect
      // finished. Keep any other pending primitive visible and unreplayed.
      if (
        (await this.operations(owner, taskId)).some(
          (child) => child.parentOperationId === op.id && !terminal.has(child.status),
        )
      )
        continue;
      if (op.toolName === "create_document" && recovered.length === 1) {
        const id = createHash("sha256").update(op.id).digest("hex");
        const generation = await this.db.get<{
          id: string;
          binding: string;
          fileId?: string;
          [key: string]: unknown;
        }>(owner, "document-generations", id);
        if (generation)
          await this.db.put(owner, "document-generations", {
            ...generation,
            fileId: recovered[0].id,
            sha256: createHash("sha256")
              .update(await files.bytes(owner, recovered[0].id))
              .digest("hex"),
          });
      }
      const receipt =
        recovered.length === 1
          ? { id: recovered[0].id, name: recovered[0].name, reconciled: true }
          : {
              attachments: recovered.map((file) => ({ fileId: file.id, name: file.name })),
              reconciled: true,
            };
      await this.recordReceipt(owner, op.id, receipt, "succeeded", (op.sequence ?? 0) + 1);
      ids.push(...recovered.filter((file) => !file.internal).map((file) => file.id));
    }
    return ids;
  }
  async reconcileComputerReceipt(owner: string, taskId: string, receipt: ComputerCommand) {
    for (const op of await this.operations(owner, taskId)) {
      const prior = op.receipt as { id?: string; nativeOperationId?: string } | undefined;
      if (
        op.id !== receipt.id &&
        op.physicalOperationId !== receipt.id &&
        prior?.id !== receipt.id &&
        prior?.nativeOperationId !== receipt.id
      )
        continue;
      if (terminal.has(op.status)) continue;
      const status: OperationStatus =
        receipt.outcomeUnknown || receipt.status === "interrupted" || receipt.status === "timed_out"
          ? "outcome_unknown"
          : receipt.status;
      await this.recordReceipt(owner, op.id, receipt, status, (op.sequence ?? 0) + 1);
    }
  }
  private async reconcileConfirmedComputerStarts(owner: string, operations: JournalOperation[]) {
    const completed = new Set<string>();
    for (const start of operations) {
      const state = start.receipt as
        | { status?: string; enabled?: boolean; error?: unknown; outcomeUnknown?: boolean }
        | undefined;
      if (
        start.toolName !== "start_computer" ||
        start.status !== "running" ||
        !start.effect ||
        state?.status !== "running" ||
        state.enabled !== true ||
        state.error ||
        state.outcomeUnknown
      )
        continue;
      const children = operations.filter((op) => op.parentOperationId === start.id);
      const primitive = children[0];
      if (
        children.length !== 1 ||
        primitive?.toolName !== "primitive.start_computer" ||
        primitive.status !== "running" ||
        primitive.revision !== start.revision ||
        primitive.bindingHash !== start.bindingHash
      )
        continue;
      const deliveries = operations.filter((op) => op.parentOperationId === primitive.id);
      const delivery = deliveries[0];
      const receipt = delivery?.receipt as
        | { status?: string; data?: { started?: boolean } }
        | undefined;
      if (
        deliveries.length !== 1 ||
        delivery?.nativeEnvelope?.kind !== "session" ||
        (delivery.args as { operation?: string })?.operation !== "start" ||
        delivery.status !== "succeeded" ||
        delivery.revision !== start.revision ||
        receipt?.status !== "succeeded" ||
        receipt.data?.started !== true ||
        operations.some((op) => op.parentOperationId === delivery.id)
      )
        continue;
      // An independently confirmed native start already finished. Older host
      // receipts confused the running subject with the operation; do not replay it.
      for (const op of [primitive, start]) {
        await this.recordReceipt(
          owner,
          op.id,
          {
            status: "succeeded",
            computer: op.receipt,
            reconciled: true,
            nativeOperationId: delivery.id,
          },
          "succeeded",
          (op.sequence ?? 0) + 1,
        );
        completed.add(op.id);
      }
    }
    return completed;
  }
  async prepare(owner: string, intent: JournalOperation): Promise<JournalOperation> {
    const value = journalOperationSchema.parse({
      ...intent,
      args: publicToolArguments(intent.toolName, intent.args),
    });
    const existing =
      (await this.db.insertIfAbsent(owner, "task-operations", value)) ??
      (await this.db.get<JournalOperation>(owner, "task-operations", value.id));
    if (
      !existing ||
      existing.bindingHash !== value.bindingHash ||
      existing.taskId !== value.taskId ||
      existing.toolName !== value.toolName
    )
      throw new AppError("Operation ID is already bound to different arguments", 409);
    return existing;
  }
  /** Called by the audited primitive after it acquired exact physical handles. */
  async bindResources(
    owner: string,
    operationId: string,
    physicalTaskId: string,
    leases: ResourceLease[],
  ) {
    const op = await this.db.get<JournalOperation>(owner, "task-operations", operationId);
    if (!op) throw new AppError("Operation authority is missing", 409);
    for (const lease of leases) {
      const saved = await this.db.get<ResourceLease & { owner: string; taskId: string }>(
        "__runtime__",
        "resource-leases",
        lease.id,
      );
      if (
        !saved ||
        saved.owner !== owner ||
        saved.taskId !== physicalTaskId ||
        saved.fence !== lease.fence
      )
        throw new ResourceBusyError([]);
    }
    if (op.status !== "queued") return op;
    const saved = await this.db.compareAndSwap<JournalOperation>(
      owner,
      "task-operations",
      operationId,
      { status: "queued", bindingHash: op.bindingHash },
      {
        resourceHoldTaskId: physicalTaskId,
        physicalOperationId: physicalTaskId,
        resourceLeaseIds: leases.map((lease) => lease.id),
        resourceFence: Math.max(0, ...leases.map((lease) => lease.fence)),
      },
    );
    if (!saved) throw new TaskSupersededError();
    return saved;
  }
  async authorizeDispatch(
    owner: string,
    operationId: string,
    expectedRevision: number,
    runToken: string,
    resources?: ResourceLease[],
    validateOnly = false,
  ): Promise<JournalOperation> {
    const saved = await this.db.get<JournalOperation>(owner, "task-operations", operationId);
    if (!saved) throw new AppError("Operation authority is missing", 409);
    if (saved.status === "superseded") throw new TaskSupersededError();
    if (saved.status === "rejected_not_dispatched" && saved.rejection === "expired")
      throw new TaskValidityExpiredError();
    if (
      saved.effect &&
      ["queued", "dispatching", "running"].includes(saved.status) &&
      this.evidenceBefore
    ) {
      const task = await this.db.get<AgentTask>(owner, "tasks", saved.taskId);
      if (!task) throw new LostLeaseError();
      await this.evidenceBefore(owner, task);
    }
    const handles =
      resources ?? (await this.db.resourceLeasesForTask(saved.resourceHoldTaskId ?? saved.taskId));
    const result = await this.db.authorizeTaskOperation<JournalOperation>(
      owner,
      operationId,
      expectedRevision,
      runToken,
      handles,
      validateOnly || ["dispatching", "running"].includes(saved.status),
    );
    if (result.code === "paused")
      throw new RuntimePausedError(await new RuntimePause(this.db).get(owner));
    if (result.code === "superseded") throw new TaskSupersededError();
    if (result.code === "expired") throw new TaskValidityExpiredError();
    if (result.code === "resource_lost") throw new ResourceBusyError([]);
    if (result.code === "lease_lost" || !result.operation) throw new LostLeaseError();
    if (
      result.code === "existing" &&
      !["dispatching", "running", "succeeded", "failed"].includes(result.operation.status)
    )
      throw new TaskOutcomeUnknownError([operationId]);
    return result.operation;
  }
  async recordReceipt(
    owner: string,
    operationId: string,
    receipt: unknown,
    status: OperationStatus = "succeeded",
    sequence = 1,
  ): Promise<JournalOperation> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const op = await this.db.get<JournalOperation>(owner, "task-operations", operationId);
      if (!op) throw new AppError("Operation authority is missing", 409);
      if ((op.sequence ?? 0) >= sequence || (terminal.has(op.status) && op.status !== status))
        return op;
      const saved = await this.db.compareAndSwap<JournalOperation>(
        owner,
        "task-operations",
        operationId,
        { status: op.status, ...(op.sequence !== undefined ? { sequence: op.sequence } : {}) },
        { status, sequence, receipt: publicJournalValue(receipt) },
      );
      if (saved) return saved;
    }
    throw new AppError("Operation receipt changed concurrently", 409);
  }
  async checkpoint(
    owner: string,
    taskId: string,
    runToken: string,
    messages: Message[],
  ): Promise<TaskCheckpoint> {
    const task = await this.db.get<AgentTask>(owner, "tasks", taskId);
    if (!task || task.leaseId !== runToken || task.status !== "running") throw new LostLeaseError();
    const checkpoint: TaskCheckpoint = {
      id: taskId,
      taskId,
      appliedRevision: Number(task.state.appliedRevision ?? 0),
      mailboxSeq: Number(task.state.appliedMailboxSeq ?? 0),
      messages: completedMessages(messages),
      pendingOperationIds: (await this.operations(owner, taskId))
        .filter((op) => !terminal.has(op.status))
        .map((op) => op.id),
    };
    const result = await this.db.durableMutation(
      owner,
      `task-checkpoint:${taskId}:${randomUUID()}`,
      bindingHash(checkpoint),
      [
        {
          kind: "tasks",
          id: taskId,
          mode: "merge",
          expected: { leaseId: runToken, status: "running", state: task.state },
          value: { state: { ...task.state, journalCheckpointId: taskId } },
        },
        {
          kind: "task-checkpoints",
          id: taskId,
          mode: (await this.db.get(owner, "task-checkpoints", taskId)) ? "replace" : "insert",
          value: checkpoint,
        },
      ],
    );
    if (result.status === "revision_conflict") throw new TaskSupersededError();
    return checkpoint;
  }
  async history(
    owner: string,
    taskId: string,
    operations?: JournalOperation[],
  ): Promise<Message[]> {
    const checkpoint = await this.db.get<TaskCheckpoint>(owner, "task-checkpoints", taskId);
    const messages = checkpoint ? completedMessages(checkpoint.messages) : [];
    const recorded = new Set(messages.filter((m) => m.role === "tool").map((m) => m.toolCallId));
    for (const op of operations ?? (await this.operations(owner, taskId))) {
      if (
        op.parentOperationId ||
        op.nativeEnvelope ||
        recorded.has(op.id) ||
        (op.toolCallId && recorded.has(op.toolCallId)) ||
        (op.receipt === undefined && op.status === "queued")
      )
        continue;
      const id = op.toolCallId ?? op.id;
      messages.push(
        {
          id: `call:${op.id}`,
          role: "assistant",
          toolCalls: [
            {
              id,
              type: "function",
              function: { name: op.toolName, arguments: JSON.stringify(op.args) },
            },
          ],
        },
        {
          id: `receipt:${op.id}`,
          role: "tool",
          toolCallId: id,
          content: JSON.stringify(
            op.receipt ?? {
              outcomeUnknown: true,
              operationId: op.id,
              status: op.status,
              reason: "Reconcile this intention; do not resubmit it",
            },
          ),
        },
      );
    }
    return completedMessages(messages);
  }
  async run(
    owner: string,
    task: AgentTask,
    call: { id: string; toolCallId?: string; name: string; args: unknown },
    execute: () => Promise<unknown>,
    effect: boolean,
  ): Promise<unknown> {
    if (!task.leaseId) throw new LostLeaseError();
    const browserBinding =
      call.name === "browser_act"
        ? await this.browserBinding(owner, task.id, call.args)
        : undefined;
    const priorBrowser = browserBinding
      ? (await this.operations(owner, task.id)).find(
          (op) =>
            op.toolName === "browser_act" &&
            op.revision === Number(task.state.appliedRevision ?? 0) &&
            op.browserBinding === browserBinding,
        )
      : undefined;
    if (priorBrowser?.status === "succeeded") return priorBrowser.receipt;
    if (priorBrowser && ["dispatching", "running", "outcome_unknown"].includes(priorBrowser.status))
      throw new TaskOutcomeUnknownError([priorBrowser.id]);
    const intent: JournalOperation = {
      id: `tool:${task.id}:${call.id}`,
      taskId: task.id,
      revision: Number(task.state.appliedRevision ?? 0),
      bindingHash: bindingHash({ name: call.name, args: call.args }),
      executorId: "vps",
      executorEpoch: 1,
      resourceFence: 0,
      status: "queued",
      toolName: call.name,
      toolCallId: call.toolCallId ?? call.id,
      args: call.args,
      effect,
      ...(browserBinding ? { browserBinding } : {}),
      runToken: task.leaseId,
      resourceLeaseIds: [],
      createdAt: new Date().toISOString(),
    };
    // A provider replay can retain its concrete tool call ID after a transport
    // restart. Argument equality without that identity never merges intentions.
    const replay = call.toolCallId
      ? (await this.operations(owner, task.id)).find(
          (entry) =>
            !entry.parentOperationId &&
            entry.toolCallId === call.toolCallId &&
            entry.revision === intent.revision &&
            entry.bindingHash === intent.bindingHash &&
            entry.toolName === intent.toolName,
        )
      : undefined;
    if (replay && terminal.has(replay.status))
      return replay.receipt ?? { skipped: true, status: replay.status };
    if (replay && replay.status !== "queued") throw new TaskOutcomeUnknownError([replay.id]);
    const op = await this.prepare(owner, intent);
    if (terminal.has(op.status)) return op.receipt ?? { skipped: true, status: op.status };
    if (op.status !== "queued") throw new TaskOutcomeUnknownError([op.id]);
    if (effect) {
      const operations = await this.operations(owner, task.id);
      const confirmedStarts = await this.reconcileConfirmedComputerStarts(owner, operations);
      const pending = operations.filter(
        (other) =>
          other.id !== op.id &&
          !confirmedStarts.has(other.id) &&
          other.effect &&
          ["dispatching", "running", "outcome_unknown"].includes(other.status),
      );
      if (pending.length) throw new TaskOutcomeUnknownError(pending.map((other) => other.id));
    }
    return dispatchScope.run({ journal: this, owner, operation: op, task }, async () => {
      try {
        const result = await execute();
        const data = result as
          | {
              error?: unknown;
              code?: string;
              paused?: boolean;
              outcomeUnknown?: boolean;
              status?: string;
              skipped?: boolean;
              dispatched?: boolean;
            }
          | undefined;
        // A read receipt describes its subject (for example a running computer),
        // while an effect receipt can describe the dispatched operation itself.
        const effectStatus = effect ? data?.status : undefined;
        const current =
          effect && data?.error
            ? await this.db.get<JournalOperation>(owner, "task-operations", op.id)
            : undefined;
        const unknownError = Boolean(
          data?.error &&
            effectStatus !== "failed" &&
            !data.skipped &&
            !data.paused &&
            data.dispatched !== false &&
            current &&
            ["dispatching", "running"].includes(current.status) &&
            ![
              "BROWSER_CONTROLLED",
              "STALE_SNAPSHOT",
              "INVALID_REFERENCE",
              "PAYMENT_APPROVAL_REQUIRED",
            ].includes(data.code ?? ""),
        );
        const status: OperationStatus =
          (effect && data?.outcomeUnknown) ||
          effectStatus === "outcome_unknown" ||
          unknownError ||
          (["browser_act", "browser_back", "browser_dialog"].includes(call.name) &&
            data?.error &&
            !data.skipped &&
            !data.paused &&
            ![
              "BROWSER_CONTROLLED",
              "STALE_SNAPSHOT",
              "INVALID_REFERENCE",
              "PAYMENT_APPROVAL_REQUIRED",
            ].includes(data.code ?? ""))
            ? "outcome_unknown"
            : effectStatus === "running"
              ? "running"
              : data?.skipped || effectStatus === "rejected_not_dispatched"
                ? "rejected_not_dispatched"
                : effectStatus === "superseded"
                  ? "superseded"
                  : data?.error || effectStatus === "failed"
                    ? "failed"
                    : "succeeded";
        await this.recordReceipt(owner, op.id, result, status);
        for (const primitive of await this.operations(owner, task.id))
          if (
            primitive.parentOperationId === op.id &&
            !primitive.nativeEnvelope &&
            ["queued", "dispatching"].includes(primitive.status)
          )
            await this.recordReceipt(
              owner,
              primitive.id,
              result,
              status,
              (primitive.sequence ?? 0) + 1,
            );
        if (status === "outcome_unknown") throw new TaskOutcomeUnknownError([op.id]);
        return result;
      } catch (error) {
        if (error instanceof TaskOutcomeUnknownError && error.operationIds.includes(op.id))
          throw error;
        if (error instanceof NativePreflightRejection && error.parentOperationId === op.id) {
          const operations = await this.operations(owner, task.id);
          const primitive = operations.find((item) => item.id === error.primitiveOperationId);
          if (
            primitive?.parentOperationId === op.id &&
            !primitive.nativeEnvelope &&
            ["queued", "dispatching"].includes(primitive.status) &&
            !operations.some((item) => item.parentOperationId === primitive.id)
          ) {
            const receipt = { error: error.message, dispatched: false, code: error.code };
            await this.recordReceipt(
              owner,
              primitive.id,
              receipt,
              "rejected_not_dispatched",
              (primitive.sequence ?? 0) + 1,
            );
            const siblings = operations.filter(
              (item) => item.parentOperationId === op.id && item.id !== primitive.id,
            );
            for (let index = 0; index < siblings.length; index++) {
              const sibling = siblings[index];
              const children = operations.filter((item) => item.parentOperationId === sibling.id);
              const child = children[0];
              if (
                sibling.nativeEnvelope ||
                sibling.status !== "dispatching" ||
                children.length !== 1 ||
                child?.nativeEnvelope?.kind !== "file" ||
                child.status !== "succeeded" ||
                child.taskId !== sibling.taskId ||
                child.revision !== sibling.revision ||
                operations.some((item) => item.parentOperationId === child.id)
              )
                continue;
              const args = child.args as { operation?: string };
              const delivered = child.receipt as {
                status?: string;
                data?: Record<string, unknown>;
              };
              if (
                !["write", "write_binary"].includes(args.operation ?? "") ||
                delivered.status !== "succeeded"
              )
                continue;
              const data = delivered.data;
              if (!data || typeof data.artifactId !== "string") continue;
              const artifact = await this.db.get<Record<string, unknown>>(
                owner,
                "native-artifacts",
                data.artifactId,
              );
              if (
                !artifact?.published ||
                artifact.executorId !== child.executorId ||
                artifact.version !== data.version ||
                artifact.sha256 !== data.sha256 ||
                (artifact.generation ?? 1) !== (data.generation ?? 1) ||
                artifact.versionId !== data.versionId
              )
                continue;
              siblings[index] = await this.recordReceipt(
                owner,
                sibling.id,
                { nativeOperationId: child.id, artifactId: data.artifactId, published: true },
                "succeeded",
                (sibling.sequence ?? 0) + 1,
              );
            }
            if (siblings.every((item) => terminal.has(item.status))) {
              // A compound tool may already have uploaded an attachment. Preserve
              // that successful effect instead of calling the whole tool undispatched.
              const status = siblings.some((item) => ["succeeded", "failed"].includes(item.status))
                ? "failed"
                : "rejected_not_dispatched";
              await this.recordReceipt(
                owner,
                op.id,
                status === "failed" ? { ...receipt, dispatched: true, partial: true } : receipt,
                status,
                (op.sequence ?? 0) + 1,
              );
              throw error;
            }
          }
        }
        const current = await this.db.get<JournalOperation>(owner, "task-operations", op.id);
        if (current?.status === "queued")
          await this.recordReceipt(
            owner,
            op.id,
            { error: error instanceof Error ? error.message : "Not dispatched", dispatched: false },
            "rejected_not_dispatched",
          );
        else if (current && !terminal.has(current.status))
          await this.recordReceipt(
            owner,
            op.id,
            effect
              ? { outcomeUnknown: true }
              : { error: error instanceof Error ? error.message : String(error), dispatched: true },
            effect ? "outcome_unknown" : "failed",
          );
        throw error;
      }
    });
  }
  private async browserBinding(owner: string, taskId: string, raw: unknown) {
    if (!raw || typeof raw !== "object") return undefined;
    const args = raw as { operationId?: string; act?: Record<string, unknown> };
    if (!args.act) return undefined;
    const { snapshotId, element, ...action } = args.act;
    const ops = await this.operations(owner, taskId);
    for (const op of ops.toReversed()) {
      const receipt = op.receipt as
        | {
            snapshotId?: unknown;
            url?: string;
            elements?: { number: number; [key: string]: unknown }[];
          }
        | undefined;
      if (op.status !== "succeeded" || !receipt || receipt.snapshotId !== snapshotId) continue;
      const target = receipt.elements?.find((entry) => entry.number === element);
      if (!target) continue;
      const { number: _number, ...semantic } = target;
      // Resolve the original durable intention through owned control metadata.
      // A new explicit operationId denotes a distinct intended repetition.
      return bindingHash({
        intent: args.operationId ?? "legacy-control",
        url: receipt.url,
        target: semantic,
        action,
      });
    }
    return undefined;
  }
}
