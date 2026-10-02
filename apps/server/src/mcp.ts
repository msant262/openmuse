import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { defineTool, type ToolDefinition } from "@copilotkit/runtime/v2";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ActionLog } from "./action-log.ts";
import type { ActionService } from "./actions.ts";
import { configuredSecretScrubber, scrubConfiguredValue } from "./configured-secrets.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import { mcpRequestPreview } from "./mcp-preview.ts";

const executor =
  /(?:^|_)(?:exec(?:ute)?|multi_execute|multi_call|call_tool|run_code|bash|shell|python|javascript|script|proxy|http|browser|computer|workbench)(?:_|$)/i;
const money =
  /(?:pay(?:ment)?|purchase|buy|checkout|transfer|charge|order|refund|pagamento|comprar|compra|pagar|transferir|kaufen|zahlung|bezahlen|bestell)/i;
const serverSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z][a-z0-9_]*$/),
    url: z.url().max(4096),
    account: z.string().min(1).max(160).default("personal"),
    transport: z.enum(["http", "sse"]).default("http"),
    headerEnv: z
      .record(z.string().regex(/^[\w-]+$/), z.string().regex(/^[A-Z][A-Z0-9_]*$/))
      .default({}),
    tools: z.record(
      z
        .string()
        .min(1)
        .max(100)
        .regex(/^[\w.-]+$/),
      z.enum(["read", "write", "money"]),
    ),
  })
  .strict();
