import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type {
  ExecutorCapability,
  OperationStatus,
  ResourceLease,
} from "../../../../packages/domain/src/runtime.ts";
import { workspacePath } from "../computer.ts";
import { bindingHash } from "../conversation-inbox.ts";
import { AppError } from "../errors.ts";
import { ResourceBusyError } from "./resource-leases.ts";
import { RuntimePause } from "./runtime-pause.ts";
import { currentTaskScope, type JournalOperation, type TaskJournal } from "./task-journal.ts";

// Structural M6 seam: the standalone M4 base does not import an absent registry.
export type NativeDispatchContext =
  | {
      kind: "task";
      taskId: string;
      desiredRevision: number;
      runToken: string;
      resourceLeaseIds: string[];
      resourceBudget?: { memoryBytes: number; heavy: boolean };
    }
  | { kind: "manual"; requestId: string; deviceId: string; owner: string };
type NativeKind =
  | "command"
  | "file"
  | "file-version"
  | "session"
  | "cancel"
  | "desktop"
  | "browser"
  | "media";
export type NativeRequest = {
  id: string;
  executorId: string;
  kind: NativeKind;
  capability: ExecutorCapability;
  capabilityVersion?: number;
  args: Record<string, unknown>;
  inspection?: boolean;
};
export type NativeOperation = Omit<NativeRequest, "inspection" | "capabilityVersion"> & {
  inspection: boolean;
  capabilityVersion: number;
  taskId: string;
  revision: number;
  bindingHash: string;
  executorEpoch: number;
  resourceFence: number;
  resourceKey: string;
  expiresAt: string;
  createdAt: string;
  resourceBudget?: { memoryBytes: number; heavy: boolean };
};
export type NativeReceipt = {
  status:
    | "running"
    | "succeeded"
    | "failed"
    | "rejected_not_dispatched"
    | "superseded"
    | "outcome_unknown";
  data?: Record<string, unknown>;
  message?: string;
  progress?: { completedBytes: number; totalBytes: number };
};
type ManualRequest = {
  id: string;
  owner: string;
  deviceId: string;
  bindingHash: string;
  context: Extract<NativeDispatchContext, { kind: "task" }>;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Returns only server-owned ALS provenance, never model-selected task/host/budget. */
export async function currentExecutorContext(
  owner: string,
  _physicalRequestId: string,
  resourceBudget?: { memoryBytes: number; heavy: boolean },
  resourceScope?: { owner: string; resourceHoldTaskId: string; leases: ResourceLease[] },
): Promise<NativeDispatchContext | undefined> {
  const scope = currentTaskScope();
  if (!scope || scope.owner !== owner) return undefined;
  if (resourceScope) {
    if (resourceScope.owner !== owner) return undefined;
    await scope.journal.bindResources(
      owner,
      (scope.primitive ?? scope.operation).id,
      resourceScope.resourceHoldTaskId,
      resourceScope.leases,
    );
  }
  const op = await scope.journal.db.get<JournalOperation>(
    owner,
    "task-operations",
    (scope.primitive ?? scope.operation).id,
  );
  if (!op) return undefined;
  return {
    kind: "task",
    taskId: op.taskId,
    desiredRevision: op.revision,
    runToken: op.runToken,
    resourceLeaseIds: op.resourceLeaseIds,
    ...(resourceBudget ? { resourceBudget } : {}),
  };
}

export class TaskExecutorAuthority {
  constructor(
    private readonly journal: TaskJournal,
    private readonly options: {
      executor: (owner: string, executorId: string) => { hostId: string };
      wake?: (owner: string, taskId: string) => Promise<void>;
    },
  ) {}
  /** Authenticated API composition creates this record before enqueue. It uses
   * existing M3 task admission/resources; this adapter never creates work slots. */
  async registerManualRequest(
    owner: string,
    requestId: string,
    deviceId: string,
    request: NativeRequest,
    context: Extract<NativeDispatchContext, { kind: "task" }>,
  ) {
    await this.device(owner, deviceId);
    const value: ManualRequest = {
      id: requestId,
      owner,
      deviceId,
      bindingHash: bindingHash(request),
      context,
    };
    const record =
      (await this.journal.db.insertIfAbsent(owner, "manual-executor-requests", value)) ??
      (await this.journal.db.get<ManualRequest>(owner, "manual-executor-requests", requestId));
    if (
      !record ||
      record.owner !== owner ||
      record.deviceId !== deviceId ||
      record.bindingHash !== value.bindingHash ||
      bindingHash(record.context) !== bindingHash(context)
    )
      throw new AppError("Manual operation provenance changed", 409);
    return { kind: "manual" as const, owner, requestId, deviceId };
  }
  private async device(owner: string, id: string) {
    const device = await this.journal.db.get<{ owner: string; revokedAt: number | null }>(
      "system",
      "device-sessions",
      id,
    );
    if (!device || device.owner !== owner || device.revokedAt !== null)
      throw new AppError("Manual operation requires a valid authenticated device", 403);
  }
  private async trusted(
    owner: string,
    request: NativeRequest,
    context: NativeDispatchContext | undefined,
  ) {
    if (!context) throw new AppError("Native dispatch authority requires trusted provenance", 503);
    if (context.kind === "task") return context;
    if (context.owner !== owner) throw new AppError("Manual operation owner changed", 403);
    await this.device(owner, context.deviceId);
    const record = await this.journal.db.get<ManualRequest>(
      owner,
      "manual-executor-requests",
      context.requestId,
    );
    if (
      !record ||
      record.owner !== owner ||
      record.deviceId !== context.deviceId ||
      record.bindingHash !== bindingHash(request)
    )
      throw new AppError("Manual request authority is missing or has another binding", 403);
    return record.context;
  }
  async authorize(
    owner: string,
    request: NativeRequest,
    executorEpoch: number,
    context: NativeDispatchContext,
  ): Promise<NativeOperation> {
    const trusted = await this.trusted(owner, request, context);
    const registration = this.options.executor(owner, request.executorId);
    const existing = await this.journal.db.get<JournalOperation>(
      owner,
      "task-operations",
      request.id,
    );
    const digest = bindingHash({
      request: {
        ...request,
        capabilityVersion: request.capabilityVersion ?? 1,
        inspection: request.inspection ?? false,
      },
      executorEpoch,
    });
    if (existing) {
      if (
        existing.bindingHash !== digest ||
        existing.taskId !== trusted.taskId ||
        existing.revision !== trusted.desiredRevision ||
        !existing.nativeEnvelope
      )
        throw new AppError("Native intention is already bound to another request", 409);
      return {
        ...existing.nativeEnvelope,
        ...request,
        capabilityVersion: request.capabilityVersion ?? 1,
        inspection: request.inspection ?? false,
      } as NativeOperation;
    }
    if (request.kind === "cancel")
      return this.containment(
        owner,
        request,
        executorEpoch,
        context,
        trusted,
        digest,
        registration.hostId,
      );
    const task = await this.journal.db.get<AgentTask>(owner, "tasks", trusted.taskId);
    if (
      task?.status !== "running" ||
      task.leaseId !== trusted.runToken ||
      Number(task.state.appliedRevision ?? 0) !== trusted.desiredRevision ||
      Number(task.state.desiredRevision ?? 0) !== trusted.desiredRevision
    )
      throw new AppError("Native task provenance is no longer current", 409);
    const handles = await Promise.all(
      trusted.resourceLeaseIds.map((id) =>
        this.journal.db.get<
          ResourceLease & { owner: string; taskId: string; request: { key: string; mode: string } }
        >("__runtime__", "resource-leases", id),
      ),
    );
    if (!handles.length || handles.some((handle) => !handle || handle.owner !== owner))
      throw new ResourceBusyError([]);
    const leases = handles.filter((handle): handle is NonNullable<typeof handle> =>
      Boolean(handle),
    );
    const scope = currentTaskScope();
    const parent =
      scope?.owner === owner
        ? await this.journal.db.get<JournalOperation>(
            owner,
            "task-operations",
            (scope.primitive ?? scope.operation).id,
          )
        : (await this.journal.operations(owner, trusted.taskId)).find(
            (op) =>
              !op.nativeEnvelope &&
              op.runToken === trusted.runToken &&
              op.revision === trusted.desiredRevision &&
              op.resourceLeaseIds.length === leases.length &&
              leases.every((lease) => op.resourceLeaseIds.includes(lease.id)),
          );
    const holdTaskId = parent?.resourceHoldTaskId ?? trusted.taskId;
    if (leases.some((lease) => lease.taskId !== holdTaskId)) throw new ResourceBusyError([]);
    const inspection =
      request.kind === "file" &&
      ["list", "read", "read_binary", "stat"].includes(String(request.args.operation));
    if (Boolean(request.inspection) !== inspection)
      throw new AppError("Native inspection does not match concrete operation", 422);
    let resourceKey = `system-admin:${registration.hostId}`;
    const exclusive = !inspection;
    if (request.kind === "command" || request.kind === "media")
      resourceKey = `cpu-heavy:${registration.hostId}`;
    else if (request.kind === "file" || request.kind === "file-version") {
      let path = request.args.path;
      if (typeof path !== "string") {
        const reference =
          typeof request.args.artifactId === "string"
            ? await this.journal.db.get<{ path: string; executorId: string }>(
                owner,
                "native-artifacts",
                request.args.artifactId,
              )
            : typeof request.args.versionId === "string"
              ? await this.journal.db.get<{ path: string; executorId: string }>(
                  owner,
                  "file-versions",
                  request.args.versionId,
                )
              : null;
        if (reference?.executorId !== request.executorId)
          throw new AppError("Native file reference belongs to another executor", 403);
        path = reference?.path;
      }
      if (typeof path !== "string")
        throw new AppError("Native file authority requires a server-owned workspace path", 409);
      resourceKey = `file:${registration.hostId}:${hash(owner).slice(0, 20)}:${hash(workspacePath(path)).slice(0, 32)}`;
    }
    const resource = leases.find(
      (lease) =>
        lease.request.key === resourceKey && (!exclusive || lease.request.mode === "exclusive"),
    );
    if (!resource) throw new ResourceBusyError([]);
    if (request.kind === "command" || request.kind === "media") {
      if (!leases.some((lease) => lease.request.key === `system-admin:${registration.hostId}`))
        throw new ResourceBusyError([]);
      z.object({ memoryBytes: z.number().int().positive(), heavy: z.boolean() }).parse(
        trusted.resourceBudget,
      );
    }
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(
      Math.min(
        Date.now() + 30 * 60_000,
        Date.parse(task.timing?.validUntil ?? "") || Number.POSITIVE_INFINITY,
      ),
    ).toISOString();
    const envelope: NativeOperation = {
      ...request,
      capabilityVersion: request.capabilityVersion ?? 1,
      inspection,
      taskId: task.id,
      revision: trusted.desiredRevision,
      bindingHash: digest,
      executorEpoch,
      resourceFence: resource.fence,
      resourceKey,
      createdAt,
      expiresAt,
      ...(trusted.resourceBudget ? { resourceBudget: trusted.resourceBudget } : {}),
    };
    const { args: _args, ...metadata } = envelope;
    await this.journal.prepare(owner, {
      id: request.id,
      taskId: task.id,
      revision: trusted.desiredRevision,
      bindingHash: digest,
      executorId: request.executorId,
      executorEpoch,
      resourceFence: resource.fence,
      status: "queued",
      toolName: `native.${request.kind}`,
      args: request.args,
      effect: !inspection,
      runToken: trusted.runToken,
      resourceLeaseIds: leases.map((lease) => lease.id),
      resourceHoldTaskId: holdTaskId,
      physicalOperationId: request.id,
      ...(parent ? { parentOperationId: parent.id } : {}),
      ...(context.kind === "manual" ? { manualRequestId: context.requestId } : {}),
      nativeEnvelope: metadata,
      createdAt,
    });
    return envelope;
  }
  private async containment(
    owner: string,
    request: NativeRequest,
    executorEpoch: number,
    context: NativeDispatchContext,
    trusted: Extract<NativeDispatchContext, { kind: "task" }>,
    digest: string,
    hostId: string,
  ): Promise<NativeOperation> {
    if (
      typeof request.args.operationId !== "string" ||
      Object.keys(request.args).some((key) => key !== "operationId") ||
      request.capability !== "command" ||
      request.inspection
    )
      throw new AppError("Containment requires a concrete owned command", 422);
    const target = await this.journal.db.get<JournalOperation>(
      owner,
      "task-operations",
      request.args.operationId,
    );
    if (
      !target?.nativeEnvelope ||
      target.executorId !== request.executorId ||
      target.taskId !== trusted.taskId ||
      target.runToken !== trusted.runToken ||
      !["dispatching", "running", "outcome_unknown"].includes(target.status)
    )
      throw new AppError("Containment target authority is missing or terminal", 409);
    const handles = await Promise.all(
      target.resourceLeaseIds.map((id) =>
        this.journal.db.get<
          ResourceLease & { owner: string; taskId: string; request: { key: string; mode: string } }
        >("__runtime__", "resource-leases", id),
      ),
    );
    if (
      handles.some(
        (lease) => !lease || lease.owner !== owner || lease.taskId !== target.resourceHoldTaskId,
      )
    )
      throw new ResourceBusyError([]);
    const resource = handles.find(
      (lease) => lease?.request.key === `cpu-heavy:${hostId}` && lease.request.mode === "exclusive",
    );
    if (!resource) throw new ResourceBusyError([]);
    const createdAt = new Date().toISOString();
    const envelope: NativeOperation = {
      ...request,
      capabilityVersion: request.capabilityVersion ?? 1,
      inspection: false,
      taskId: target.taskId,
      revision: target.revision,
      bindingHash: digest,
      executorEpoch,
      resourceFence: resource.fence,
      resourceKey: resource.request.key,
      createdAt,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
    const { args: _args, ...metadata } = envelope;
    await this.journal.prepare(owner, {
      id: request.id,
      taskId: target.taskId,
      revision: target.revision,
      bindingHash: digest,
      executorId: request.executorId,
      executorEpoch,
      resourceFence: resource.fence,
      status: "queued",
      toolName: "native.cancel",
      args: request.args,
      effect: false,
      runToken: target.runToken,
      resourceLeaseIds: target.resourceLeaseIds,
      resourceHoldTaskId: target.resourceHoldTaskId,
      targetOperationId: target.id,
      physicalOperationId: request.id,
      ...(context.kind === "manual" ? { manualRequestId: context.requestId } : {}),
      nativeEnvelope: metadata,
      createdAt,
    });
    return envelope;
  }
  async beforeDispatch(owner: string, operation: NativeOperation) {
    const stored = await this.journal.db.get<JournalOperation>(
      owner,
      "task-operations",
      operation.id,
    );
    const request = {
      id: operation.id,
      executorId: operation.executorId,
      kind: operation.kind,
      capability: operation.capability,
      capabilityVersion: operation.capabilityVersion,
      args: operation.args,
      inspection: operation.inspection,
    };
    if (
      !stored ||
      stored.bindingHash !== operation.bindingHash ||
      bindingHash({ request, executorEpoch: operation.executorEpoch }) !== stored.bindingHash ||
      stored.executorEpoch !== operation.executorEpoch ||
      stored.resourceFence !== operation.resourceFence
    )
      throw new AppError("Native dispatch binding or fence changed", 409);
    await this.journal.authorizeDispatch(owner, operation.id, operation.revision, stored.runToken);
  }
  async recordReceipt(
    owner: string,
    operation: NativeOperation,
    receipt: NativeReceipt,
    sequence: number,
  ) {
    const stored = await this.journal.db.get<JournalOperation>(
      owner,
      "task-operations",
      operation.id,
    );
    if (!stored || stored.bindingHash !== operation.bindingHash)
      throw new AppError("Native receipt binding changed", 409);
    await this.journal.recordReceipt(
      owner,
      operation.id,
      receipt,
      receipt.status as OperationStatus,
      sequence,
    );
    // The node receipt proves physical cleanup. The awaited SDK result owns
    // logical completion, including artifact/hash/version publication ACKs.
    if (
      receipt.status !== "running" &&
      (receipt.status !== "outcome_unknown" || receipt.data?.cleanupConfirmed === true)
    )
      await this.options.wake?.(owner, operation.taskId);
  }
  async reconcileMissing(owner: string, operation: NativeOperation) {
    const stored = await this.journal.db.get<JournalOperation>(
      owner,
      "task-operations",
      operation.id,
    );
    if (!stored || stored.bindingHash !== operation.bindingHash)
      throw new AppError("Native reconciliation binding changed", 409);
    await this.recordReceipt(
      owner,
      operation,
      { status: "outcome_unknown", message: "Native supervisor did not confirm this operation" },
      (stored.sequence ?? 0) + 1,
    );
  }
  pause() {
    return new RuntimePause(this.journal.db).get("__runtime__");
  }
}
