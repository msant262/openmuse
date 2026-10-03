import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Hono } from "hono";
import { z } from "zod";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type { CredentialInteractionRequest } from "../../../../packages/domain/src/runtime.ts";
import { type Resolver, validatePublicUrl } from "../../../worker/src/network.ts";
import { configuredSecretScrubber } from "../configured-secrets.ts";
import { bindingHash } from "../conversation-inbox.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { SecretStore } from "./contracts.ts";
import {
  authenticationBindings,
  type CredentialHttpInput,
  type CredentialHttpResult,
  type CredentialSpecification,
  credentialHttpRequestSchema,
  type GenericCredentialContext,
  type GenericCredentialInput,
  genericCredentialRequestSchema,
  type ServiceCredential,
  type ServiceCredentialRequest,
} from "./generic-contracts.ts";
import { type CredentialTransport, requestCredentialEndpoint } from "./generic-transport.ts";

const requestsKind = "service-credential-requests";
const connectionsKind = "service-credentials";
const same = (left: unknown, right: unknown) => bindingHash(left) === bindingHash(right);
const reference = (task: AgentTask) =>
  task.state.serviceCredentialRef as { id?: string; version?: number } | undefined;

/** Runtime service credentials use the existing private vault. Only their exact
 * destination, field bindings and opaque references enter the agent's context. */
