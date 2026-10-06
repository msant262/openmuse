import { createHash, randomUUID } from "node:crypto";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type { InteractionRequest } from "../../../../packages/domain/src/runtime.ts";
import { bindingHash } from "../conversation-inbox.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import {
  type CredentialAdapter,
  type CredentialBrowserBinding,
  type CredentialChallenge,
  type CredentialConnection,
  type CredentialFormSchema,
  type CredentialRef,
  type CredentialRequestRecord,
  type CredentialStatus,
  credentialAdapterSchema,
  runtimeCredentialAdapterSchema,
  type SecretStore,
  type ValidCredentialAdapter,
} from "./contracts.ts";

const nowIso = () => new Date().toISOString();
const equalData = (left: Record<string, string>, right: Record<string, string>) =>
  Object.keys(left).length === Object.keys(right).length &&
  Object.keys(left).every((key) => left[key] === right[key]);

function stableId(value: string) {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return `${bytes.subarray(0, 4).toString("hex")}-${bytes.subarray(4, 6).toString("hex")}-${bytes.subarray(6, 8).toString("hex")}-${bytes.subarray(8, 10).toString("hex")}-${bytes.subarray(10).toString("hex")}`;
}

export class CredentialBroker {
  private readonly adapters: Map<string, ValidCredentialAdapter>;
  private grantInvalidator?: (owner: string, credentialRefId: string) => void;
  constructor(
    private readonly db: Store,
    private readonly secretStore: SecretStore,
    adapters: CredentialAdapter[],
    private readonly options: { now?: () => number; requestTtlMs?: number } = {},
  ) {
    const parsed = adapters.map((adapter) => credentialAdapterSchema.parse(adapter));
    if (new Set(parsed.map((adapter) => adapter.id)).size !== parsed.length)
      throw new Error("Credential adapter IDs must be unique");
    this.adapters = new Map(parsed.map((adapter) => [adapter.id, adapter]));
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  configureGrantInvalidator(invalidator: (owner: string, credentialRefId: string) => void) {
    this.grantInvalidator = invalidator;
  }

  adapter(id: string) {
    const value = this.adapters.get(id);
    if (!value) throw new AppError("This service does not have a supported login adapter", 404);
    return value;
  }

  async resolveAdapter(owner: string, id: string): Promise<ValidCredentialAdapter> {
    const configured = this.adapters.get(id);
    if (configured) return configured;
    const stored = await this.db.get<{ id: string; adapter: unknown }>(
      owner,
      "credential-adapters",
      id,
    );
    if (!stored) throw new AppError("Connection form not found", 404);
    return credentialAdapterSchema.parse(stored.adapter);
  }

  async registerAdapter(owner: string, raw: unknown): Promise<ValidCredentialAdapter> {
    const definition = runtimeCredentialAdapterSchema.parse(raw);
    credentialAdapterSchema.parse({
      ...definition,
      id: "runtime-validation",
      allowedRedirectOrigins: [],
    });
    if (!definition.fields.some((field) => field.type === "password"))
      throw new AppError("A site login form must identify its password field", 422);
    // A runtime descriptor must never place a password in an arbitrary public
    // text box. Intersect the observed selector with the real input type. The
    // browser worker also checks common form ownership, POST and destination.
    if (Object.values(definition.selectors).some((selector) => /[(),\\]/.test(selector)))
      throw new AppError("Use a simple CSS selector for each login input", 422);
    const selectors = Object.fromEntries(
      definition.fields.map((field) => [
        field.id,
        `:is(${definition.selectors[field.id]}):is(${field.type === "password" ? 'input[type="password"]' : 'input[type="text"],input[type="email"],input:not([type])'})`,
      ]),
    );
    const adapter = credentialAdapterSchema.parse({
      ...definition,
      id: `runtime-${bindingHash(definition).slice(0, 40)}`,
      selectors,
      allowedRedirectOrigins: [],
    });
    await this.db.insertIfAbsent(owner, "credential-adapters", { id: adapter.id, adapter });
    return adapter;
  }

  async connections(owner: string) {
    const rows = await this.db.list<CredentialConnection>(owner, "credentials");
    return rows
      .filter((row) => row.adapterId && row.credentialRef?.id && row.origin && row.status)
      .map(
        ({
          id,
          adapterId,
          serviceName,
          origin,
          credentialRef,
          status,
          updatedAt,
          lastAuthenticatedAt,
          challengeId,
          challengeKind,
        }) => ({
          id,
          adapterId,
          serviceName,
          origin,
          credentialRef: { id: credentialRef.id, version: credentialRef.version },
          status,
          updatedAt,
          ...(lastAuthenticatedAt ? { lastAuthenticatedAt } : {}),
          ...(challengeId ? { challengeId } : {}),
          ...(challengeKind ? { challengeKind } : {}),
        }),
      );
  }

  catalog() {
    return [...this.adapters.values()].map((adapter) => ({
      id: adapter.id,
      serviceName: adapter.serviceName,
      origin: adapter.origin,
      fields: adapter.fields,
    }));
  }

  async request(
    owner: string,
    input: { taskId: string; revision: number; adapterId: string; purpose: string },
  ) {
    const adapter = await this.resolveAdapter(owner, input.adapterId);
    if (!input.purpose.trim() || input.purpose.length > 400)
      throw new AppError("Describe why this service is needed", 422);
    const task = await this.db.get<AgentTask>(owner, "tasks", input.taskId);
    if (!task) throw new AppError("Task not found", 404);
    if (task.attempts !== input.revision)
      throw new AppError("This task revision is no longer current", 409);
    if (!["running", "waiting_input"].includes(task.status))
      throw new AppError("This task is no longer waiting for a connection", 409);
    const id = stableId(`${input.taskId}\n${input.revision}\n${input.adapterId}`);
    const previous = await this.db.get<CredentialRequestRecord>(owner, "credential-requests", id);
    if (previous) {
      if (previous.purpose !== input.purpose)
        throw new AppError(
          "A different connection request already exists for this task revision",
          409,
        );
      return this.interaction(owner, previous);
    }
    const timestamp = new Date(this.now()).toISOString();
    const record: CredentialRequestRecord = {
      id,
      taskId: input.taskId,
      revision: input.revision,
      ...(task.originThreadId ? { threadId: task.originThreadId } : {}),
      adapterId: adapter.id,
      purpose: input.purpose.trim(),
      credentialRefId: randomUUID(),
      status: "waiting",
      createdAt: timestamp,
      expiresAt: new Date(this.now() + (this.options.requestTtlMs ?? 10 * 60_000)).toISOString(),
    };
    const request = this.card(adapter, record);
    const result = await this.db.durableMutation<CredentialRequestRecord | InteractionRequest>(
      owner,
      `credential-request:${id}`,
      bindingHash({
        taskId: input.taskId,
        revision: input.revision,
        adapterId: adapter.id,
        purpose: record.purpose,
      }),
      [
        { kind: "credential-requests", id, mode: "insert", value: record },
        { kind: "interaction-requests", id, mode: "insert", value: request },
      ],
      record.threadId
        ? [
            {
              id: `credential-request:${id}`,
              threadId: record.threadId,
              origin: "task",
              kind: "interaction",
              payload: request,
            },
          ]
        : [],
    );
    if (result.status === "thread_deleted")
      throw new AppError("This conversation was deleted", 410);
    if (result.status === "binding_conflict")
      throw new AppError("A different connection request already exists", 409);
    if (result.status === "revision_conflict") {
      const existing = await this.db.get<CredentialRequestRecord>(owner, "credential-requests", id);
      if (!existing) throw new AppError("The task changed; reopen its connection card", 409);
      return this.interaction(owner, existing);
    }
    return result.values[1] as InteractionRequest;
  }

  private card(
    adapter: ValidCredentialAdapter,
    record: CredentialRequestRecord,
  ): InteractionRequest {
    const schema: CredentialFormSchema = {
      title: `Connect ${adapter.serviceName}`,
      serviceName: adapter.serviceName,
      origin: adapter.origin,
      purpose: record.purpose,
      fields: adapter.fields,
    };
    return {
      id: record.id,
      taskId: record.taskId,
      revision: record.revision,
      ...(record.threadId ? { threadId: record.threadId } : {}),
      kind: "credential",
      schema,
      status: record.status,
      createdAt: record.createdAt,
      ...(record.credentialRef ? { credentialRef: record.credentialRef } : {}),
      ...(record.challengeId ? { challengeId: record.challengeId } : {}),
      ...(record.challengeKind ? { challengeKind: record.challengeKind } : {}),
    } as InteractionRequest;
  }

  private async interaction(owner: string, record: CredentialRequestRecord) {
    const existing = await this.db.get<InteractionRequest>(
      owner,
      "interaction-requests",
      record.id,
    );
    if (existing) return existing;
    return this.card(await this.resolveAdapter(owner, record.adapterId), record);
  }

  async status(owner: string, id: string) {
    const record = await this.db.get<CredentialRequestRecord>(owner, "credential-requests", id);
    if (!record) throw new AppError("Credential request not found", 404);
    if (record.status === "waiting" && Date.parse(record.expiresAt) <= this.now()) {
      const expired = await this.db.compareAndSwap<CredentialRequestRecord>(
        owner,
        "credential-requests",
        id,
        { status: "waiting" },
        { status: "expired" },
      );
      if (expired) {
        await this.db.compareAndSwap(
          owner,
          "interaction-requests",
          id,
          { status: "waiting" },
          { status: "expired" },
        );
        return this.card(await this.resolveAdapter(owner, record.adapterId), expired);
      }
    }
    return this.interaction(owner, record);
  }

  async cancel(owner: string, id: string) {
    const record = await this.db.get<CredentialRequestRecord>(owner, "credential-requests", id);
    if (!record) throw new AppError("Credential request not found", 404);
    if (record.status === "cancelled") return this.status(owner, id);
    if (!["waiting", "needs_challenge"].includes(record.status))
      throw new AppError("This connection is already being processed", 409);
    const task = await this.db.get<AgentTask>(owner, "tasks", record.taskId);
    if (
      task?.status !== "waiting_input" ||
      (record.status === "waiting" && task.attempts !== record.revision) ||
      task.state.interactionRequestId !== id ||
      (record.status === "needs_challenge" &&
        task.state.credentialChallengeId !== record.challengeId)
    )
      throw new AppError("This task changed; open its current request", 409);
    const challenge = record.challengeId
      ? await this.db.get<CredentialChallenge>(owner, "credential-challenges", record.challengeId)
      : undefined;
    if (
      record.status === "needs_challenge" &&
      (challenge?.status !== "waiting" || challenge.taskId !== task.id)
    )
      throw new AppError("This verification step changed", 409);
    const interaction = this.card(await this.resolveAdapter(owner, record.adapterId), {
      ...record,
      status: "cancelled",
    });
    const result = await this.db.durableMutation(
      owner,
      `credential-cancel:${id}`,
      bindingHash({ id, taskId: task.id, revision: record.revision }),
      [
        {
          kind: "credential-requests",
          id,
          mode: "merge",
          expected: { status: record.status },
          value: { status: "cancelled" },
        },
        {
          kind: "interaction-requests",
          id,
          mode: "replace",
          expected: { status: record.status },
          value: interaction,
        },
        ...(challenge
          ? [
              {
                kind: "credential-challenges",
                id: challenge.id,
                mode: "merge" as const,
                expected: { status: "waiting" },
                value: { status: "superseded" },
              },
            ]
          : []),
        {
          kind: "tasks",
          id: task.id,
          mode: "merge",
          expected: { status: task.status, attempts: task.attempts, state: task.state },
          value: {
            status: "cancelled",
            leaseId: null,
            leaseUntil: null,
            question: null,
            updatedAt: nowIso(),
            state: { ...task.state, credentialStatus: "cancelled" },
          },
        },
      ],
      record.threadId
        ? [
            {
              id: `credential-cancel:${id}`,
              threadId: record.threadId,
              origin: "user",
              kind: "interaction",
              payload: interaction,
            },
          ]
        : [],
    );
    if (!["applied", "duplicate"].includes(result.status))
      throw new AppError("This connection request changed", 409);
    this.grantInvalidator?.(owner, record.credentialRefId);
    return interaction;
  }

  private validateValues(adapter: ValidCredentialAdapter, raw: unknown) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new AppError("Enter the requested connection fields", 422);
    const values = raw as Record<string, unknown>;
    const declared = new Set(adapter.fields.map((field) => field.id));
    if (Object.keys(values).some((key) => !declared.has(key)))
      throw new AppError("This form contains an unsupported field", 422);
    const data: Record<string, string> = {};
    for (const field of adapter.fields) {
      const value = values[field.id];
      if (value === undefined && !field.required) continue;
      if (typeof value !== "string" || value.length > 4096 || (field.required && !value.trim()))
        throw new AppError(`Enter ${field.label}`, 422);
      data[field.id] = value;
    }
    return data;
  }

