import { createHash, randomUUID } from "node:crypto";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type { CredentialInteractionRequest } from "../../../../packages/domain/src/runtime.ts";
import { configuredSecretScrubber, scrubConfiguredValue } from "../configured-secrets.ts";
import { bindingHash } from "../conversation-inbox.ts";
import type { SecretStore } from "../credentials/contracts.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import {
  type ComposioCategory,
  type ComposioConnection,
  type ComposioContext,
  type ComposioExecutionContext,
  type ComposioExecutionInput,
  type ComposioExecutionResult,
  type ComposioFlow,
  type ComposioFlowRecord,
  type ComposioRequestInput,
  type ComposioTool,
  type ComposioToolkit,
  composioCatalogSchema,
  composioRequestSchema,
  composioSlug,
} from "./contracts.ts";
import {
  type ComposioTransport,
  type ComposioTransportInput,
  composioTransport,
} from "./transport.ts";

const configKind = "composio-config";
const sessionKind = "composio-sessions";
const flowKind = "composio-flows";
const vaultId = "composio-platform-project-key";
const pendingStatuses = ["waiting", "expired", "error"];
type Config = { id: "platform"; keyVersion: number; updatedAt: string; invalid?: boolean };
type Session = {
  id: string;
  userId: string;
  keyVersion: number;
  scope: string;
  toolkits?: string[];
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown, max = 2000) =>
  typeof value === "string" ? value.slice(0, max) : "";
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((part): part is string => typeof part === "string") : [];
const items = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const https = (value: unknown) => {
  try {
    const url = new URL(string(value));
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
};
const category = (value: unknown): ComposioCategory => {
  const raw = object(value);
  return { id: string(raw.id ?? raw.slug, 120), name: string(raw.name, 160) };
};
function toolkit(value: unknown): ComposioToolkit {
  const raw = object(value);
  const meta = object(raw.meta);
  return {
    slug: composioSlug.parse(raw.slug),
    name: string(raw.name, 160),
    description: string(meta.description ?? raw.description, 4000),
    logo: https(meta.logo),
    categories: items(meta.categories)
      .map(category)
      .filter((part) => part.id && part.name),
    authSchemes: strings(raw.auth_schemes ?? raw.composio_managed_auth_schemes),
    noAuth: raw.no_auth === true || raw.is_no_auth === true || meta.isNoAuth === true,
    deprecated: raw.deprecated === true,
    authGuideUrl: https(raw.auth_guide_url),
    appUrl: https(meta.app_url ?? raw.app_url),
  };
}
function tool(value: unknown): ComposioTool {
  const raw = object(value);
  return {
    slug: composioSlug.parse(raw.slug),
    toolkit: composioSlug.parse(object(raw.toolkit).slug ?? raw.toolkit),
    name: string(raw.name, 200),
    description: string(raw.description, 8000),
    inputSchema: object(raw.input_parameters ?? raw.input_schema),
    outputSchema: object(raw.output_parameters ?? raw.output_schema),
    version: string(raw.version, 120) || undefined,
    tags: strings(raw.tags),
    noAuth: raw.no_auth === true,
  };
}
function account(value: unknown): ComposioConnection {
  const raw = object(value);
  const kit = object(raw.toolkit);
  return {
    id: composioSlug.parse(raw.id),
    toolkit: composioSlug.parse(kit.slug),
    serviceName: string(kit.name, 160) || string(kit.slug),
    status: string(raw.status, 40).toUpperCase(),
    alias: string(raw.alias, 160) || undefined,
    createdAt: string(raw.created_at, 100) || undefined,
    updatedAt: string(raw.updated_at, 100) || undefined,
  };
}
function publicFlow(record: ComposioFlowRecord): ComposioFlow {
  const {
    id,
    toolkit: slug,
    serviceName,
    status,
    authorizationUrl,
    createdAt,
    expiresAt,
    connectionId,
    message,
  } = record;
  return {
    id,
    toolkit: slug,
    serviceName,
    status,
    authorizationUrl: status === "waiting" ? authorizationUrl : undefined,
    createdAt,
    expiresAt,
    connectionId,
    message,
  };
}
function redactResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactResult);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, part]) => [
      key,
      /^(?:authorization|cookie|set-cookie|password|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|credentials)$/i.test(
        key,
      )
        ? "[redacted]"
        : redactResult(part),
    ]),
  );
}

