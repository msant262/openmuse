import { createHash, timingSafeEqual } from "node:crypto";
import { trackNativeComputerOperation } from "../computer-resource-scope.ts";
import type { Store } from "../db.ts";
import { currentTaskScope } from "../engine/task-journal.ts";
import { AppError, NativePreflightRejection } from "../errors.ts";
import { nativeGraphicalReset, nativeInspection } from "./graphical-policy.ts";
import {
  type ArtifactPublication,
  artifactPublicationSchema,
  EXECUTOR_PROTOCOL,
  type ExecutorAuthority,
  type ExecutorDispatchContext,
  type ExecutorHello,
  type ExecutorOperation,
  type ExecutorPause,
  type ExecutorReceipt,
  type ExecutorRegistration,
  type ExecutorRequest,
  executorHelloSchema,
  executorManifestSchema,
  executorOperationSchema,
  executorReadinessSchema,
  executorReceiptSchema,
  executorRegistrationSchema,
  executorRequestSchema,
  pauseAckSchema,
} from "./protocol.ts";

const SYSTEM = "__executors__";
const terminal = (receipt?: ExecutorReceipt) => Boolean(receipt && receipt.status !== "running");
export interface ExecutorNode {
  id: string;
  hello: ExecutorHello;
  epoch: number;
  protocolVersion: number;
  generation: number;
  lastHeartbeatAt: number;
  reconciled: boolean;
  retiredInstances: string[];
  pauseAck?: { epoch: number; revision: number; contained: boolean; guaranteed: boolean };
}
export interface ExecutorDelivery {
  id: string;
  owner: string;
  operation: ExecutorOperation;
  state: "queued" | "claimed" | "settled";
  sequence: number;
  receipt?: ExecutorReceipt;
  receiptHash?: string;
  createdAt: string;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
/** Durable node delivery bound to an authoritative operation. Transport cannot
 * invent tasks/admission or grant effects when the authority dependency is absent.
 */
export class ExecutorRegistry {
  readonly registrations: ExecutorRegistration[];
  private readonly waiters = new Map<string, Set<() => void>>();
  private stopping = false;
  /** Wake idle polls and stop fresh dispatch; receipt handlers must still drain. */
  stopDispatch() {
    this.stopping = true;
    for (const executorId of this.waiters.keys()) this.wake(executorId);
  }
  constructor(
    readonly db: Store,
    private readonly options: {
      registrations: ExecutorRegistration[];
      authority?: ExecutorAuthority;
      now?: () => number;
      watchdogMs?: number;
      beforePublish?: (owner: string, operation: ExecutorOperation) => Promise<void>;
    },
  ) {
    this.registrations = options.registrations.map((value) =>
      executorRegistrationSchema.parse(value),
    );
    if (
      new Set(this.registrations.map((value) => value.executorId)).size !==
      this.registrations.length
    )
      throw new Error("Duplicate native executor registration");
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  get authorized() {
    return Boolean(this.options.authority);
  }
  /** One-use private payload channels recheck the same M4 dispatch authority. */
  async validateDispatch(owner: string, operation: ExecutorOperation) {
    return this.authority().beforeDispatch(owner, operation);
  }
  get watchdogMs() {
    return this.options.watchdogMs ?? 40000;
  }
  registration(executorId: string) {
    const registration = this.registrations.find((value) => value.executorId === executorId);
    if (!registration) throw new AppError("Native executor is not registered", 404);
    return registration;
  }
  authenticate(executorId: string, authorization?: string) {
    const registration = this.registrations.find((value) => value.executorId === executorId);
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (
      !registration ||
      token.length < 32 ||
      !timingSafeEqual(Buffer.from(hash(token), "hex"), Buffer.from(registration.tokenHash, "hex"))
    )
      throw new AppError("Invalid scoped executor credential", 401);
  }
  private authority() {
    if (!this.options.authority)
      throw new AppError(
        "Native executor dispatch authority is unavailable; compose the authoritative task journal before effects",
        503,
      );
    return this.options.authority;
  }
  async pause(): Promise<ExecutorPause> {
    return (
      this.options.authority?.pause() ?? {
        paused: true,
        revision: 0,
        changedAt: new Date(this.now()).toISOString(),
      }
    );
  }
  private wake(executorId: string) {
    for (const resolve of this.waiters.get(executorId) ?? []) resolve();
  }
  async register(raw: unknown) {
    const hello = executorHelloSchema.parse(raw),
      registration = this.registration(hello.executorId);
    if (hello.hostId !== registration.hostId || hello.osAccountId !== registration.osAccountId)
      throw new AppError("Executor hello does not match its fixed registered host/account", 403);
    const protocolVersion = Math.min(hello.maxProtocolVersion, EXECUTOR_PROTOCOL.max);
    if (protocolVersion < Math.max(hello.minProtocolVersion, EXECUTOR_PROTOCOL.min))
      throw new AppError(
        "Executor protocol is incompatible; update the native supervisor before dispatch",
        409,
      );
    const identity = `${hello.bootId}:${hello.instanceId ?? hello.bootId}`;
    hello.readiness = {
      ...hello.readiness,
      trustMode: registration.trustMode,
      containmentGuaranteed:
        registration.trustMode === "restricted" && hello.readiness.containmentGuaranteed,
    };
    for (let attempt = 0; attempt < 16; attempt++) {
      const previous = await this.db.get<ExecutorNode>(SYSTEM, "nodes", hello.executorId);
      const oldIdentity = previous
        ? `${previous.hello.bootId}:${previous.hello.instanceId ?? previous.hello.bootId}`
        : undefined;
      if (previous?.retiredInstances.includes(identity))
        throw new AppError("Native supervisor instance was retired by a newer epoch", 409);
      const changed = oldIdentity !== identity;
      const value: ExecutorNode = {
        id: hello.executorId,
        hello,
        epoch: previous ? (changed ? previous.epoch + 1 : previous.epoch) : 1,
        protocolVersion,
        generation: (previous?.generation ?? 0) + 1,
        lastHeartbeatAt: this.now(),
        reconciled: false,
        retiredInstances: [
          ...(previous?.retiredInstances ?? []),
          ...(previous && changed ? [oldIdentity as string] : []),
        ].slice(-256),
      };
      const saved = previous
        ? await this.db.compareAndSwap<ExecutorNode>(
            SYSTEM,
            "nodes",
            hello.executorId,
            { generation: previous.generation },
            { ...value },
          )
        : await this.db.insertIfAbsent(SYSTEM, "nodes", value);
      if (saved) {
        await this.acceptPublicationConflicts(hello.executorId, hello.readiness);
        this.wake(hello.executorId);
        return {
          epoch: value.epoch,
          protocolVersion,
          reconcileRequired: true,
          watchdogMs: this.watchdogMs,
          pause: await this.pause(),
          serverTime: new Date(this.now()).toISOString(),
        };
      }
    }
    throw new AppError("Native registration raced; reconnect and reconcile", 409);
  }
  async node(executorId: string) {
    this.registration(executorId);
    const node = await this.db.get<ExecutorNode>(SYSTEM, "nodes", executorId);
    return node
      ? { ...node, connected: node.lastHeartbeatAt + this.watchdogMs > this.now() }
      : null;
  }
  private async epoch(executorId: string, epoch: number) {
    const node = await this.node(executorId);
    if (!node || node.epoch !== epoch)
      throw new AppError("Native executor epoch is stale; register and reconcile", 409);
    return node;
  }
  async heartbeat(executorId: string, epoch: number, raw: unknown, pauseAck?: unknown) {
    const node = await this.epoch(executorId, epoch),
      registration = this.registration(executorId);
    const readiness = executorReadinessSchema.parse(raw);
    readiness.trustMode = registration.trustMode;
    readiness.containmentGuaranteed =
      registration.trustMode === "restricted" && readiness.containmentGuaranteed;
    const ack = pauseAck ? pauseAckSchema.parse(pauseAck) : undefined;
    if (ack && (ack.epoch !== epoch || ack.revision > (await this.pause()).revision))
      throw new AppError("Containment ACK epoch/revision is invalid", 409);
    const saved = await this.db.compareAndSwap<ExecutorNode>(
      SYSTEM,
      "nodes",
      executorId,
      { epoch, generation: node.generation },
      {
        hello: { ...node.hello, readiness },
        lastHeartbeatAt: this.now(),
        generation: node.generation + 1,
        ...(ack && {
          pauseAck: {
            ...ack,
            guaranteed: registration.trustMode === "restricted" && ack.guaranteed,
          },
        }),
      },
    );
    if (!saved) throw new AppError("Native heartbeat epoch changed during update", 409);
    await this.acceptPublicationConflicts(executorId, readiness);
    this.wake(executorId);
    return {
      epoch,
      pause: await this.pause(),
      watchdogMs: this.watchdogMs,
      // ACK only after every conflict is durable; a lost response replays the batch.
      publicationConflictAcks: readiness.publicationConflicts,
    };
  }
  private publicationConflictId(executorId: string, data: Record<string, unknown>) {
    return createHash("sha256")
      .update(
        JSON.stringify([
          executorId,
          data.artifactId ?? data.id,
          data.path,
          data.version,
          data.sha256,
          data.generation ?? 1,
          data.versionId ?? null,
        ]),
      )
      .digest("hex");
  }
  private async acceptPublicationConflicts(
    executorId: string,
    readiness: ExecutorHello["readiness"],
  ) {
    const owner = this.registration(executorId).owner;
    for (const conflict of readiness.publicationConflicts) {
      await this.db.insertIfAbsent(owner, "native-artifact-conflicts", {
        id: this.publicationConflictId(executorId, conflict),
        executorId,
        ...conflict,
      });
      const current = await this.db.get<Record<string, unknown>>(
        owner,
        "native-artifacts",
        conflict.artifactId,
      );
      if (
        current?.executorId === executorId &&
        this.publicationConflictId(executorId, current) ===
          this.publicationConflictId(executorId, conflict)
      )
        await this.db.compareAndSwap(owner, "native-artifacts", conflict.artifactId, current, {
          published: false,
          publicationConflict: conflict.reason,
        });
    }
  }
  async publicationConflict(owner: string, executorId: string, data: Record<string, unknown>) {
    if (this.registration(executorId).owner !== owner)
      throw new AppError("Native artifact belongs to another owner", 403);
    return this.db.get<{ reason: string }>(
      owner,
      "native-artifact-conflicts",
      this.publicationConflictId(executorId, data),
    );
  }
  private supports(node: ExecutorNode, request: ExecutorRequest) {
    const capability = node.hello.capabilities.find((value) => value.name === request.capability);
    if (!capability)
      throw new AppError(`Native executor capability ${request.capability} is absent`, 409);
    if (capability.version !== request.capabilityVersion)
      throw new AppError(
        `Native executor capability ${request.capability} semantic version is incompatible; update before dispatch`,
        409,
      );
  }
  private ready(node: ExecutorNode, operation: ExecutorOperation) {
    const readiness = node.hello.readiness;
    if (readiness.quarantined || readiness.account.state !== "ready") return false;
    if (operation.capability === "files") return readiness.files.state === "ready";
    if (operation.capability === "command" || operation.capability === "transcribe")
      return readiness.runtime.state === "ready";
    if (operation.capability === "desktop")
      return [readiness.display, readiness.capture, readiness.input].every(
        (value) => value.state === "ready",
      );
    if (operation.capability === "browser.screenshot")
      return readiness.browser.state === "ready" && readiness.capture.state === "ready";
    if (["browser.pointer", "browser.drag"].includes(operation.capability))
      return readiness.browser.state === "ready" && readiness.input.state === "ready";
    return readiness.browser.state === "ready";
  }
  async enqueue(
    owner: string,
    raw: ExecutorRequest,
    context?: ExecutorDispatchContext,
    dispatch?: { onDispatch?: (id: string) => Promise<void> },
  ) {
    const authority = this.authority(),
      request = executorRequestSchema.parse(raw),
      registration = this.registration(request.executorId);
    if (!context)
      throw new AppError(
        "Native dispatch requires a trusted task context or authenticated manual-operation authorization",
        503,
      );
    const inspection = nativeInspection(request.kind, request.args);
    if (request.inspection !== inspection)
      throw new AppError("Native inspection permission does not match concrete operation", 422);
    if (owner !== registration.owner)
      throw new AppError("Native executor belongs to another owner", 403);
    const prior = await this.delivery(owner, request.id);
    const node = await this.node(request.executorId);
    if (!node && !prior) throw new AppError("Native executor has not registered/preflighted", 503);
    if (!prior && node) {
      try {
        this.supports(node, request);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        const scope = currentTaskScope();
        throw new NativePreflightRejection(
          error.message,
          scope?.operation.id,
          scope?.primitive?.id,
        );
      }
    }
    const epoch = prior?.operation.executorEpoch ?? node?.epoch;
    if (!epoch) throw new AppError("Native executor epoch is unavailable", 503);
    const operation = executorOperationSchema.parse(
      await authority.authorize(owner, request, epoch, context),
    );
    if (
      operation.id !== request.id ||
      operation.executorId !== request.executorId ||
      operation.executorEpoch !== epoch ||
      canonical(operation.args) !== canonical(request.args) ||
      operation.kind !== request.kind ||
      operation.capability !== request.capability ||
      operation.capabilityVersion !== request.capabilityVersion ||
      operation.inspection !== request.inspection
    )
      throw new AppError(
        "Authoritative native operation does not match dispatch request/epoch",
        409,
      );
    if (prior) {
      if (prior.operation.bindingHash !== operation.bindingHash)
        throw new AppError("Native operation ID binding conflict", 409);
      return prior.operation;
    }
    if (
      request.kind === "file" ||
      request.kind === "file-version" ||
      ((request.kind === "desktop" || request.kind === "browser") &&
        !inspection &&
        !nativeGraphicalReset(request.kind, request.args))
    )
      await trackNativeComputerOperation(owner, operation.id);
    await dispatch?.onDispatch?.(operation.id);
    await this.options.beforePublish?.(owner, operation);
    await this.db.insertIfAbsent<ExecutorDelivery>(SYSTEM, "deliveries", {
      id: operation.id,
      owner,
      operation,
      state: "queued",
      sequence: 0,
      createdAt: new Date(this.now()).toISOString(),
    });
    const saved = await this.delivery(owner, operation.id);
    if (!saved || saved.operation.bindingHash !== operation.bindingHash)
      throw new AppError("Native operation ID binding conflict", 409);
    this.wake(operation.executorId);
    return saved.operation;
  }
  async delivery(owner: string, id: string) {
    const delivery = await this.db.get<ExecutorDelivery>(SYSTEM, "deliveries", id);
    return delivery?.owner === owner ? delivery : null;
  }
  async deliveries(owner: string, executorId: string) {
    if (this.registration(executorId).owner !== owner)
      throw new AppError("Native executor belongs to another owner", 403);
    return (await this.db.list<ExecutorDelivery>(SYSTEM, "deliveries")).filter(
      (value) => value.owner === owner && value.operation.executorId === executorId,
    );
  }
  private async claim(executorId: string, epoch: number) {
    const authority = this.options.authority,
      node = await this.epoch(executorId, epoch),
      pause = await this.pause();
    const operations: ExecutorOperation[] = [];
    if (this.stopping || !authority || !node.connected || !node.reconciled)
      return { epoch, pause, operations };
    const owner = this.registration(executorId).owner;
    const deliveries = (await this.deliveries(owner, executorId)).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    for (const delivery of deliveries) {
      if (this.stopping) break;
      const operation = delivery.operation;
      const containment =
        operation.kind === "cancel" ||
        (operation.kind === "session" && operation.args.operation === "stop") ||
        nativeGraphicalReset(operation.kind, operation.args);
      if (
        delivery.state !== "queued" ||
        operation.executorEpoch !== epoch ||
        !this.ready(node, operation) ||
        (pause.paused && !operation.inspection && !containment)
      )
        continue;
      this.supports(node, operation);
      if (Date.parse(operation.expiresAt) <= this.now()) {
        await this.retireQueued(delivery, "Native command expired before dispatch");
        continue;
      }
      // Claim transport before the authority barrier to prevent two pollers from
      // creating two effect grants. An uncertain barrier remains claimed/unknown.
      const claimed = await this.db.compareAndSwap<ExecutorDelivery>(
        SYSTEM,
        "deliveries",
        delivery.id,
        { state: "queued", sequence: 0 },
        { state: "claimed" },
      );
      if (!claimed) continue;
      try {
        if (this.stopping) throw new AppError("Server is shutting down", 503);
        await authority.beforeDispatch(owner, operation);
        const current = await this.epoch(executorId, epoch);
        if (this.stopping) throw new AppError("Server is shutting down", 503);
        if (!current.connected || !current.reconciled)
          throw new AppError("Native dispatch epoch/readiness changed", 409);
        operations.push(operation);
      } catch (error) {
        await this.setReceipt(claimed, 1, {
          status: "rejected_not_dispatched",
          message:
            error instanceof Error
              ? error.message.slice(0, 1000)
              : "Authoritative dispatch rejected",
        });
      }
      if (operations.length >= 1) break; // A 25MB file envelope must fit the bounded wire response.
    }
    return { epoch, pause, operations };
  }
  async claimOperations(
    executorId: string,
    epoch: number,
    options: { waitMs?: number; signal?: AbortSignal } = {},
  ) {
    const waitMs = Math.max(0, Math.min(20000, options.waitMs ?? 0));
    const deadline = Date.now() + waitMs;
    let revision: number | undefined;
    for (;;) {
      // Subscribe before querying so a publication cannot be lost between query
      // and long-poll installation. Cross-process delivery polls every 500ms.
      let wake!: () => void;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const awakened = new Promise<void>((resolve) => {
        wake = resolve;
      });
      const waiters = this.waiters.get(executorId) ?? new Set<() => void>();
      waiters.add(wake);
      this.waiters.set(executorId, waiters);
      const aborted = () => wake();
      options.signal?.addEventListener("abort", aborted, { once: true });
      try {
        const result = await this.claim(executorId, epoch);
        if (
          this.stopping ||
          result.operations.length ||
          Date.now() >= deadline ||
          options.signal?.aborted ||
          (revision !== undefined && revision !== result.pause.revision)
        )
          return result;
        revision = result.pause.revision;
        timer = setTimeout(wake, Math.min(Math.max(1, deadline - Date.now()), 500));
        await awakened;
      } finally {
        if (timer) clearTimeout(timer);
        waiters.delete(wake);
        if (!waiters.size) this.waiters.delete(executorId);
        options.signal?.removeEventListener("abort", aborted);
      }
    }
  }
  private async setReceipt(
    delivery: ExecutorDelivery,
    sequence: number,
    receipt: ExecutorReceipt,
  ): Promise<{ operationId: string; sequence: number }> {
    const current = await this.delivery(delivery.owner, delivery.id);
    if (!current) throw new AppError("Native operation is not owned by this executor", 404);
    const receiptHash = hash(canonical(receipt));
    if (sequence === current.sequence && current.receiptHash && current.receiptHash !== receiptHash)
      throw new AppError("Native receipt sequence binding conflict", 409);
    const cleanupUpdate =
      current.receipt?.status === "outcome_unknown" &&
      receipt.status === "outcome_unknown" &&
      receipt.data?.cleanupConfirmed === true &&
      current.receipt.data?.cleanupConfirmed !== true &&
      sequence > current.sequence;
    if ((terminal(current.receipt) && !cleanupUpdate) || sequence <= current.sequence) {
      if (current.receipt && (terminal(current.receipt) || sequence === current.sequence)) {
        // Retry authority update if its write failed after transport CAS. ACK is
        // withheld until the authoritative journal durably accepts the receipt.
        await this.authority().recordReceipt(
          current.owner,
          current.operation,
          current.receipt,
          current.sequence,
        );
      }
      return { operationId: current.id, sequence: current.sequence };
    }
    const saved = await this.db.compareAndSwap<ExecutorDelivery>(
      SYSTEM,
      "deliveries",
      current.id,
      { sequence: current.sequence, state: current.state },
      {
        receipt,
        receiptHash,
        sequence,
        state: terminal(receipt) ? "settled" : "claimed",
      },
    );
    if (!saved) return this.setReceipt(delivery, sequence, receipt);
    await this.authority().recordReceipt(saved.owner, saved.operation, receipt, sequence);
    this.wake(saved.operation.executorId);
    return { operationId: saved.id, sequence };
  }
  /** The queued CAS is the transport's durable proof that this envelope was
   * never granted to a poller. Losing it must not certify physical cleanup. */
  private async retireQueued(delivery: ExecutorDelivery, message: string) {
    const receipt: ExecutorReceipt = {
      status: "rejected_not_dispatched",
      message,
      data: { cleanupConfirmed: true },
    };
    const saved = await this.db.compareAndSwap<ExecutorDelivery>(
      SYSTEM,
      "deliveries",
      delivery.id,
      { state: "queued", sequence: 0 },
      {
        state: "settled",
        receipt,
        receiptHash: hash(canonical(receipt)),
        sequence: 1,
      },
    );
    if (!saved) return false;
    await this.authority().recordReceipt(saved.owner, saved.operation, receipt, 1);
    this.wake(saved.operation.executorId);
    return true;
  }
  async submitReceipt(
    executorId: string,
    epoch: number,
    operationId: string,
    sequence: number,
    raw: unknown,
  ) {
    await this.epoch(executorId, epoch);
    if (!Number.isSafeInteger(sequence) || sequence < 1)
      throw new AppError("Native receipt sequence must be positive", 422);
    const registration = this.registration(executorId),
      delivery = await this.delivery(registration.owner, operationId);
    if (!delivery || delivery.operation.executorId !== executorId)
      throw new AppError("Native operation is not owned by this executor", 404);
    if (delivery.operation.executorEpoch !== epoch)
      throw new AppError("Native operation epoch requires explicit reconciliation", 409);
    if (delivery.state === "queued")
      throw new AppError("Native receipt refers to an undispatched operation", 409);
    return this.setReceipt(delivery, sequence, executorReceiptSchema.parse(raw));
  }
  async reconcile(executorId: string, raw: unknown) {
    const manifest = executorManifestSchema.parse(raw),
      node = await this.epoch(executorId, manifest.epoch);
    if (manifest.bootId !== node.hello.bootId)
      throw new AppError("Native manifest boot does not match registered epoch", 409);
    const owner = this.registration(executorId).owner,
      acknowledged: { operationId: string; sequence: number }[] = [];
    const local = new Set<string>();
    for (const item of manifest.operations) {
      const delivery = await this.delivery(owner, item.operationId);
      if (
        !delivery ||
        delivery.operation.executorId !== executorId ||
        delivery.operation.bindingHash !== item.bindingHash ||
        delivery.operation.executorEpoch !== item.executorEpoch
      )
        throw new AppError("Native reconciliation binding/executor/epoch mismatch", 409);
      local.add(item.operationId);
      if (item.sequence > 0 && delivery.state !== "queued")
        acknowledged.push(await this.setReceipt(delivery, item.sequence, item.receipt));
      else if (!terminal(delivery.receipt)) {
        await this.authority().reconcileMissing(owner, delivery.operation);
        await this.setReceipt(delivery, Math.max(1, delivery.sequence + 1), {
          status: "outcome_unknown",
          message: "Native journal has no durable effect receipt",
        });
      }
    }
    for (let delivery of await this.deliveries(owner, executorId)) {
      if (delivery.receipt?.status === "rejected_not_dispatched" && !local.has(delivery.id)) {
        // Server-generated rejection has no node journal entry to retransmit.
        // Retry its authority write before opening the new epoch's gate.
        await this.setReceipt(delivery, delivery.sequence, delivery.receipt);
        continue;
      }
      if (
        delivery.state === "queued" &&
        delivery.operation.executorEpoch !== manifest.epoch &&
        !local.has(delivery.id)
      ) {
        if (
          await this.retireQueued(
            delivery,
            "Native epoch changed before the command was dispatched",
          )
        )
          continue;
        // A concurrent old-epoch poller may have claimed this envelope before
        // registration fenced it. Re-read and retain uncertainty in that case.
        delivery = (await this.delivery(owner, delivery.id)) ?? delivery;
      }
      if (
        !terminal(delivery.receipt) &&
        !local.has(delivery.id) &&
        (delivery.state === "claimed" || delivery.operation.executorEpoch !== manifest.epoch)
      ) {
        await this.authority().reconcileMissing(owner, delivery.operation);
        await this.setReceipt(delivery, Math.max(1, delivery.sequence + 1), {
          status: "outcome_unknown",
          message: "Claimed command is absent from native manifest; no blind retry",
        });
      }
    }
    if (!manifest.contained)
      throw new AppError("Native containment is unconfirmed; executor stays quarantined", 409);
    // Do not race a concurrent heartbeat's generation; epoch+boot are immutable
    // for this update and a later registration always resets reconciled=false.
    const updated = await this.db.compareAndSwap(
      SYSTEM,
      "nodes",
      executorId,
      { epoch: manifest.epoch, hello: node.hello },
      { reconciled: true },
    );
    if (!updated)
      throw new AppError("Native reconciliation raced with registration; repeat handshake", 409);
    return { reconciled: true, acknowledged };
  }
  async publishArtifact(executorId: string, epoch: number, raw: unknown) {
    await this.epoch(executorId, epoch);
    const artifact = artifactPublicationSchema.parse(raw),
      owner = this.registration(executorId).owner;
    if (await this.publicationConflict(owner, executorId, artifact))
      throw new AppError("Origin artifact publication conflicted; inspect the current file", 409);
    if (
      !artifact.path.startsWith("/workspace/") ||
      artifact.path.split("/").some((value) => value === ".." || value === ".")
    )
      throw new AppError("Invalid native artifact workspace path", 422);
    const deliveries = await this.deliveries(owner, executorId);
    const proof = deliveries.find(
      (value) =>
        value.receipt?.status === "succeeded" &&
        value.receipt.data?.artifactId === artifact.artifactId &&
        value.receipt.data?.version === artifact.version &&
        value.receipt.data?.sha256 === artifact.sha256 &&
        value.receipt.data?.path === artifact.path &&
        value.receipt.data?.size === artifact.size &&
        value.receipt.data?.mimeType === artifact.mimeType &&
        (value.receipt.data?.generation ?? 1) === artifact.generation &&
        value.receipt.data?.versionId === artifact.versionId,
    );
    if (!proof) throw new AppError("Native artifact lacks confirmed owned publication proof", 409);
    const current = await this.db.get<{
      executorId: string;
      generation?: number;
      version: string;
      versionId?: string;
    }>(owner, "native-artifacts", artifact.artifactId);
    if (current && current.executorId !== executorId)
      throw new AppError("Native artifact identity belongs to another executor", 409);
    if (
      current &&
      (current.generation ?? 1) === artifact.generation &&
      (current.version !== artifact.version || current.versionId !== artifact.versionId)
    )
      throw new AppError("Native artifact generation binding conflict", 409);
    for (const version of artifact.versions) {
      if (version.artifactId !== artifact.artifactId || version.path !== artifact.path)
        throw new AppError("Native recovery version is not owned by artifact", 409);
      const existingVersion = await this.db.get<Record<string, unknown>>(
        owner,
        "file-versions",
        version.id,
      );
      if (existingVersion && existingVersion.executorId !== executorId)
        throw new AppError("Native recovery version belongs to another executor", 409);
      if (
        existingVersion &&
        canonical({ ...existingVersion, executorId, originArtifactId: artifact.artifactId }) !==
          canonical({ ...version, executorId, originArtifactId: artifact.artifactId })
      )
        throw new AppError("Native recovery version identity binding conflict", 409);
    }
    const id = `${executorId}:${artifact.artifactId}:${artifact.generation}:${artifact.versionId ?? artifact.version}`;
    const existing = await this.db.get<{ id: string; artifact: ArtifactPublication }>(
      owner,
      "native-artifact-publications",
      id,
    );
    if (existing && canonical(existing.artifact) !== canonical(artifact))
      throw new AppError("Native artifact version binding conflict", 409);
    await this.db.insertIfAbsent(owner, "native-artifact-publications", {
      id,
      executorId,
      artifact,
    });
    for (const version of artifact.versions) {
      await this.db.insertIfAbsent(owner, "file-versions", {
        ...version,
        executorId,
        originArtifactId: artifact.artifactId,
      });
    }
    // This final durable metadata write is the publication ACK boundary. Earlier
    // recovery/publication bookkeeping cannot announce a completed artifact.
    await this.db.publishNativeArtifact(owner, {
      id: artifact.artifactId,
      executorId,
      ...artifact,
      published: true,
    });
    return {
      artifactId: artifact.artifactId,
      version: artifact.version,
      sha256: artifact.sha256,
      ...(artifact.versionId && { generation: artifact.generation, versionId: artifact.versionId }),
    };
  }
}
