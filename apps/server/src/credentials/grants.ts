import { randomUUID } from "node:crypto";
import { currentTaskScope } from "../engine/task-journal.ts";
import { AppError } from "../errors.ts";
import type { ExecutorOperation } from "../executors/protocol.ts";
import type { CredentialBroker } from "./broker.ts";
import type { CredentialChallenge } from "./contracts.ts";
import {
  matchesTrustedCredentialPlan,
  type NativeCredentialPlan,
  type TrustedCredentialInput,
  trustedCredentialChallengeInput,
  trustedCredentialChallengePlan,
  trustedCredentialInput,
  trustedCredentialPlan,
} from "./trusted-input.ts";

export type NativeCredentialSession = {
  id: string;
  browserSessionId: string;
  sessionGeneration: string;
  executorId: string;
  executorEpoch: number;
};
export type CredentialGrantConsumeBinding = {
  operationId: string;
  bindingHash: string;
  resourceFence: number;
  executorId: string;
  executorEpoch: number;
  taskId: string;
  revision: number;
  sessionId: string;
  desktopSessionId: string;
  sessionGeneration: string;
  origin: string;
  adapterId: string;
  challengeId?: string;
};
type PendingGrant = {
  id: string;
  taskOperationId: string;
  nativeOperationId?: string;
  nativeBindingHash?: string;
  resourceFence?: number;
  owner: string;
  taskId: string;
  revision: number;
  credentialRefId: string;
  credentialVersion: number;
  adapterId: string;
  origin: string;
  session: NativeCredentialSession;
  plan: NativeCredentialPlan;
  challenge?: { id: string; kind: CredentialChallenge["kind"] };
  transientInput?: TrustedCredentialInput;
  expiresAt: number;
};
type PendingChallengeCode = {
  owner: string;
  taskId: string;
  credentialRefId: string;
  value: string;
  expiresAt: number;
};

/**
 * Plaintext is held only in this bounded process-memory map. A grant is
 * issued only while a task's trusted browser operation is active, expires in
 * at most 60 seconds, and is deleted before its one-use response is returned.
 */