/** Composio is the connection registry and credential custodian. Our database
 * contains owner-bound references and durable waits; never provider secrets. */
export class ComposioService {
  private readonly transport: ComposioTransport;
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(
    private readonly db: Store,
    private readonly vault: SecretStore,
    private readonly options: {
      available: boolean;
      fetch?: typeof fetch;
      request?: ComposioTransport;
      now?: () => number;
    },
  ) {
    this.transport = options.request ?? composioTransport(options.fetch);
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private timestamp() {
    return new Date(this.now()).toISOString();
  }
  private userId(owner: string) {
    return `okami_${createHash("sha256").update(owner).digest("hex").slice(0, 40)}`;
  }
  private serial<T>(owner: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(owner) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.queues.set(owner, next);
    return next.finally(() => {
      if (this.queues.get(owner) === next) this.queues.delete(owner);
    });
  }
  async status(owner: string) {
    const config = await this.db.get<Config>(owner, configKind, "platform");
    return { configured: this.options.available && Boolean(config) && !config?.invalid };
  }
  private async key(owner: string) {
    if (!this.options.available)
      throw new AppError("The credential vault is unavailable", 503, "VAULT_UNAVAILABLE");
    const config = await this.db.get<Config>(owner, configKind, "platform");
    if (!config || config.invalid)
      throw new AppError(
        "Connect Composio in Connections to open the app catalog",
        409,
        "COMPOSIO_SETUP_REQUIRED",
      );
    let secret: Awaited<ReturnType<SecretStore["read"]>>;
    try {
      secret = await this.vault.read(owner, vaultId);
    } catch {
      throw new AppError("The credential vault is unavailable", 503, "VAULT_UNAVAILABLE");
    }
    if (!secret?.data.apiKey || secret.version !== config.keyVersion)
      throw new AppError(
        "Update the Composio project key in Connections",
        409,
        "COMPOSIO_SETUP_REQUIRED",
      );
    return { apiKey: secret.data.apiKey, version: secret.version };
  }
  async setup(owner: string, apiKey: string) {
    if (!this.options.available)
      throw new AppError("The credential vault is unavailable", 503, "VAULT_UNAVAILABLE");
    if (!apiKey.trim() || apiKey.length > 8192 || /\s/.test(apiKey))
      throw new AppError("Enter a valid Composio project key", 422);
    return this.serial(owner, async () => {
      const response = object(
        await this.transport({
          apiKey,
          path: "/toolkits",
          query: new URLSearchParams({ limit: "1" }),
        }),
      );
      if (!Array.isArray(response.items))
        throw new AppError("The Composio project key could not be validated", 502);
      let keyVersion: number;
      try {
        const previous = await this.vault.read(owner, vaultId);
        keyVersion = await this.vault.write(owner, vaultId, { apiKey }, previous?.version ?? 0);
      } catch {
        throw new AppError("The vault could not save the project key", 503, "VAULT_UNAVAILABLE");
      }
      await this.db.put(owner, configKind, {
        id: "platform",
        keyVersion,
        updatedAt: this.timestamp(),
      });
      return { configured: true };
    });
  }
  private async call(owner: string, input: Omit<ComposioTransportInput, "apiKey">) {
    const key = await this.key(owner);
    let result: unknown;
    try {
      result = await this.transport({ ...input, apiKey: key.apiKey });
    } catch (error) {
      if (error instanceof AppError && error.code === "COMPOSIO_SETUP_REQUIRED")
        await this.db.compareAndSwap(
          owner,
          configKind,
          "platform",
          { keyVersion: key.version },
          { invalid: true },
        );
      throw error;
    }
    const scrub = configuredSecretScrubber([
      key.apiKey,
      encodeURIComponent(key.apiKey),
      Buffer.from(key.apiKey).toString("base64"),
    ]);
    return scrubConfiguredValue(result, scrub);
  }
  async catalog(owner: string, raw: unknown = {}) {
    const input = composioCatalogSchema.parse(raw);
    if (!(await this.status(owner)).configured)
      return {
        configured: false,
        items: [] as ComposioToolkit[],
        categories: [] as ComposioCategory[],
        nextCursor: null,
        totalItems: 0,
      };
    const query = new URLSearchParams({
      limit: String(input.limit),
      sort_by: "alphabetically",
      type: "all",
      include_deprecated: "false",
    });
    for (const name of ["search", "category", "cursor"] as const)
      if (input[name]) query.set(name, input[name]);
    const [catalog, categories] = await Promise.all([
      this.call(owner, { path: "/toolkits", query }),
      this.call(owner, { path: "/toolkits/categories" }),
    ]);
    const response = object(catalog);
    const categoryResponse = object(categories);
    return {
      configured: true,
      items: items(response.items).map(toolkit),
      categories: items(categoryResponse.items ?? categories)
        .map(category)
        .filter((item) => item.id && item.name),
      nextCursor: string(response.next_cursor, 4096) || null,
      totalItems:
        typeof response.total_items === "number"
          ? response.total_items
          : items(response.items).length,
    };
  }
  async toolkit(owner: string, slug: string) {
    return toolkit(await this.call(owner, { path: `/toolkits/${composioSlug.parse(slug)}` }));
  }
  async connections(owner: string, accountId?: string): Promise<ComposioConnection[]> {
    if (!(await this.status(owner)).configured) return [];
    if (accountId) composioSlug.parse(accountId);
    const result: ComposioConnection[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const query = new URLSearchParams({ user_ids: this.userId(owner), limit: "100" });
      if (accountId) query.set("connected_account_ids", accountId);
      if (cursor) query.set("cursor", cursor);
      const response = object(await this.call(owner, { path: "/connected_accounts", query }));
      for (const value of items(response.items)) {
        const raw = object(value);
        // Older responses include user_id; newer ones rely on the owner-filtered list.
        if (raw.user_id !== undefined && raw.user_id !== this.userId(owner)) continue;
        if (object(raw.experimental).account_type === "SHARED" || raw.account_type === "SHARED")
          continue;
        const connection = account(value);
        if (accountId && connection.id !== accountId) continue;
        const tombstone = await this.db.get<{ failed?: boolean }>(
          owner,
          "composio-disconnected",
          connection.id,
        );
        if (!tombstone) result.push(connection);
        else if (tombstone.failed) result.push({ ...connection, status: "DISCONNECT_FAILED" });
      }
      cursor = string(response.next_cursor, 4096) || undefined;
      if (!cursor) return result;
      if (seen.has(cursor)) throw new AppError("The connections cursor did not advance", 502);
      seen.add(cursor);
    }
    throw new AppError("Too many connected accounts to enumerate safely", 502);
  }
  async findConnection(owner: string, slug: string, accountId?: string) {
    const accounts = (await this.connections(owner, accountId)).filter(
      (item) => item.toolkit === slug && item.status === "ACTIVE",
    );
    if (accounts.length > 1)
      throw new AppError(
        "Choose which connected account to use",
        409,
        "COMPOSIO_ACCOUNT_SELECTION_REQUIRED",
      );
    return accounts[0] ?? null;
  }
  private async session(owner: string, toolkits?: string[]) {
    const key = await this.key(owner);
    const allowed = toolkits?.map((slug) => composioSlug.parse(slug)).sort();
    const scope = bindingHash({ toolkits: allowed ?? null });
    const previous = (await this.db.list<Session>(owner, sessionKind)).find(
      (item) => item.scope === scope && item.keyVersion === key.version,
    );
    if (previous) return previous;
    const response = object(
      await this.call(owner, {
        path: "/tool_router/session",
        method: "POST",
        body: {
          user_id: this.userId(owner),
          ...(allowed?.length ? { toolkits: { enable: allowed } } : {}),
          manage_connections: {
            enable: false,
            enable_wait_for_connections: false,
            enable_connection_removal: false,
          },
          workbench: { enable: false, enable_tool_execution: false, enable_proxy_execution: false },
          instant: false,
          multi_account: { enable: true, require_explicit_selection: true },
        },
      }),
    );
    const record: Session = {
      id: composioSlug.parse(response.session_id),
      userId: this.userId(owner),
      keyVersion: key.version,
      scope,
      ...(allowed ? { toolkits: allowed } : {}),
    };
    await this.db.put(owner, sessionKind, record);
    return record;
  }
  private async record(owner: string, id: string) {
    const record = await this.db.get<ComposioFlowRecord>(owner, flowKind, id);
    if (!record) throw new AppError("Connection request not found", 404);
    return record;
  }
  private interaction(record: ComposioFlowRecord): CredentialInteractionRequest {
    return {
      ...record.interaction,
      status: record.status === "connected" ? "connected" : record.status,
      schema: {
        credentialKind: "composio",
        title: `Connect ${record.serviceName}`,
        serviceName: record.serviceName,
        origin: "https://connect.composio.dev",
        purpose: record.purpose,
        fields: [],
        composio: {
          flowId: record.id,
          toolkitSlug: record.toolkit,
          expiresAt: record.expiresAt,
          ...(record.authorizationUrl && record.status === "waiting"
            ? { authorizationUrl: record.authorizationUrl }
            : {}),
          ...(!record.sessionId && record.status === "waiting" ? { setupRequired: true } : {}),
        },
      },
    };
  }
  private async saveFlow(
    owner: string,
    before: ComposioFlowRecord,
    next: ComposioFlowRecord,
    task?: AgentTask,
  ) {
    next.interaction = this.interaction(next);
    if (pendingStatuses.includes(next.status)) delete next.interaction.answeredAt;
    else next.interaction.answeredAt = this.timestamp();
    const mutations: Parameters<Store["durableMutation"]>[3] = [
      {
        kind: flowKind,
        id: next.id,
        mode: "replace",
        expected: { interaction: before.interaction },
        value: next,
      },
      {
        kind: "interaction-requests",
        id: next.id,
        mode: "replace",
        expected: { status: before.interaction.status },
        value: next.interaction,
      },
    ];
    if (task)
      mutations.push({
        kind: "tasks",
        id: task.id,
        mode: "merge",
        expected: { status: task.status, attempts: task.attempts, state: task.state },
        value:
          next.status === "connected"
            ? {
                status: "queued",
                question: null,
                updatedAt: this.timestamp(),
                state: {
                  ...task.state,
                  composioConnection: { id: next.connectionId, toolkit: next.toolkit },
                },
              }
            : {
                status: "cancelled",
                leaseId: null,
                leaseUntil: null,
                question: null,
                result: "Connection request cancelled.",
                updatedAt: this.timestamp(),
              },
      });
    const result = await this.db.durableMutation(
      owner,
      `composio-flow:${next.id}:${bindingHash(next)}`,
      bindingHash(next),
      mutations,
      next.interaction.threadId
        ? [
            {
              id: `composio-flow:${next.id}:${bindingHash(next)}`,
              threadId: next.interaction.threadId,
              origin: "task",
              kind: "interaction",
              payload: next.interaction,
            },
          ]
        : [],
    );
    if (!["applied", "duplicate"].includes(result.status)) return this.record(owner, next.id);
    return next;
  }
  private async provision(owner: string, record: ComposioFlowRecord) {
    if (record.status !== "waiting" || !(await this.status(owner)).configured) return record;
    const key = await this.key(owner);
    if (record.sessionId && record.keyVersion === key.version) return record;
    const kit = await this.toolkit(owner, record.toolkit);
    if (kit.noAuth) {
      const task = record.taskBound
        ? await this.db.get<AgentTask>(owner, "tasks", record.interaction.taskId)
        : null;
      if (
        record.taskBound &&
        (!task ||
          task.attempts !== record.interaction.revision ||
          task.status !== "waiting_input" ||
          task.state.interactionRequestId !== record.id)
      )
        return record;
      return this.saveFlow(
        owner,
        record,
        { ...record, serviceName: kit.name, status: "connected" },
        task ?? undefined,
      );
    }
    const session = await this.session(owner);
    const link = object(
      await this.call(owner, {
        path: `/tool_router/session/${session.id}/link`,
        method: "POST",
        body: { toolkit: record.toolkit },
      }),
    );
    const url = https(link.redirect_url);
    if (
      !url ||
      new URL(url).port ||
      !["app.composio.dev", "connect.composio.dev"].includes(new URL(url).hostname) ||
      !new URL(url).pathname.startsWith("/link/")
    )
      throw new AppError("The connection service returned an invalid sign-in link", 502);
    return this.saveFlow(owner, record, {
      ...record,
      serviceName: kit.name,
      sessionId: session.id,
      keyVersion: session.keyVersion,
      authorizationUrl: url,
      connectionId: composioSlug.parse(link.connected_account_id),
    });
  }
  async connect(owner: string, raw: ComposioRequestInput, context: ComposioContext = {}) {
    const input = composioRequestSchema.parse(raw);
    return this.serial(owner, async () => {
      let task = context.taskSeed;
      if (task && (context.taskId || context.revision !== undefined))
        throw new AppError("Choose one task context", 422);
      if (!task && context.taskId)
        task = (await this.db.get<AgentTask>(owner, "tasks", context.taskId)) ?? undefined;
      if (context.taskId && !task) throw new AppError("Task not found", 404);
      if (
        task &&
        (!["running", "waiting_input"].includes(task.status) ||
          (context.revision !== undefined && task.attempts !== context.revision))
      )
        throw new AppError("The task has changed", 409);
      const threadId = context.threadId ?? task?.originThreadId;
      if (threadId) {
        const thread = await this.db.get<{ deletedAt?: string }>(owner, "threads", threadId);
        if (!thread || thread.deletedAt) throw new AppError("Conversation not found", 404);
      }
      const pending = (await this.db.list<ComposioFlowRecord>(owner, flowKind)).find(
        (item) =>
          item.status === "waiting" &&
          Date.parse(item.expiresAt) > this.now() &&
          (task
            ? item.taskBound &&
              item.interaction.taskId === task.id &&
              item.interaction.revision === task.attempts
            : !item.taskBound && item.toolkit === input.toolkit),
      );
      if (pending) {
        const current = await this.provision(owner, pending);
        return { flow: publicFlow(current), request: current.interaction };
      }
      const id = randomUUID();
      const createdAt = this.timestamp();
      let record: ComposioFlowRecord = {
        id,
        toolkit: input.toolkit,
        serviceName: input.toolkit,
        purpose: input.purpose,
        taskBound: Boolean(task),
        status: "waiting",
        createdAt,
        expiresAt: new Date(this.now() + 30 * 60_000).toISOString(),
        interaction: {
          id,
          taskId: task?.id ?? `composio-settings:${id}`,
          revision: task?.attempts ?? 0,
          ...(threadId ? { threadId } : {}),
          createdAt,
          kind: "credential",
          status: "waiting",
          schema: {
            title: "Connect app",
            serviceName: input.toolkit,
            origin: "https://connect.composio.dev",
            purpose: input.purpose,
            fields: [],
          },
        },
      };
      record.interaction = this.interaction(record);
      const mutations: Parameters<Store["durableMutation"]>[3] = [
        { kind: flowKind, id, mode: "insert", value: record },
        { kind: "interaction-requests", id, mode: "insert", value: record.interaction },
      ];
      if (context.taskSeed && task)
        mutations.unshift({
          kind: "tasks",
          id: task.id,
          mode: "insert",
          value: {
            ...task,
            status: "waiting_input",
            question: `Connect ${record.serviceName} to continue.`,
            state: { ...task.state, interactionRequestId: id, composioFlowId: id },
            updatedAt: createdAt,
          },
        });
      const receipt = await this.db.durableMutation(
        owner,
        `composio-request:${id}`,
        bindingHash({ id, input }),
        mutations,
        threadId
          ? [
              {
                id: `composio-request:${id}`,
                threadId,
                origin: "task",
                kind: "interaction",
                payload: record.interaction,
              },
            ]
          : [],
      );
      if (!["applied", "duplicate"].includes(receipt.status))
        throw new AppError("The connection request changed", 409);
      record = await this.provision(owner, record);
      return { flow: publicFlow(record), request: record.interaction };
    });
  }
  async request(owner: string, input: ComposioRequestInput, context: ComposioContext) {
    if (!context.taskId && !context.taskSeed)
      throw new AppError("The connection request needs its original task", 422);
    return (await this.connect(owner, input, context)).request;
  }
  private async refreshFlow(owner: string, id: string) {
    let record = await this.record(owner, id);
    if (!pendingStatuses.includes(record.status)) return record;
    let task: AgentTask | undefined;
    if (record.taskBound) {
      task = (await this.db.get<AgentTask>(owner, "tasks", record.interaction.taskId)) ?? undefined;
      if (
        !task ||
        task.attempts !== record.interaction.revision ||
        !["running", "waiting_input"].includes(task.status) ||
        (task.status === "waiting_input" && task.state.interactionRequestId !== record.id)
      )
        return this.saveFlow(owner, record, {
          ...record,
          status: "superseded",
          authorizationUrl: undefined,
        });
    }
    if (record.status !== "waiting") return record;
    if (Date.parse(record.expiresAt) <= this.now())
      return this.saveFlow(owner, record, {
        ...record,
        status: "expired",
        authorizationUrl: undefined,
      });
    if (!(await this.status(owner)).configured) {
      if (record.sessionId)
        record = await this.saveFlow(owner, record, {
          ...record,
          sessionId: undefined,
          authorizationUrl: undefined,
        });
      return record;
    }
    record = await this.provision(owner, record);
    if (record.status !== "waiting") return record;
    if (!record.connectionId || !record.sessionId) return record;
    const connection = (await this.connections(owner, record.connectionId)).find(
      (item) => item.id === record.connectionId && item.toolkit === record.toolkit,
    );
    if (!connection) return record;
    if (["FAILED", "EXPIRED", "REVOKED", "INACTIVE", "DISABLED"].includes(connection.status))
      return this.saveFlow(owner, record, {
        ...record,
        status: "error",
        authorizationUrl: undefined,
        message: "The connection was not completed. Start a new connection.",
      });
    if (connection.status !== "ACTIVE") return record;
    // A fast OAuth return can precede the worker's committed pause. Keep polling;
    // never overwrite an active worker or queue a different task revision.
    if (task && (task.status !== "waiting_input" || task.state.interactionRequestId !== record.id))
      return record;
    return this.saveFlow(
      owner,
      record,
      { ...record, status: "connected", authorizationUrl: undefined },
      task,
    );
  }
  async flow(owner: string, id: string) {
    return this.serial(owner, async () => publicFlow(await this.refreshFlow(owner, id)));
  }
  async statusInteraction(owner: string, id: string) {
    return this.serial(owner, async () => (await this.refreshFlow(owner, id)).interaction);
  }
  async pending(owner: string) {
    const records = await this.db.list<ComposioFlowRecord>(owner, flowKind);
    const pending: CredentialInteractionRequest[] = [];
    for (const record of records.filter((item) => pendingStatuses.includes(item.status))) {
      const interaction = await this.statusInteraction(owner, record.id);
      if (pendingStatuses.includes(interaction.status)) pending.push(interaction);
    }
    return pending;
  }
  async overview(owner: string) {
    const pendingRequests = await this.pending(owner);
    return {
      ...(await this.status(owner)),
      connections: await this.connections(owner),
      pendingRequests,
      pendingFlows: (await this.db.list<ComposioFlowRecord>(owner, flowKind))
        .filter((item) => pendingStatuses.includes(item.status))
        .map(publicFlow),
    };
  }
  async cancel(owner: string, id: string) {
    return this.serial(owner, async () => {
      const record = await this.record(owner, id);
      if (!pendingStatuses.includes(record.status)) return record.interaction;
      const task = record.taskBound
        ? await this.db.get<AgentTask>(owner, "tasks", record.interaction.taskId)
        : null;
      const current =
        task &&
        task.attempts === record.interaction.revision &&
        ["running", "waiting_input"].includes(task.status) &&
        (task.status === "running" || task.state.interactionRequestId === id)
          ? task
          : undefined;
      const cancelled = await this.saveFlow(
        owner,
        record,
        { ...record, status: "cancelled", authorizationUrl: undefined },
        current,
      );
      if (cancelled.status === "cancelled" && record.connectionId) {
        await this.db.put(owner, "composio-disconnected", {
          id: record.connectionId,
          updatedAt: this.timestamp(),
        });
        // This ID was created by this exact owner-bound flow, never a reused account.
        await this.call(owner, {
          path: `/connected_accounts/${record.connectionId}`,
          method: "DELETE",
        }).catch(() => {});
      }
      return cancelled.interaction;
    });
  }
  async retry(owner: string, id: string) {
    return this.serial(owner, async () => {
      const record = await this.record(owner, id);
      if (!["error", "expired"].includes(record.status))
        throw new AppError("This connection request cannot be restarted", 409);
      if (record.taskBound) {
        const task = await this.db.get<AgentTask>(owner, "tasks", record.interaction.taskId);
        if (
          !task ||
          task.status !== "waiting_input" ||
          task.attempts !== record.interaction.revision ||
          task.state.interactionRequestId !== id
        )
          throw new AppError("The original task changed", 409);
      }
      if (record.connectionId) {
        await this.db.put(owner, "composio-disconnected", {
          id: record.connectionId,
          updatedAt: this.timestamp(),
        });
        await this.call(owner, {
          path: `/connected_accounts/${record.connectionId}`,
          method: "DELETE",
        }).catch(() => {});
      }
      const reset = await this.saveFlow(owner, record, {
        ...record,
        status: "waiting",
        sessionId: undefined,
        connectionId: undefined,
        authorizationUrl: undefined,
        keyVersion: undefined,
        message: undefined,
        expiresAt: new Date(this.now() + 30 * 60_000).toISOString(),
      });
      return (await this.provision(owner, reset)).interaction;
    });
  }
  async disconnect(owner: string, id: string) {
    composioSlug.parse(id);
    return this.serial(owner, async () => {
      const connection = (await this.connections(owner, id))[0];
      if (!connection) throw new AppError("Connected account not found", 404);
      // Local tombstone fences future dispatch even while remote revoke is in flight.
      await this.db.put(owner, "composio-disconnected", { id, updatedAt: this.timestamp() });
      try {
        await this.call(owner, {
          path: `/connected_accounts/${id}/revoke`,
          method: "POST",
          body: {},
        });
      } catch (error) {
        await this.db.put(owner, "composio-disconnected", {
          id,
          failed: true,
          updatedAt: this.timestamp(),
        });
        throw error;
      }
      return { disconnected: true };
    });
  }
  async rawTool(
    owner: string,
    slug: string,
    context: { version?: string; signal?: AbortSignal } = {},
  ) {
    composioSlug.parse(slug);
    if (/^(COMPOSIO|LOCAL)_/i.test(slug))
      throw new AppError("Only individual app tools are available", 422);
    const result = tool(
      await this.call(owner, {
        path: `/tools/${slug}`,
        query: new URLSearchParams({ version: context.version ?? "latest" }),
        signal: context.signal,
      }),
    );
    if (result.slug !== slug || result.toolkit.toLowerCase() === "composio")
      throw new AppError("The requested app tool does not match its metadata", 422);
    return result;
  }
  async search(
    owner: string,
    input: { query: string; toolkits?: string[] },
    context: { signal?: AbortSignal } = {},
  ) {
    if (!input.query.trim() || input.query.length > 1024)
      throw new AppError("Describe the app task to search", 422);
    if (input.toolkits && (input.toolkits.length > 20 || !input.toolkits.length))
      throw new AppError("Choose up to 20 toolkits", 422);
    const session = await this.serial(owner, () => this.session(owner, input.toolkits));
    const response = object(
      await this.call(owner, {
        path: `/tool_router/session/${session.id}/search`,
        method: "POST",
        body: { queries: [{ use_case: input.query }], search_strategy: "tool_search" },
        signal: context.signal,
      }),
    );
    const slugs = [
      ...new Set([
        ...Object.keys(object(response.tool_schemas)),
        ...items(response.results).flatMap((result) => strings(object(result).primary_tool_slugs)),
      ]),
    ]
      .filter((slug) => !/^(COMPOSIO|LOCAL)_/i.test(slug))
      .slice(0, 12);
    const tools = await Promise.all(
      slugs.map((slug) => this.rawTool(owner, slug, { signal: context.signal })),
    );
    return {
      sessionId: session.id,
      tools: tools.filter((item) => !input.toolkits || input.toolkits.includes(item.toolkit)),
      connections: await this.connections(owner),
    };
  }
  async executeSingle(
    owner: string,
    input: ComposioExecutionInput,
    context: ComposioExecutionContext,
  ): Promise<ComposioExecutionResult> {
    const session = await this.db.get<Session>(
      owner,
      sessionKind,
      composioSlug.parse(input.sessionId),
    );
    const key = await this.key(owner);
    if (!session || session.userId !== this.userId(owner) || session.keyVersion !== key.version)
      throw new AppError(
        "Search the connected app again before running this tool",
        409,
        "COMPOSIO_SESSION_CHANGED",
      );
    const metadata = await this.rawTool(owner, input.toolSlug, { signal: context.signal });
    if (
      metadata.toolkit !== input.toolkit ||
      (session.toolkits && !session.toolkits.includes(input.toolkit)) ||
      (input.version && input.version !== metadata.version)
    )
      throw new AppError(
        "The app tool changed. Search again before running it",
        409,
        "COMPOSIO_TOOL_CHANGED",
      );
    let connection: ComposioConnection | null = null;
    if (!metadata.noAuth || input.accountId) {
      connection = await this.findConnection(owner, input.toolkit, input.accountId);
      if (!connection)
        throw new AppError("Reconnect this app to continue", 409, "COMPOSIO_CONNECTION_REQUIRED");
    }
    const response = object(
      await this.call(owner, {
        path: `/tool_router/session/${session.id}/execute`,
        method: "POST",
        body: {
          tool_slug: metadata.slug,
          arguments: input.arguments,
          ...(connection ? { account: connection.id } : {}),
          enable_auto_workbench_offload: false,
        },
        signal: context.signal,
        effect: context.effect,
        beforeDispatch: async () => {
          await context.beforeDispatch?.();
          const current = await this.db.get<Config>(owner, configKind, "platform");
          const revoked =
            connection && (await this.db.get(owner, "composio-disconnected", connection.id));
          if (current?.keyVersion !== key.version || revoked)
            throw new AppError(
              "The app connection changed before execution",
              409,
              "COMPOSIO_CONNECTION_REQUIRED",
            );
        },
      }),
    );
    if (
      !("data" in response) ||
      !(response.error === null || typeof response.error === "string") ||
      !string(response.log_id)
    ) {
      const error = new AppError("The app operation returned an incomplete receipt", 502);
      if (context.effect !== "read") Object.assign(error, { outcomeUnknown: true });
      throw error;
    }
    const error =
      typeof response.error === "string" && response.error ? response.error.slice(0, 500) : null;
    if (
      error &&
      /(?:connected.account|connection).*(?:expired|inactive|not.found|invalid|missing)|(?:unauthori[sz]ed|invalid.token|authentication.failed)/i.test(
        error,
      )
    )
      throw new AppError("Reconnect this app to continue", 409, "COMPOSIO_CONNECTION_REQUIRED");
    return {
      data: redactResult(response.data),
      error,
      logId: string(response.log_id, 160) || undefined,
    };
  }
}