  async submit(owner: string, id: string, input: { clientResponseId: string; values: unknown }) {
    const record = await this.db.get<CredentialRequestRecord>(owner, "credential-requests", id);
    if (!record) throw new AppError("Credential request not found", 404);
    if (record.status === "saved" && record.clientResponseId === input.clientResponseId)
      return (await this.status(owner, id)) as InteractionRequest;
    if (
      record.status !== "waiting" &&
      record.status !== "saving" &&
      record.status !== "outcome_unknown"
    )
      throw new AppError("This credential request is no longer open", 409);
    if (Date.parse(record.expiresAt) <= this.now()) {
      await this.status(owner, id);
      throw new AppError("This credential request expired; reopen it to continue", 409);
    }
    const task = await this.db.get<AgentTask>(owner, "tasks", record.taskId);
    if (!task || task.attempts !== record.revision || task.status !== "waiting_input") {
      await this.db.compareAndSwap(
        owner,
        "credential-requests",
        id,
        { status: record.status },
        { status: "superseded" },
      );
      await this.db.compareAndSwap(
        owner,
        "interaction-requests",
        id,
        { status: record.status },
        { status: "superseded" },
      );
      throw new AppError("This task changed; reopen the latest connection card", 409);
    }
    if (task.state.interactionRequestId !== id)
      throw new AppError("Wait for this task to pause before saving the connection", 409);
    const adapter = await this.resolveAdapter(owner, record.adapterId);
    const data = this.validateValues(adapter, input.values);
    if (record.status === "waiting") {
      const saving = await this.db.compareAndSwap<CredentialRequestRecord>(
        owner,
        "credential-requests",
        id,
        { status: "waiting" },
        { status: "saving", clientResponseId: input.clientResponseId },
      );
      if (!saving) throw new AppError("This credential request changed; reopen the card", 409);
    } else if (record.clientResponseId !== input.clientResponseId) {
      throw new AppError("This credential request is already being saved", 409);
    } else if (record.status === "outcome_unknown") {
      const saving = await this.db.compareAndSwap<CredentialRequestRecord>(
        owner,
        "credential-requests",
        id,
        { status: "outcome_unknown", clientResponseId: input.clientResponseId },
        { status: "saving" },
      );
      if (!saving) throw new AppError("This credential request changed; reopen the card", 409);
    }
    const prior = await this.secretStore.read(owner, record.credentialRefId);
    let version: number;
    if (prior) {
      if (!equalData(prior.data, data))
        throw new AppError(
          "The original save is still being confirmed; reopen this card if needed",
          409,
        );
      version = prior.version;
    } else {
      try {
        version = await this.secretStore.write(owner, record.credentialRefId, data, 0);
      } catch {
        const confirmed = await this.secretStore
          .read(owner, record.credentialRefId)
          .catch(() => null);
        if (!confirmed || !equalData(confirmed.data, data)) {
          await this.db.compareAndSwap(
            owner,
            "credential-requests",
            id,
            { status: "saving" },
            { status: "outcome_unknown" },
          );
          await this.db.compareAndSwap(
            owner,
            "interaction-requests",
            id,
            { status: "waiting" },
            { status: "outcome_unknown" },
          );
          throw new AppError(
            "The vault could not confirm this save. Reconcile the request before retrying.",
            409,
            "CREDENTIAL_OUTCOME_UNKNOWN",
          );
        }
        version = confirmed.version;
      }
    }
    return this.finishSave(owner, record, adapter, task, version, input.clientResponseId);
  }