export class GenericCredentials {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(
    private readonly db: Store,
    private readonly vault: SecretStore,
    private readonly options: {
      available: boolean;
      now?: () => number;
      requestTtlMs?: number;
      resolve?: Resolver;
      request?: CredentialTransport;
    },
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private available() {
    if (!this.options.available)
      throw new AppError("The credential vault is unavailable", 503, "VAULT_UNAVAILABLE");
  }
  private serial<T>(owner: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(owner) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.queues.set(owner, next);
    return next.finally(() => {
      if (this.queues.get(owner) === next) this.queues.delete(owner);
    });
  }
  async list(owner: string) {
    return (await this.db.list<ServiceCredential>(owner, connectionsKind)).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }
  async metadata(owner: string, id: string) {
    const connection = await this.db.get<ServiceCredential>(owner, connectionsKind, id);
    if (!connection) throw new AppError("Saved connection not found", 404);
    return connection;
  }
  async findByOrigin(owner: string, origin: string) {
    return (await this.list(owner)).find(
      (item) => item.origin === origin && item.status === "saved",
    );
  }
  async findReusable(owner: string, raw: GenericCredentialInput) {
    const input = genericCredentialRequestSchema.parse(raw);
    if (input.replace) return undefined;
    return (await this.list(owner)).find(
      (item) =>
        item.status === "saved" &&
        item.origin === input.origin &&
        same(item.authentication, input.authentication) &&
        same(item.fields, input.fields),
    );
  }
  async request(owner: string, raw: GenericCredentialInput, context: GenericCredentialContext) {
    return this.createRequest(owner, raw, context);
  }
  async reconnect(owner: string, id: string, context: GenericCredentialContext) {
    const connection = await this.metadata(owner, id);
    const { serviceName, origin, purpose, fields, authentication } = connection;
    return this.createRequest(
      owner,
      { serviceName, origin, purpose, fields, authentication, replace: true },
      context,
      id,
    );
  }
  private async createRequest(
    owner: string,
    raw: GenericCredentialInput,
    context: GenericCredentialContext,
    replacesCredentialId?: string,
  ) {
    this.available();
    const { replace, ...specification } = genericCredentialRequestSchema.parse(raw);
    await validatePublicUrl(specification.origin, this.options.resolve);
    return this.serial(owner, async () => {
      if (replace && !replacesCredentialId) {
        const previous = (await this.list(owner)).find(
          (connection) =>
            connection.status !== "revoked" &&
            connection.origin === specification.origin &&
            same(connection.authentication, specification.authentication) &&
            same(connection.fields, specification.fields),
        );
        replacesCredentialId = previous?.id;
      }
      let task = context.taskSeed;
      if (task && (context.taskId || context.revision !== undefined))
        throw new AppError("Choose one task context", 422);
      if (!task && context.taskId)
        task = (await this.db.get<AgentTask>(owner, "tasks", context.taskId)) ?? undefined;
      if (!task) throw new AppError("A credential request needs its original task", 404);
      if (context.revision !== undefined && task.attempts !== context.revision)
        throw new AppError("This task revision changed", 409);
      if (!["running", "waiting_input"].includes(task.status))
        throw new AppError("The task is no longer waiting for a connection", 409);
      const threadId = context.threadId ?? task.originThreadId;
      if (threadId) {
        const thread = await this.db.get<{ deletedAt?: string }>(owner, "threads", threadId);
        if (!thread || thread.deletedAt) throw new AppError("Conversation not found", 404);
      }
      const existing = (await this.db.list<ServiceCredentialRequest>(owner, requestsKind)).find(
        (item) =>
          item.interaction.taskId === task?.id &&
          item.interaction.revision === task?.attempts &&
          item.interaction.status === "waiting" &&
          Date.parse(item.expiresAt) > this.now() &&
          item.specification.origin === specification.origin &&
          same(item.specification.authentication, specification.authentication) &&
          same(item.specification.fields, specification.fields),
      );
      if (existing) return existing.interaction;
      // One live request per task avoids stacking multiple prompts in one turn.
      const pending = (await this.db.list<ServiceCredentialRequest>(owner, requestsKind)).find(
        (item) =>
          item.interaction.taskId === task?.id &&
          item.interaction.revision === task?.attempts &&
          item.interaction.status === "waiting" &&
          Date.parse(item.expiresAt) > this.now(),
      );
      if (pending) return pending.interaction;
      const id = randomUUID();
      const timestamp = new Date(this.now()).toISOString();
      const interaction: CredentialInteractionRequest = {
        id,
        taskId: task.id,
        revision: task.attempts,
        ...(threadId ? { threadId } : {}),
        kind: "credential",
        status: "waiting",
        createdAt: timestamp,
        schema: {
          credentialKind: "api",
          title: `Connect ${specification.serviceName}`,
          serviceName: specification.serviceName,
          origin: specification.origin,
          purpose: specification.purpose,
          fields: specification.fields,
        },
      };
      const record: ServiceCredentialRequest = {
        id,
        specification,
        credentialRefId: randomUUID(),
        ...(replacesCredentialId ? { replacesCredentialId } : {}),
        expiresAt: new Date(this.now() + (this.options.requestTtlMs ?? 30 * 60_000)).toISOString(),
        interaction,
      };
      const mutations: Parameters<Store["durableMutation"]>[3] = [
        { kind: requestsKind, id, mode: "insert", value: record },
        { kind: "interaction-requests", id, mode: "insert", value: interaction },
      ];
      if (context.taskSeed)
        mutations.unshift({
          kind: "tasks",
          id: task.id,
          mode: "insert",
          value: {
            ...task,
            status: "waiting_input",
            question: `Connect ${specification.serviceName} using the secure form.`,
            state: { ...task.state, interactionRequestId: id, serviceCredentialRequestId: id },
            updatedAt: timestamp,
          },
        });
      const result = await this.db.durableMutation(
        owner,
        `service-credential-request:${id}`,
        bindingHash({ id, specification, taskId: task.id }),
        mutations,
        threadId
          ? [
              {
                id: `service-credential-request:${id}`,
                threadId,
                origin: "task",
                kind: "interaction",
                payload: interaction,
              },
            ]
          : [],
      );
      if (!["applied", "duplicate"].includes(result.status))
        throw new AppError("The credential request changed. Try again.", 409);
      return interaction;
    });
  }
  private async record(owner: string, id: string) {
    const record = await this.db.get<ServiceCredentialRequest>(owner, requestsKind, id);
    if (!record) throw new AppError("Credential request not found", 404);
    return record;
  }
  private async transition(
    owner: string,
    record: ServiceCredentialRequest,
    status: CredentialInteractionRequest["status"],
  ) {
    const interaction = { ...record.interaction, status };
    const result = await this.db.durableMutation(
      owner,
      `service-credential-status:${record.id}:${status}`,
      bindingHash({ id: record.id, status }),
      [
        {
          kind: requestsKind,
          id: record.id,
          mode: "replace",
          expected: { interaction: record.interaction },
          value: { ...record, interaction },
        },
        {
          kind: "interaction-requests",
          id: record.id,
          mode: "replace",
          expected: { status: record.interaction.status },
          value: interaction,
        },
      ],
      interaction.threadId
        ? [
            {
              id: `service-credential-status:${record.id}:${status}`,
              threadId: interaction.threadId,
              origin: "task",
              kind: "interaction",
              payload: interaction,
            },
          ]
        : [],
    );
    return ["applied", "duplicate"].includes(result.status)
      ? interaction
      : (await this.record(owner, record.id)).interaction;
  }
  async status(owner: string, id: string) {
    const record = await this.record(owner, id);
    if (record.interaction.status !== "waiting") return record.interaction;
    if (Date.parse(record.expiresAt) <= this.now())
      return this.transition(owner, record, "expired");
    const task = await this.db.get<AgentTask>(owner, "tasks", record.interaction.taskId);
    if (
      !task ||
      task.attempts !== record.interaction.revision ||
      !["running", "waiting_input"].includes(task.status)
    )
      return this.transition(owner, record, "superseded");
    return record.interaction;
  }
  async pending(owner: string) {
    const records = await this.db.list<ServiceCredentialRequest>(owner, requestsKind);
    const current = await Promise.all(
      records
        .filter((item) => item.interaction.status === "waiting")
        .map((item) => this.status(owner, item.id)),
    );
    return current
      .filter((item) => item.status === "waiting")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  private values(specification: CredentialSpecification, raw: unknown) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new AppError("Enter the requested secure fields", 422);
    const values = raw as Record<string, unknown>;
    if (Object.keys(values).some((id) => !specification.fields.some((field) => field.id === id)))
      throw new AppError("The form contains an unsupported field", 422);
    const data: Record<string, string> = {};
    for (const field of specification.fields) {
      const value = values[field.id];
      if (value === undefined && !field.required) continue;
      if (
        typeof value !== "string" ||
        value.length > 8192 ||
        (field.required && !value.trim()) ||
        /[\r\n]/.test(value) ||
        value.includes(String.fromCharCode(0))
      )
        throw new AppError("Check the requested secure fields", 422);
      data[field.id] = value;
    }
    return data;
  }
  async submit(owner: string, id: string, input: { clientResponseId: string; values: unknown }) {
    this.available();
    return this.serial(owner, async () => {
      const record = await this.record(owner, id);
      if (
        record.clientResponseId === input.clientResponseId &&
        record.interaction.status === "saved"
      )
        return record.interaction;
      if (record.interaction.status !== "waiting" || Date.parse(record.expiresAt) <= this.now())
        throw new AppError("This secure form expired or was already completed", 409);
      let task = await this.db.get<AgentTask>(owner, "tasks", record.interaction.taskId);
      // A task tool may have published its card milliseconds before the worker commits its pause.
      for (
        let attempt = 0;
        task?.status === "running" && task.attempts === record.interaction.revision && attempt < 60;
        attempt++
      ) {
        await sleep(50);
        task = await this.db.get<AgentTask>(owner, "tasks", record.interaction.taskId);
      }
      if (
        !task ||
        task.status !== "waiting_input" ||
        task.attempts !== record.interaction.revision ||
        task.state.interactionRequestId !== id
      )
        throw new AppError(
          "The task changed or is still preparing this form. Try again shortly.",
          409,
        );
      const data = this.values(record.specification, input.values);
      let version: number;
      try {
        const previous = await this.vault.read(owner, record.credentialRefId);
        if (previous) {
          if (!same(previous.data, data))
            throw new AppError(
              "The first save is still being confirmed. Retry with the same fields.",
              409,
            );
          version = previous.version;
        } else {
          try {
            version = await this.vault.write(owner, record.credentialRefId, data, 0);
          } catch {
            const confirmed = await this.vault.read(owner, record.credentialRefId);
            if (!confirmed || !same(confirmed.data, data)) throw new Error("unconfirmed");
            version = confirmed.version;
          }
        }
      } catch (error) {
        if (error instanceof AppError && error.status === 409) throw error;
        throw new AppError(
          "The vault could not confirm the save. Retry this secure form.",
          503,
          "VAULT_UNAVAILABLE",
        );
      }
      const timestamp = new Date(this.now()).toISOString();
      const credentialRef = { id: record.credentialRefId, version };
      const interaction: CredentialInteractionRequest = {
        ...record.interaction,
        status: "saved",
        credentialRef,
        answeredAt: timestamp,
      };
      const connection: ServiceCredential = {
        ...record.specification,
        id: credentialRef.id,
        credentialRef,
        status: "saved",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const result = await this.db.durableMutation(
        owner,
        `service-credential-save:${id}:${input.clientResponseId}`,
        bindingHash({ id, response: input.clientResponseId, version }),
        [
          {
            kind: requestsKind,
            id,
            mode: "replace",
            expected: { interaction: record.interaction },
            value: { ...record, clientResponseId: input.clientResponseId, interaction },
          },
          {
            kind: "interaction-requests",
            id,
            mode: "replace",
            expected: { status: "waiting" },
            value: interaction,
          },
          { kind: connectionsKind, id: connection.id, mode: "insert", value: connection },
          {
            kind: "tasks",
            id: task.id,
            mode: "merge",
            expected: {
              status: "waiting_input",
              attempts: record.interaction.revision,
              state: task.state,
            },
            value: {
              status: "queued",
              question: null,
              updatedAt: timestamp,
              state: {
                ...task.state,
                serviceCredentialRef: credentialRef,
                serviceCredentialStatus: "saved",
              },
            },
          },
        ],
        interaction.threadId
          ? [
              {
                id: `service-credential-saved:${id}`,
                threadId: interaction.threadId,
                origin: "user",
                kind: "interaction",
                payload: interaction,
              },
            ]
          : [],
      );
      if (!["applied", "duplicate"].includes(result.status)) {
        await this.vault.delete(owner, record.credentialRefId).catch(() => {});
        throw new AppError(
          "The task changed before this credential could be attached. Reopen its secure form.",
          409,
        );
      }
      if (record.replacesCredentialId && record.replacesCredentialId !== connection.id)
        await this.revokeRecord(owner, record.replacesCredentialId);
      return interaction;
    });
  }
  async cancel(owner: string, id: string) {
    return this.serial(owner, async () => {
      const record = await this.record(owner, id);
      if (record.interaction.status !== "waiting") return record.interaction;
      const interaction = await this.transition(owner, record, "cancelled");
      const task = await this.db.get<AgentTask>(owner, "tasks", record.interaction.taskId);
      if (
        task &&
        ["running", "waiting_input"].includes(task.status) &&
        task.attempts === record.interaction.revision &&
        (task.status === "running" || task.state.interactionRequestId === id)
      )
        await this.db.compareAndSwap(
          owner,
          "tasks",
          task.id,
          { status: task.status, attempts: task.attempts, state: task.state },
          {
            status: "cancelled",
            leaseId: null,
            leaseUntil: null,
            question: null,
            result: "Credential request cancelled.",
            updatedAt: new Date(this.now()).toISOString(),
          },
        );
      return interaction;
    });
  }
  private async revokeRecord(owner: string, id: string) {
    const connection = await this.metadata(owner, id);
    if (connection.status !== "revoked") {
      await this.vault.delete(owner, id);
      await this.db.put(owner, connectionsKind, {
        ...connection,
        status: "revoked",
        updatedAt: new Date(this.now()).toISOString(),
      });
    }
    return { ...connection, status: "revoked" as const };
  }
  async revoke(owner: string, id: string) {
    this.available();
    return this.serial(owner, () => this.revokeRecord(owner, id));
  }
  async httpRequest(
    owner: string,
    raw: CredentialHttpInput,
    context: { taskId: string; signal?: AbortSignal; beforeDispatch?: () => Promise<void> },
  ): Promise<CredentialHttpResult> {
    this.available();
    const input = credentialHttpRequestSchema.parse(raw);
    const connection = await this.metadata(owner, input.credentialId);
    if (connection.status !== "saved")
      throw new AppError(
        "This credential needs to be entered again",
        409,
        "CREDENTIAL_RECONNECT_REQUIRED",
      );
    const task = await this.db.get<AgentTask>(owner, "tasks", context.taskId);
    const ref = task && reference(task);
    if (
      !task ||
      !(
        task.status === "running" ||
        (task.status === "waiting_approval" && context.beforeDispatch)
      ) ||
      ref?.id !== connection.id ||
      ref.version !== connection.credentialRef.version
    )
      throw new AppError("This task is not authorized to use that saved connection", 403);
    return this.dispatch(owner, input, connection, context);
  }
  async httpForOrigin(
    owner: string,
    origin: string,
    input: Omit<CredentialHttpInput, "credentialId">,
    context: { signal?: AbortSignal; beforeDispatch?: () => Promise<void> } = {},
  ) {
    this.available();
    const connection = await this.findByOrigin(owner, origin);
    if (!connection) return null;
    return this.dispatch(
      owner,
      credentialHttpRequestSchema.parse({ ...input, credentialId: connection.id }),
      connection,
      context,
    );
  }
  private async dispatch(
    owner: string,
    input: z.output<typeof credentialHttpRequestSchema>,
    connection: ServiceCredential,
    context: { signal?: AbortSignal; beforeDispatch?: () => Promise<void> },
  ): Promise<CredentialHttpResult> {
    const url = new URL(input.path, `${connection.origin}/`);
    if (
      url.origin !== connection.origin ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new AppError(
        "Credentials can only be used at the destination shown in their secure form",
        422,
        "CREDENTIAL_ORIGIN_MISMATCH",
      );
    const target = await validatePublicUrl(url.href, this.options.resolve);
    context.signal?.throwIfAborted();
    const secret = await this.vault.read(owner, connection.id).catch(() => {
      throw new AppError(
        "The credential vault is temporarily unavailable",
        503,
        "VAULT_UNAVAILABLE",
      );
    });
    if (!secret || secret.version !== connection.credentialRef.version)
      return this.invalidCredential(owner, connection);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.headers ?? {})) {
      if (
        /^(authorization|proxy-authorization|cookie|x-api-key|api-key)$/i.test(key) ||
        authenticationBindings(connection.authentication).some(
          (auth) => auth.type === "header" && key.toLowerCase() === auth.headerName.toLowerCase(),
        )
      )
        throw new AppError("Authentication is supplied by the vault, never by tool arguments", 422);
      headers[key] = value;
    }
    let body = input.body;
    const injectedValues: string[] = [];
    for (const auth of authenticationBindings(connection.authentication)) {
      let injected = "";
      if (auth.type === "basic") {
        const username = secret.data[auth.usernameFieldId],
          password = secret.data[auth.passwordFieldId];
        if (username === undefined || password === undefined)
          return this.invalidCredential(owner, connection);
        injected = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
        headers.Authorization = injected;
      } else {
        const value = secret.data[auth.fieldId];
        if (!value) return this.invalidCredential(owner, connection);
        injected = value;
        if (auth.type === "bearer") headers.Authorization = `Bearer ${value}`;
        else if (auth.type === "header") headers[auth.headerName] = value;
        else if (auth.type === "query") target.url.searchParams.set(auth.parameterName, value);
        else {
          if (body !== undefined && (!body || typeof body !== "object" || Array.isArray(body)))
            throw new AppError("This credential requires a JSON object body", 422);
          body = { ...(body as Record<string, unknown> | undefined), [auth.propertyName]: value };
        }
      }
      injectedValues.push(injected);
    }
    if ((input.method === "GET" || input.method === "HEAD") && body !== undefined)
      throw new AppError("GET and HEAD requests cannot have a body", 422);
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized && Buffer.byteLength(serialized) > 256 * 1024)
      throw new AppError("The service request exceeds the size limit", 422);
    if (serialized) headers["Content-Type"] = "application/json";
    const scrub = configuredSecretScrubber(
      [...Object.values(secret.data), ...injectedValues].flatMap((value) => [
        value,
        encodeURIComponent(value),
        new URLSearchParams({ v: value }).toString().slice(2),
        JSON.stringify(value).slice(1, -1),
        Buffer.from(value).toString("base64"),
        Buffer.from(value).toString("base64url"),
      ]),
    );
    const signal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(context.signal ? [context.signal] : []),
    ]);
    await context.beforeDispatch?.();
    signal.throwIfAborted();
    const latest = await this.metadata(owner, connection.id);
    if (latest.status !== "saved" || !same(latest.credentialRef, connection.credentialRef))
      throw new AppError(
        "The saved credential was revoked or changed before dispatch",
        409,
        "CREDENTIAL_RECONNECT_REQUIRED",
      );
    let response: Awaited<ReturnType<CredentialTransport>>;
    try {
      response = await (this.options.request ?? requestCredentialEndpoint)(target, {
        method: input.method,
        headers,
        ...(serialized ? { body: serialized } : {}),
        signal,
      });
    } catch (error) {
      const failure =
        error instanceof AppError
          ? new AppError(scrub(error.message), error.status, error.code)
          : new AppError(
              "Could not complete the request to the saved credential destination",
              502,
              "CREDENTIAL_REQUEST_FAILED",
            );
      if (
        !["GET", "HEAD"].includes(input.method) &&
        !(input.method === "POST" && input.intent === "read")
      )
        Object.assign(failure, { outcomeUnknown: true });
      throw failure;
    }
    if (response.status >= 300 && response.status < 400) {
      const failure = new AppError(
        "The service redirected the request. Credentials were not forwarded.",
        502,
        "CREDENTIAL_REDIRECT_BLOCKED",
      );
      if (
        !["GET", "HEAD"].includes(input.method) &&
        !(input.method === "POST" && input.intent === "read")
      )
        Object.assign(failure, { outcomeUnknown: true });
      throw failure;
    }
    if ([401, 403].includes(response.status))
      await this.db.compareAndSwap(
        owner,
        connectionsKind,
        connection.id,
        { credentialRef: connection.credentialRef, status: "saved" },
        { status: "invalid_credentials", updatedAt: new Date(this.now()).toISOString() },
      );
    const ok = response.status >= 200 && response.status < 300;
    const cleanBody = ok
      ? scrub(response.body)
      : [401, 403].includes(response.status)
        ? "The service rejected this credential. Reconnect using the secure form."
        : `The service returned HTTP ${response.status}.`;
    return {
      status: response.status,
      ok,
      url: scrub(url.href),
      contentType: scrub(response.contentType).slice(0, 200),
      body: cleanBody.slice(0, 30000),
      truncated: cleanBody.length > 30000,
    };
  }
  private async invalidCredential(owner: string, connection: ServiceCredential): Promise<never> {
    await this.db.compareAndSwap(
      owner,
      connectionsKind,
      connection.id,
      { credentialRef: connection.credentialRef, status: "saved" },
      { status: "invalid_credentials", updatedAt: new Date(this.now()).toISOString() },
    );
    throw new AppError(
      "The saved credential is unavailable or incomplete. Reopen its secure form.",
      409,
      "CREDENTIAL_RECONNECT_REQUIRED",
    );
  }
  async authorizedFetch(
    owner: string,
    input: {
      credentialRefId: string;
      url: string;
      method?: CredentialHttpInput["method"];
      headers?: Record<string, string>;
      body?: unknown;
    },
    context: { taskId: string; signal?: AbortSignal; beforeDispatch?: () => Promise<void> },
  ) {
    const { credentialRefId, url, ...rest } = input;
    return this.httpRequest(owner, { ...rest, credentialId: credentialRefId, path: url }, context);
  }
}

export function genericCredentialRoutes(service: GenericCredentials) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/service-credentials", async (c) =>
    c.json({ connections: await service.list(c.get("owner")) }),
  );
  app.get("/service-credentials/requests/:id", async (c) =>
    c.json(await service.status(c.get("owner"), z.uuid().parse(c.req.param("id")))),
  );
  app.post("/service-credentials/requests/:id/submit", async (c) => {
    const input = z
      .object({
        clientResponseId: z
          .string()
          .min(8)
          .max(256)
          .regex(/^[\w.:-]+$/),
        values: z.record(z.string(), z.unknown()),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(await service.submit(c.get("owner"), z.uuid().parse(c.req.param("id")), input));
  });
  app.post("/service-credentials/requests/:id/cancel", async (c) =>
    c.json(await service.cancel(c.get("owner"), z.uuid().parse(c.req.param("id")))),
  );
  app.post("/service-credentials/:id/revoke", async (c) =>
    c.json(await service.revoke(c.get("owner"), z.uuid().parse(c.req.param("id")))),
  );
  return app;
}