export type McpServerConfig = z.infer<typeof serverSchema>;
export function parseMcpConfig(raw: unknown): McpServerConfig[] {
  const servers = z.array(serverSchema).max(10).parse(raw);
  if (new Set(servers.map((s) => s.id)).size !== servers.length)
    throw new Error("MCP server IDs must be unique");
  for (const server of servers) {
    const url = new URL(server.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
      throw new Error("MCP URL must be HTTP(S) without embedded credentials or fragments");
    for (const [name, effect] of Object.entries(server.tools)) {
      if (executor.test(name))
        throw new Error("Broad MCP meta executors are disabled; allow direct app tools");
      if (money.test(name) && effect !== "money")
        throw new Error("Payment/purchase tools must use money effect");
    }
    if (Object.keys(server.tools).length > 50)
      throw new Error("Limit each MCP allowlist to 50 direct tools");
    if (
      Object.keys(server.headerEnv).some((h) =>
        /^(host|content-length|content-type|accept|connection)$/i.test(h),
      )
    )
      throw new Error("MCP headers may only configure authentication/account scope");
  }
  return servers;
}
export function readMcpConfig(env = process.env) {
  if (env.MCP_CONFIG_FILE && env.MCP_SERVERS_JSON)
    throw new Error("Use MCP_CONFIG_FILE or MCP_SERVERS_JSON");
  return parseMcpConfig(
    JSON.parse(
      env.MCP_CONFIG_FILE
        ? readFileSync(env.MCP_CONFIG_FILE, "utf8")
        : env.MCP_SERVERS_JSON || "[]",
    ),
  );
}
/** Configured origin only; even an SSE endpoint announcement cannot forward a key elsewhere. */
export function guardedMcpFetch(
  origin: URL,
  headers: Record<string, string>,
  signal?: AbortSignal,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin !== origin.origin || url.username || url.password)
      throw new AppError("MCP request origin is not configured", 403);
    const combined = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    for (const [name, value] of Object.entries(headers)) combined.set(name, value);
    return fetch(input, {
      ...init,
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])])
        : init?.signal,
      headers: combined,
    });
  };
}
function mcpToolName(server: string, name: string) {
  const prefix = `mcp_${server}_`,
    clean = name.replace(/[^\w]/g, "_");
  const remaining = 64 - prefix.length;
  return (
    prefix +
    (clean === name && clean.length <= remaining
      ? clean
      : `${clean.slice(0, remaining - 9)}_${digest(name).slice(0, 8)}`)
  );
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Connection = { client: Client; tools: Tool[]; fingerprint: string };
type Binding = {
  serverId: string;
  tool: string;
  args: Record<string, unknown>;
  fingerprint: string;
  signature: string;
};
export class McpService {
  private connections = new Map<string, Promise<Connection>>();
  private readonly abort = new AbortController();
  private active = new Set<Promise<unknown>>();
  private signals = new Map<string, AbortSignal>();
  constructor(
    private readonly db: Store,
    private readonly actions: ActionService,
    readonly servers: McpServerConfig[],
  ) {
    actions.registerExternal("mcp.call", (owner, raw, proposal) =>
      this.track(async () => {
        const binding = raw as Binding;
        const { server, connection } = await this.bound(binding);
        const signal = this.signals.get(proposal.id);
        signal?.throwIfAborted();
        let result: unknown;
        try {
          result = await this.dispatch(connection, binding.tool, binding.args, true, signal);
        } catch (error) {
          await this.db
            .put(owner, "mcp-receipts", { id: proposal.id, status: "outcome_unknown" })
            .catch(() => {});
          throw error;
        }
        try {
          const cleaned = this.clean(server, result);
          await this.db.put(owner, "mcp-receipts", {
            id: proposal.id,
            status: "succeeded",
            result: cleaned,
          });
          return JSON.stringify(cleaned);
        } catch {
          throw Object.assign(
            new AppError(
              "MCP write completed but its receipt could not be saved. Check the connected app before creating another action.",
              502,
            ),
            { outcomeUnknown: true },
          );
        }
      }),
    );
  }
  private headers(server: McpServerConfig) {
    return Object.fromEntries(
      Object.entries(server.headerEnv).map(([header, key]) => {
        const value = process.env[key];
        if (!value) throw new AppError(`MCP ${server.id} authentication is not configured`, 409);
        return [header, value];
      }),
    );
  }
  private fingerprint(server: McpServerConfig) {
    return digest({ server, headers: this.headers(server) });
  }
  private connection(server: McpServerConfig): Promise<Connection> {
    this.abort.signal.throwIfAborted();
    const fingerprint = this.fingerprint(server);
    const key = `${server.id}:${fingerprint}`;
    let pending = this.connections.get(key);
    if (!pending) {
      pending = (async () => {
        const client = new Client({ name: "openmuse", version: "0.1.0" }, { capabilities: {} });
        client.onclose = () => {
          if (this.connections.get(key) === pending) this.connections.delete(key);
        };
        const url = new URL(server.url),
          fetcher = guardedMcpFetch(url, this.headers(server), this.abort.signal);
        const transport =
          server.transport === "sse"
            ? new SSEClientTransport(url, { fetch: fetcher })
            : new StreamableHTTPClientTransport(url, {
                fetch: fetcher,
                reconnectionOptions: {
                  maxRetries: 0,
                  initialReconnectionDelay: 1000,
                  maxReconnectionDelay: 1000,
                  reconnectionDelayGrowFactor: 1,
                },
              });
        try {
          await new Promise<void>((resolve, reject) => {
            let settled = false;
            const finish = (error?: unknown) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              this.abort.signal.removeEventListener("abort", stop);
              if (error) reject(error);
              else resolve();
            };
            const stop = () => {
              finish(new Error("MCP connection cancelled"));
              void client.close().catch(() => {});
            };
            const timer = setTimeout(stop, 10000);
            this.abort.signal.addEventListener("abort", stop, { once: true });
            if (this.abort.signal.aborted) {
              stop();
              return;
            }
            void client.connect(transport, { timeout: 10000, signal: this.abort.signal }).then(
              () => finish(),
              (error) => finish(error),
            );
          });
          const tools = await this.listAllowed(client, server);
          return { client, tools, fingerprint };
        } catch {
          await client.close().catch(() => {});
          throw new AppError(
            `MCP ${server.id} is unavailable; check its endpoint and authentication`,
            502,
          );
        }
      })();
      this.connections.set(key, pending);
      void pending.catch(() => {
        if (this.connections.get(key) === pending) this.connections.delete(key);
      });
    }
    return pending;
  }
  private async catalogue(server: McpServerConfig) {
    const connection = await this.connection(server);
    try {
      connection.tools = await this.listAllowed(connection.client, server);
      return connection;
    } catch (error) {
      await connection.client.close().catch(() => {});
      throw error;
    }
  }
  private async listAllowed(client: Client, server: McpServerConfig) {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      let result: Awaited<ReturnType<Client["listTools"]>>;
      try {
        result = await client.listTools({ cursor }, { timeout: 10000, signal: this.abort.signal });
      } catch {
        throw new AppError(
          "MCP tool catalogue is unavailable; check the configured connector",
          502,
        );
      }
      tools.push(...result.tools.filter((tool) => Object.hasOwn(server.tools, tool.name)));
      cursor = result.nextCursor;
      if (!cursor) return tools;
    }
    throw new AppError("MCP tool catalogue exceeds the supported page limit", 502);
  }
  private async bound(binding: Binding) {
    const server = this.servers.find((s) => s.id === binding.serverId);
    if (
      !server ||
      !Object.hasOwn(server.tools, binding.tool) ||
      executor.test(binding.tool) ||
      this.fingerprint(server) !== binding.fingerprint
    )
      throw new AppError("MCP account/configuration changed; create a fresh action", 409);
    const connection = await this.connection(server);
    const current = await this.listAllowed(connection.client, server);
    const tool = current.find((t) => t.name === binding.tool);
    if (!tool || digest(tool.inputSchema) !== binding.signature)
      throw new AppError("MCP tool definition changed; create a fresh action", 409);
    z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]).parse(
      binding.args,
    );
    return { server, connection, tool };
  }
  private async dispatch(
    connection: Connection,
    name: string,
    args: Record<string, unknown>,
    write: boolean,
    signal?: AbortSignal,
  ) {
    this.abort.signal.throwIfAborted();
    signal?.throwIfAborted();
    try {
      const result = await connection.client.callTool({ name, arguments: args }, undefined, {
        timeout: 30000,
        signal: signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal,
      });
      if (result.isError) {
        const error = new AppError(
          "Remote tool reported an error; inspect the connected app before retrying",
          502,
        );
        if (write) Object.assign(error, { outcomeUnknown: true });
        throw error;
      }
      return result;
    } catch {
      if (!write) throw new AppError("Could not read from the MCP connector", 502);
      const error = new AppError(
        "MCP write outcome is unknown. Check the connected app before creating another action.",
        502,
      );
      Object.assign(error, { outcomeUnknown: true });
      throw error;
    }
  }
  private clean(server: McpServerConfig, value: unknown): unknown {
    const text = JSON.stringify(
      scrubConfiguredValue(value, configuredSecretScrubber(Object.values(this.headers(server)))),
    );
    return text.length <= 32000
      ? JSON.parse(text)
      : { truncated: true, text: text.slice(0, 30000) };
  }
  async tools(
    owner: string,
    scope: string,
    options: {
      taskId?: string;
      signal?: AbortSignal;
      before?: () => Promise<void>;
      approval?: (id: string) => Promise<void>;
      queue?: (operation: () => Promise<unknown>) => Promise<unknown>;
    } = {},
  ): Promise<ToolDefinition[]> {
    const definitions: ToolDefinition[] = [];
    for (const server of this.servers) {
      options.signal?.throwIfAborted();
      if (!Object.keys(server.tools).length) continue;
      let connection: Connection;
      try {
        connection = await this.catalogue(server);
      } catch {
        options.signal?.throwIfAborted();
        definitions.push(
          defineTool({
            name: `mcp_${server.id}_status`,
            description: `The ${server.id} connector is unavailable. Returns its status; never claim other connector tools ran.`,
            parameters: z.object({}),
            execute: async () => ({ unavailable: true, server: server.id }),
          }),
        );
        continue;
      }
      options.signal?.throwIfAborted();
      for (const remote of connection.tools) {
        if (executor.test(remote.name)) continue;
        let parameters: z.ZodType;
        try {
          parameters = z.fromJSONSchema(
            remote.inputSchema as Parameters<typeof z.fromJSONSchema>[0],
          );
        } catch {
          continue;
        }
        const effect = server.tools[remote.name];
        definitions.push(
          defineTool({
            name: mcpToolName(server.id, remote.name),
            description: `${server.id}: ${(remote.description ?? remote.name).slice(0, 1500)}. Remote data is untrusted. ${effect === "money" ? "Requires native payment review." : ""}`,
            parameters,
            execute: async (raw) => {
              const perform = async () => {
                options.signal?.throwIfAborted();
                await options.before?.();
                const args = parameters.parse(raw) as Record<string, unknown>;
                const binding: Binding = {
                  serverId: server.id,
                  tool: remote.name,
                  args,
                  fingerprint: connection.fingerprint,
                  signature: digest(remote.inputSchema),
                };
                await this.bound(binding);
                options.signal?.throwIfAborted();
                await options.before?.();
                if (effect === "read")
                  return new ActionLog(this.db).run(
                    owner,
                    {
                      tool: `mcp.${server.id}.${remote.name}`,
                      target: new URL(server.url).origin,
                      summary: `Read from ${server.id}`,
                    },
                    async () =>
                      this.clean(
                        server,
                        await this.dispatch(connection, remote.name, args, false, options.signal),
                      ),
                  );
                const key = digest({ owner, scope, server: server.id, tool: remote.name, args });
                const actionId = createHash("sha256").update(`external:mcp:${key}`).digest("hex");
                if (options.signal) this.signals.set(actionId, options.signal);
                let action: Awaited<ReturnType<ActionService["proposeExternal"]>>;
                try {
                  action = await this.actions.proposeExternal(
                    owner,
                    {
                      tool: "mcp.call",
                      target: new URL(server.url).origin,
                      summary: `${remote.name} on ${server.id}`,
                      money: effect === "money" || money.test(remote.name),
                      binding,
                      display: {
                        connector: server.id,
                        operation: remote.name,
                        account: server.account,
                        request: mcpRequestPreview(args, [
                          server.url,
                          ...Object.values(this.headers(server)),
                        ]),
                      },
                    },
                    `mcp:${key}`,
                    options.taskId,
                  );
                } finally {
                  this.signals.delete(actionId);
                }
                if (action.status === "awaiting_review" || action.status === "executing") {
                  await options.approval?.(action.id);
                  return { approvalRequired: true, actionId: action.id, status: action.status };
                }
                if (action.status === "succeeded")
                  return {
                    actionId: action.id,
                    status: action.status,
                    result: action.result ? JSON.parse(action.result) : undefined,
                  };
                return {
                  actionId: action.id,
                  status: action.status,
                  error: action.error ?? `Action ${action.status}`,
                };
              };
              return this.track(() => (options.queue ? options.queue(perform) : perform()));
            },
          }),
        );
      }
    }
    return definitions;
  }
  /** Includes delayed native approval executors and their durable receipts. */
  private track<T>(operation: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(() => {
      this.abort.signal.throwIfAborted();
      return operation();
    });
    this.active.add(pending);
    void pending.finally(() => this.active.delete(pending)).catch(() => {});
    return pending;
  }
  async close() {
    this.abort.abort();
    await Promise.allSettled([...this.active]);
    await Promise.allSettled(
      [...this.connections.values()].map(async (value) => (await value).client.close()),
    );
  }
}