  private async finishSave(
    owner: string,
    record: CredentialRequestRecord,
    adapter: ValidCredentialAdapter,
    task: AgentTask,
    version: number,
    clientResponseId: string,
  ) {
    const timestamp = new Date(this.now()).toISOString();
    const credentialRef: CredentialRef = { id: record.credentialRefId, version };
    const connection: CredentialConnection = {
      id: credentialRef.id,
      adapterId: adapter.id,
      serviceName: adapter.serviceName,
      origin: adapter.origin,
      credentialRef,
      status: "saved",
      updatedAt: timestamp,
    };
    const savedRecord: CredentialRequestRecord = {
      ...record,
      status: "saved",
      clientResponseId,
      credentialRef,
    };
    const interaction = this.card(adapter, savedRecord);
    const mutations = [
      {
        kind: "credential-requests",
        id: record.id,
        mode: "replace" as const,
        expected: { status: "saving", clientResponseId },
        value: savedRecord,
      },
      {
        kind: "interaction-requests",
        id: record.id,
        mode: "replace" as const,
        expected: { status: "waiting" },
        value: interaction,
      },
      { kind: "credentials", id: credentialRef.id, mode: "insert" as const, value: connection },
      {
        kind: "tasks",
        id: task.id,
        mode: "merge" as const,
        expected: { status: task.status, attempts: record.revision, state: task.state },
        value: {
          status: "queued",
          question: null,
          state: {
            ...task.state,
            credentialRef,
            credentialStatus: "saved" satisfies CredentialStatus,
            interactionRequestId: record.id,
          },
          updatedAt: timestamp,
        },
      },
    ];
    const threadId = record.threadId;
    const result = await this.db.durableMutation<
      CredentialRequestRecord | InteractionRequest | CredentialConnection | AgentTask
    >(
      owner,
      `credential-save:${clientResponseId}`,
      bindingHash({ requestId: record.id, clientResponseId, version }),
      mutations,
      threadId
        ? [
            {
              id: `credential-saved:${record.id}:${clientResponseId}`,
              threadId,
              origin: "user",
              kind: "interaction",
              payload: interaction,
            },
          ]
        : [],
    );
    if (result.status === "thread_deleted")
      throw new AppError("This conversation was deleted", 410);
    if (result.status === "binding_conflict")
      throw new AppError("This response ID already belongs to another credential save", 409);
    if (result.status === "revision_conflict") {
      const latest = await this.db.get<AgentTask>(owner, "tasks", task.id);
      if (
        latest?.attempts !== record.revision ||
        latest.status === "succeeded" ||
        latest.status === "cancelled"
      ) {
        await this.db.compareAndSwap(
          owner,
          "credential-requests",
          record.id,
          { status: "saving" },
          { status: "superseded", credentialRef },
        );
        await this.db.compareAndSwap(
          owner,
          "interaction-requests",
          record.id,
          { status: "waiting" },
          { status: "superseded", credentialRef },
        );
        await this.db.insertIfAbsent(owner, "credentials", connection);
        throw new AppError(
          "The credential was saved, but this task changed before it resumed",
          409,
        );
      }
      const duplicate = await this.db.get<CredentialRequestRecord>(
        owner,
        "credential-requests",
        record.id,
      );
      if (duplicate?.status === "saved") return this.status(owner, record.id);
      throw new AppError("The task changed while the credential was saved; reopen its card", 409);
    }
    return result.values[1] as InteractionRequest;
  }