export class CredentialGrantBroker {
  private readonly pending = new Map<string, PendingGrant>();
  private readonly challengeCodes = new Map<string, PendingChallengeCode>();
  constructor(
    private readonly credentials: CredentialBroker,
    private readonly options: { now?: () => number; ttlMs?: number; maxPending?: number } = {},
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private sweep() {
    const now = this.now();
    for (const [id, grant] of this.pending) if (grant.expiresAt <= now) this.pending.delete(id);
    for (const [id, code] of this.challengeCodes)
      if (code.expiresAt <= now) this.challengeCodes.delete(id);
  }

  stageChallengeCode(
    owner: string,
    taskId: string,
    credentialRefId: string,
    challengeId: string,
    value: string,
  ) {
    this.sweep();
    if (!/^[0-9A-Za-z -]{4,128}$/.test(value))
      throw new AppError("Enter the verification code from the service", 422);
    this.challengeCodes.set(challengeId, {
      owner,
      taskId,
      credentialRefId,
      value,
      expiresAt: this.now() + Math.min(60_000, Math.max(1_000, this.options.ttlMs ?? 60_000)),
    });
  }

  takeChallengeCode(owner: string, taskId: string, challengeId: string) {
    this.sweep();
    const pending = this.challengeCodes.get(challengeId);
    if (!pending || pending.owner !== owner || pending.taskId !== taskId)
      throw new AppError(
        "The verification code expired; enter it again",
        409,
        "CHALLENGE_CODE_EXPIRED",
      );
    this.challengeCodes.delete(challengeId);
    return pending.value;
  }

  private claimChallengeCode(
    owner: string,
    taskId: string,
    credentialRefId: string,
    challengeId: string,
  ) {
    this.sweep();
    const pending = this.challengeCodes.get(challengeId);
    if (
      !pending ||
      pending.owner !== owner ||
      pending.taskId !== taskId ||
      pending.credentialRefId !== credentialRefId
    )
      return undefined;
    this.challengeCodes.delete(challengeId);
    return pending;
  }

  hasChallengeCode(owner: string, taskId: string, challengeId: string) {
    this.sweep();
    const pending = this.challengeCodes.get(challengeId);
    return Boolean(pending && pending.owner === owner && pending.taskId === taskId);
  }

  invalidateCredentialRef(owner: string, credentialRefId: string) {
    for (const [id, grant] of this.pending)
      if (grant.owner === owner && grant.credentialRefId === credentialRefId)
        this.pending.delete(id);
    for (const [id, code] of this.challengeCodes)
      if (code.owner === owner && code.credentialRefId === credentialRefId)
        this.challengeCodes.delete(id);
  }

  async issue(owner: string, session: NativeCredentialSession, supplied: NativeCredentialPlan) {
    this.sweep();
    if (this.pending.size >= (this.options.maxPending ?? 100))
      throw new AppError("Credential transfer is busy; retry from the secure form", 503);
    const scope = currentTaskScope();
    if (!scope || scope.owner !== owner || scope.task.status !== "running")
      throw new AppError("Credential transfer requires the current durable task", 403);
    const ref = scope.task.state.credentialRef as { id?: unknown; version?: unknown } | undefined;
    if (!ref || typeof ref.id !== "string")
      throw new AppError("This task has no authorized saved credential", 403);
    // Claim the transient factor before any await, so parallel grant issues
    // cannot both copy one OTP into separate native grants.
    const pendingChallenge = supplied.challenge
      ? this.claimChallengeCode(owner, scope.task.id, ref.id, supplied.challenge.id)
      : undefined;
    const authorized = await this.credentials.authorizeForTask(owner, scope.task.id, ref.id);
    if (
      !Number.isSafeInteger(ref.version) ||
      authorized.connection.credentialRef.version !== ref.version
    )
      throw new AppError("The saved credential version changed before use", 409);
    if (authorized.connection.status === "outcome_unknown")
      throw new AppError(
        "An earlier login outcome is uncertain; inspect the browser before continuing",
        409,
        "CREDENTIAL_OUTCOME_UNKNOWN",
      );
    const challengeRecord = supplied.challenge
      ? await this.credentials.getChallenge(owner, scope.task.id, ref.id, supplied.challenge.id)
      : undefined;
    const trusted =
      supplied.challenge && challengeRecord
        ? trustedCredentialChallengePlan(
            authorized.adapter,
            ref.id,
            scope.task.id,
            scope.operation.revision,
            { id: challengeRecord.id, kind: challengeRecord.kind },
          )
        : trustedCredentialPlan(
            authorized.adapter,
            ref.id,
            scope.task.id,
            scope.operation.revision,
          );
    if (
      supplied.adapterId !== trusted.adapterId ||
      supplied.origin !== trusted.origin ||
      !matchesTrustedCredentialPlan(supplied, trusted) ||
      !session.executorId ||
      !Number.isSafeInteger(session.executorEpoch) ||
      !session.sessionGeneration ||
      (supplied.challenge &&
        (!challengeRecord ||
          challengeRecord.status !== "waiting" ||
          !pendingChallenge ||
          pendingChallenge.owner !== owner ||
          pendingChallenge.taskId !== scope.task.id ||
          pendingChallenge.credentialRefId !== ref.id))
    )
      throw new AppError(
        "Credential transfer does not match the saved adapter or native session",
        403,
      );
    if (scope.task.attempts < 1 || !scope.task.id)
      throw new AppError("Credential transfer task scope is invalid", 403);
    const id = randomUUID();
    const requestedTtl = this.options.ttlMs ?? 60_000;
    const ttl = Math.min(60_000, Math.max(1_000, requestedTtl));
    const transientInput =
      supplied.challenge && pendingChallenge
        ? trustedCredentialChallengeInput(
            authorized.adapter,
            { id: supplied.challenge.id, kind: supplied.challenge.kind },
            pendingChallenge.value,
          )
        : undefined;
    if (pendingChallenge) pendingChallenge.value = "";
    this.pending.set(id, {
      id,
      taskOperationId: scope.operation.id,
      owner,
      taskId: scope.task.id,
      revision: scope.operation.revision,
      credentialRefId: ref.id,
      credentialVersion: ref.version,
      adapterId: trusted.adapterId,
      origin: trusted.origin,
      session: { ...session },
      plan: trusted,
      ...(supplied.challenge
        ? { challenge: { id: supplied.challenge.id, kind: supplied.challenge.kind } }
        : {}),
      ...(transientInput ? { transientInput } : {}),
      expiresAt: this.now() + ttl,
    });
    return id;
  }

  /** Bind an issued grant to the exact, authority-minted native delivery. */
  bindNativeOperation(owner: string, operation: ExecutorOperation) {
    const body = operation.args.body as Record<string, unknown> | undefined;
    const grantId = typeof body?.grantId === "string" ? body.grantId : undefined;
    const grant = grantId ? this.pending.get(grantId) : undefined;
    const valid = Boolean(
      grant &&
        grant.owner === owner &&
        grant.taskOperationId.length > 0 &&
        grant.taskId === operation.taskId &&
        grant.revision === operation.revision &&
        grant.session.executorId === operation.executorId &&
        grant.session.executorEpoch === operation.executorEpoch &&
        operation.kind === "browser" &&
        operation.capability === "browser.dom" &&
        operation.args.operation === "credentials" &&
        operation.args.sessionId === grant.session.id &&
        operation.args.sessionGeneration === grant.session.sessionGeneration &&
        operation.args.browserSessionId === grant.session.browserSessionId &&
        body?.origin === grant.origin &&
        body?.adapterId === grant.adapterId &&
        body?.challengeId === grant.challenge?.id &&
        Date.parse(operation.expiresAt) > this.now(),
    );
    if (!valid || !grant)
      throw new AppError("Credential grant does not match the published native operation", 403);
    if (grant.nativeOperationId && grant.nativeOperationId !== operation.id)
      throw new AppError("Credential grant is already bound to another native operation", 409);
    grant.nativeOperationId = operation.id;
    grant.nativeBindingHash = operation.bindingHash;
    grant.resourceFence = operation.resourceFence;
    grant.expiresAt = Math.min(grant.expiresAt, Date.parse(operation.expiresAt));
  }

  async consume(
    owner: string,
    grantId: string,
    binding: CredentialGrantConsumeBinding,
  ): Promise<import("./trusted-input.ts").TrustedCredentialInput> {
    this.sweep();
    const grant = this.pending.get(grantId);
    if (!grant || grant.owner !== owner)
      throw new AppError("Credential grant is expired, absent or already consumed", 404);
    const matches =
      grant.nativeOperationId === binding.operationId &&
      grant.nativeBindingHash === binding.bindingHash &&
      grant.resourceFence === binding.resourceFence &&
      grant.taskId === binding.taskId &&
      grant.revision === binding.revision &&
      grant.session.executorId === binding.executorId &&
      grant.session.executorEpoch === binding.executorEpoch &&
      grant.session.id === binding.desktopSessionId &&
      grant.session.browserSessionId === binding.sessionId &&
      grant.session.sessionGeneration === binding.sessionGeneration &&
      grant.origin === binding.origin &&
      grant.adapterId === binding.adapterId;
    const challengeMatches =
      grant.plan.challenge?.id === binding.challengeId &&
      (grant.plan.challenge === undefined
        ? binding.challengeId === undefined
        : Boolean(binding.challengeId));
    if (!matches || !challengeMatches)
      throw new AppError("Credential grant scope does not match the claimed native operation", 403);
    // Claim synchronously before any vault read. Concurrent consume requests
    // cannot both pass this point, including transient OTP payloads.
    this.pending.delete(grantId);
    if (grant.transientInput) {
      return grant.transientInput;
    }
    const { adapter, values, connection } = await this.credentials.getForTask(
      owner,
      grant.taskId,
      grant.credentialRefId,
    );
    const wipeValues = () => {
      for (const key of Object.keys(values)) values[key] = "";
    };
    try {
      const current = await this.credentials.authorizeForTask(
        owner,
        grant.taskId,
        grant.credentialRefId,
      );
      if (
        connection.credentialRef.version !== grant.credentialVersion ||
        current.connection.credentialRef.version !== grant.credentialVersion ||
        current.connection.status === "outcome_unknown"
      )
        throw new AppError("The saved credential changed or was revoked during transfer", 409);
    } catch (error) {
      wipeValues();
      throw error;
    }
    const input = trustedCredentialInput(adapter, values);
    const { fields: _fields, ...fixed } = input;
    const actualPlan = {
      ...fixed,
      credentialRefId: grant.credentialRefId,
      taskId: grant.taskId,
      revision: grant.revision,
    };
    if (!matchesTrustedCredentialPlan(actualPlan, grant.plan)) {
      for (const field of input.fields) field.value = "";
      throw new AppError("Credential grant adapter changed before use", 409);
    }
    // Delete before returning any secret bytes. Network loss requires a fresh
    // vault read and a new grant; it can never replay the original submit.
    return input;
  }
  get pendingCount() {
    this.sweep();
    return this.pending.size;
  }
}