  async getForTask(owner: string, taskId: string, refId: string) {
    const authorized = await this.authorizeForTask(owner, taskId, refId);
    const record = await this.secretStore.read(owner, refId);
    if (!record || record.version !== authorized.connection.credentialRef.version)
      throw new AppError("The saved credential is unavailable or was revoked", 409);
    return { ...authorized, values: record.data };
  }

  /** Validate ownership/reference without reading plaintext from the vault. */
  async authorizeForTask(owner: string, taskId: string, refId: string) {
    const task = await this.db.get<AgentTask>(owner, "tasks", taskId);
    if (!task || !this.referencesTask(task, refId))
      throw new AppError("This task is not authorized to use that connection", 403);
    const connection = await this.db.get<CredentialConnection>(owner, "credentials", refId);
    if (!connection) throw new AppError("Connection not found", 404);
    return { task, connection, adapter: await this.resolveAdapter(owner, connection.adapterId) };
  }

  private referencesTask(task: AgentTask, refId: string) {
    const ref = task.state.credentialRef;
    return Boolean(
      ref && typeof ref === "object" && !Array.isArray(ref) && (ref as CredentialRef).id === refId,
    );
  }

  /** A reused secret keeps its vault reference, but verification belongs to the
   * task and conversation that initiated this login, never its original card. */
  async bindTaskRequest(owner: string, taskId: string, refId: string) {
    const { task, connection, adapter } = await this.authorizeForTask(owner, taskId, refId);
    if (task.status !== "running") throw new AppError("This task is no longer active", 409);
    const existing = (await this.db.list<CredentialRequestRecord>(owner, "credential-requests"))
      .filter(
        (request) =>
          request.taskId === taskId &&
          request.credentialRefId === refId &&
          !["superseded", "cancelled", "expired"].includes(request.status),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (existing) return this.card(adapter, existing);
    const timestamp = new Date(this.now()).toISOString();
    const id = stableId(`credential-use\n${taskId}\n${task.attempts}\n${refId}`);
    const record: CredentialRequestRecord = {
      id,
      taskId,
      revision: task.attempts,
      ...(task.originThreadId ? { threadId: task.originThreadId } : {}),
      adapterId: adapter.id,
      purpose: `Sign in to ${adapter.serviceName} to continue the original task.`,
      credentialRefId: refId,
      credentialRef: connection.credentialRef,
      status: connection.status,
      createdAt: timestamp,
      expiresAt: new Date(this.now() + (this.options.requestTtlMs ?? 10 * 60_000)).toISOString(),
    };
    const interaction = this.card(adapter, record);
    const result = await this.db.durableMutation<CredentialRequestRecord | InteractionRequest>(
      owner,
      `credential-use:${id}`,
      bindingHash({ taskId, refId, revision: task.attempts }),
      [
        { kind: "credential-requests", id, mode: "insert", value: record },
        { kind: "interaction-requests", id, mode: "insert", value: interaction },
      ],
      [],
    );
    if (result.status === "thread_deleted")
      throw new AppError("This conversation was deleted", 410);
    if (!["applied", "duplicate"].includes(result.status))
      throw new AppError("This login request changed before verification", 409);
    return result.values[1] as InteractionRequest;
  }

  async setConnectionStatus(
    owner: string,
    id: string,
    status: CredentialStatus,
    details: {
      taskId?: string;
      challengeId?: string;
      challengeKind?: CredentialConnection["challengeKind"];
      authenticatedAt?: string;
    } = {},
  ) {
    const current = await this.db.get<CredentialConnection>(owner, "credentials", id);
    if (!current) throw new AppError("Connection not found", 404);
    const updated: CredentialConnection = {
      ...current,
      status,
      updatedAt: new Date(this.now()).toISOString(),
      ...(details.challengeId ? { challengeId: details.challengeId } : { challengeId: undefined }),
      ...(details.challengeKind
        ? { challengeKind: details.challengeKind }
        : { challengeKind: undefined }),
      ...(details.authenticatedAt ? { lastAuthenticatedAt: details.authenticatedAt } : {}),
    };
    await this.db.put(owner, "credentials", updated);
    const challenge = details.challengeId
      ? await this.db.get<CredentialChallenge>(owner, "credential-challenges", details.challengeId)
      : undefined;
    const taskId = details.taskId ?? challenge?.taskId;
    const request = (await this.db.list<CredentialRequestRecord>(owner, "credential-requests"))
      .filter(
        (value) =>
          value.credentialRefId === id &&
          !["superseded", "cancelled", "expired"].includes(value.status) &&
          (!taskId || value.taskId === taskId),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (request) {
      const requestStatus = status === "saved" ? "saved" : status;
      const revised = {
        ...request,
        status: requestStatus,
        ...(details.challengeId
          ? { challengeId: details.challengeId }
          : { challengeId: undefined }),
        ...(details.challengeKind
          ? { challengeKind: details.challengeKind }
          : { challengeKind: undefined }),
      } satisfies CredentialRequestRecord;
      await this.db.put(owner, "credential-requests", revised);
      const interaction = this.card(await this.resolveAdapter(owner, request.adapterId), revised);
      await this.db.put(owner, "interaction-requests", interaction);
      if (request.threadId && request.status !== requestStatus) {
        await this.db.appendConversationEvent(owner, {
          id: `credential-status:${request.id}:${requestStatus}:${this.now()}`,
          threadId: request.threadId,
          origin: "task",
          kind: "interaction",
          payload: interaction,
        });
      }
    }
    return updated;
  }

  async connection(owner: string, id: string) {
    const connection = (await this.connections(owner)).find((row) => row.id === id);
    if (!connection) throw new AppError("Connection not found", 404);
    return connection;
  }

  async recordBrowserBinding(
    owner: string,
    id: string,
    input: Omit<
      CredentialBrowserBinding,
      "id" | "credentialRefId" | "accountId" | "adapterId" | "origin"
    >,
  ) {
    const connection = await this.connection(owner, id);
    if (
      !input.executorId ||
      input.executorId.length > 80 ||
      !input.profileId ||
      input.profileId.length > 200 ||
      !input.sessionId ||
      input.sessionId.length > 200 ||
      (input.sessionGeneration !== undefined && !/^[\w:-]{1,200}$/.test(input.sessionGeneration)) ||
      !Number.isFinite(Date.parse(input.authenticatedAt))
    )
      throw new AppError("Authenticated browser binding is invalid", 422);
    const bindingKey = createHash("sha256")
      .update(
        `${id}\n${input.executorId}\n${input.profileId}\n${input.sessionId}\n${input.sessionGeneration ?? ""}`,
      )
      .digest("hex");
    const binding: CredentialBrowserBinding = {
      id: bindingKey,
      credentialRefId: id,
      accountId: id,
      adapterId: connection.adapterId,
      origin: connection.origin,
      ...input,
    };
    await this.db.put(owner, "credential-browser-bindings", binding);
    return binding;
  }

  async browserBindings(owner: string, id: string) {
    await this.connection(owner, id);
    return (await this.db.list<CredentialBrowserBinding>(owner, "credential-browser-bindings"))
      .filter((binding) => binding.credentialRefId === id)
      .sort((left, right) => right.authenticatedAt.localeCompare(left.authenticatedAt));
  }

  async browserBinding(
    owner: string,
    id: string,
    target: {
      executorId: string;
      profileId: string;
      sessionId: string;
      sessionGeneration?: string;
    },
  ) {
    return (await this.browserBindings(owner, id)).find(
      (binding) =>
        binding.executorId === target.executorId &&
        binding.profileId === target.profileId &&
        binding.sessionId === target.sessionId &&
        binding.sessionGeneration === target.sessionGeneration,
    );
  }

  async getChallenge(owner: string, taskId: string, refId: string, challengeId: string) {
    const challenge = await this.db.get<import("./contracts.ts").CredentialChallenge>(
      owner,
      "credential-challenges",
      challengeId,
    );
    if (!challenge || challenge.taskId !== taskId || challenge.credentialRefId !== refId)
      throw new AppError("Credential challenge not found for this task", 404);
    if (challenge.status !== "waiting" || Date.parse(challenge.expiresAt) <= this.now())
      throw new AppError("Credential challenge is no longer open", 409);
    return challenge;
  }

  async revoke(owner: string, id: string) {
    const current = await this.db.get<CredentialConnection>(owner, "credentials", id);
    if (!current) throw new AppError("Connection not found", 404);
    await this.secretStore.delete(owner, id, current.credentialRef.version);
    await this.db.remove(owner, "credentials", id);
    this.grantInvalidator?.(owner, id);
    return { revoked: true, browserSessionRevoked: false };
  }
}
