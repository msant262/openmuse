import { createHash, randomBytes, randomUUID } from "node:crypto";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { configuredSecretScrubber, scrubConfiguredValue } from "./configured-secrets.ts";
import type { SecretStore } from "./credentials/contracts.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import type { McpServerConfig } from "./mcp.ts";

type State = {
  id: string;
  credentialRef: string;
  generation: string;
  fingerprint: string;
  status: "connecting" | "connected" | "disconnected" | "needs_auth";
  flow?: string;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** OAuth tokens and PKCE verifier use the same private vault as site credentials.
 * Only config-approved origins can receive metadata/registration/token requests. */
export class McpAuth {
  private queues = new Map<string, Promise<unknown>>();
  private secrets = new Set<string>();
  private activeGenerations = new Map<string, string>();
  assertCurrent(owner: string, id: string, generation: string) {
    if (this.activeGenerations.get(`${owner}:${id}`) !== generation)
      throw new AppError("MCP authorization changed; reconnect or create a fresh action", 409);
  }
  constructor(
    private readonly db: Store,
    private readonly vault: SecretStore,
    private readonly servers: McpServerConfig[],
    private readonly publicUrl: string,
    private readonly options: { fetch?: typeof fetch; now?: () => number } = {},
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private server(id: string) {
    const server = this.servers.find((item) => item.id === id);
    if (!server) throw new AppError("MCP connector is not configured", 404);
    return server;
  }
  private serial<T>(owner: string, id: string, operation: () => Promise<T>): Promise<T> {
    const key = `${owner}:${id}`,
      next = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.queues.set(key, next);
    return next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
  }
  private callback() {
    const url = new URL("/api/mcp/oauth/callback", this.publicUrl);
    if (url.protocol !== "https:")
      throw new AppError(
        "MCP OAuth requires the configured HTTPS server URL. Tailscale users must open it from a paired device on their tailnet.",
        409,
      );
    return url.toString();
  }
  private checkUrl(server: McpServerConfig, raw: string | URL) {
    const url = new URL(raw);
    const allowed = new Set([
      new URL(server.url).origin,
      ...(server.oauth?.authorizationOrigins ?? []),
    ]);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      !allowed.has(url.origin)
    )
      throw new AppError(
        "MCP OAuth destination is not in this connector's configured HTTPS origins",
        403,
      );
    return url;
  }
  private fetcher(server: McpServerConfig): typeof fetch {
    return async (input, init) => {
      const url = this.checkUrl(
        server,
        typeof input === "string" ? input : input instanceof URL ? input : input.url,
      );
      const response = await (this.options.fetch ?? fetch)(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(10_000),
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
      if (response.status >= 300 && response.status < 400)
        throw new AppError("MCP OAuth redirects are not allowed for server requests", 403);
      // Metadata and token replies are bounded before the SDK parses any JSON.
      const reader = response.body?.getReader();
      if (!reader) return response;
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.length;
          if (length > 1024 * 1024) throw new AppError("MCP OAuth response exceeds its limit", 502);
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return new Response(Buffer.concat(chunks), {
        status: response.status,
        headers: response.headers,
      });
    };
  }
  private remember(tokens: OAuthTokens) {
    for (const value of [tokens.access_token, tokens.refresh_token])
      if (value) this.secrets.add(value);
    while (this.secrets.size > 256) this.secrets.delete(this.secrets.values().next().value!);
  }
  scrub(value: unknown) {
    return scrubConfiguredValue(value, configuredSecretScrubber([...this.secrets]));
  }
  private async provider(owner: string, server: McpServerConfig, state: State, nonce?: string) {
    const saved = await this.vault.read(owner, state.credentialRef);
    let data = saved?.data ?? {},
      version = saved?.version ?? 0;
    let authorizationUrl: string | undefined;
    const save = async (patch: Record<string, string>) => {
      data = { ...data, ...patch };
      version = await this.vault.write(owner, state.credentialRef, data, version);
    };
    const provider: OAuthClientProvider = {
      redirectUrl: this.callback(),
      clientMetadata: {
        client_name: "OkamiBot",
        redirect_uris: [this.callback()],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: server.oauth?.clientSecretEnv ? "client_secret_post" : "none",
      },
      state: () => {
        if (!nonce) throw new AppError("Reconnect this MCP app from Connections", 409);
        return nonce;
      },
      clientInformation: () => {
        if (server.oauth?.clientId) {
          const secret = server.oauth.clientSecretEnv
            ? process.env[server.oauth.clientSecretEnv]
            : undefined;
          if (server.oauth.clientSecretEnv && !secret)
            throw new AppError("MCP client credentials are not configured", 409);
          if (secret) this.secrets.add(secret);
          return { client_id: server.oauth.clientId, ...(secret ? { client_secret: secret } : {}) };
        }
        const client = data.client ? JSON.parse(data.client) : undefined;
        if (client?.client_secret) this.secrets.add(client.client_secret);
        return client;
      },
      saveClientInformation: async (value) => {
        if (value.client_secret) this.secrets.add(value.client_secret);
        await save({ client: JSON.stringify(value) });
      },
      tokens: () => (data.tokens ? JSON.parse(data.tokens) : undefined),
      saveTokens: async (tokens) => {
        this.remember(tokens);
        await save({
          tokens: JSON.stringify(tokens),
          expiresAt: String(this.now() + (tokens.expires_in ?? 300) * 1000),
          verifier: "",
        });
      },
      saveCodeVerifier: (verifier) => save({ verifier }),
      codeVerifier: () => {
        if (!data.verifier) throw new AppError("This authorization has expired; reconnect", 409);
        return data.verifier;
      },
      redirectToAuthorization: async (url) => {
        this.checkUrl(server, url);
        if (
          !nonce ||
          url.searchParams.get("state") !== nonce ||
          url.searchParams.get("redirect_uri") !== this.callback()
        )
          throw new AppError("MCP authorization binding changed", 409);
        authorizationUrl = url.toString();
      },
      invalidateCredentials: async (scope) => {
        const patch: Record<string, string> = {};
        if (scope === "all" || scope === "tokens") patch.tokens = "";
        if (scope === "all" || scope === "client") patch.client = "";
        if (scope === "all" || scope === "verifier") patch.verifier = "";
        await save(patch);
      },
    };
    return {
      provider,
      get url() {
        return authorizationUrl;
      },
      get data() {
        return data;
      },
    };
  }
  async start(owner: string, id: string) {
    return this.serial(owner, id, async () => {
      const server = this.server(id);
      if (!server.oauth)
        throw new AppError("This connector uses administrator configured authentication", 409);
      this.callback();
      const previous = await this.db.get<State>(owner, "mcp-auth", id);
      const nonce = randomBytes(32).toString("base64url"),
        flow = hash(nonce);
      const state: State = {
        id,
        credentialRef: previous?.credentialRef ?? randomUUID(),
        generation: randomUUID(),
        fingerprint: hash(server),
        status: "connecting",
        flow,
      };
      this.activeGenerations.set(`${owner}:${id}`, `pending:${state.generation}`);
      await this.db.put(owner, "mcp-auth", state);
      await this.db.put("__oauth__", "mcp-callbacks", {
        id: flow,
        owner,
        serverId: id,
        generation: state.generation,
        status: "waiting",
        expiresAt: this.now() + 600_000,
      });
      try {
        const session = await this.provider(owner, server, state, nonce);
        const result = await auth(session.provider, {
          serverUrl: server.url,
          fetchFn: this.fetcher(server),
        });
        if (result === "AUTHORIZED") {
          await this.db.compareAndSwap(
            owner,
            "mcp-auth",
            id,
            { generation: state.generation },
            { status: "connected", flow: null },
          );
          return { connected: true };
        }
        if (!session.url) throw new Error("No authorization destination");
        return { url: session.url };
      } catch {
        await this.db.compareAndSwap(
          owner,
          "mcp-auth",
          id,
          { generation: state.generation },
          { status: "needs_auth" },
        );
        throw new AppError(
          "The MCP provider could not authorize this callback or client. Check its registered HTTPS callback/client ID and allowed authorization origins; the administrative API was not published.",
          409,
        );
      }
    });
  }
  async callbackCode(nonce: string, code: string) {
    if (!/^[\w-]{43}$/.test(nonce) || !code || code.length > 4096)
      throw new AppError("Invalid OAuth callback", 422);
    const flow = hash(nonce);
    const record = await this.db.get<{
      id: string;
      owner: string;
      serverId: string;
      generation: string;
      status: string;
      expiresAt: number;
    }>("__oauth__", "mcp-callbacks", flow);
    if (!record || record.status !== "waiting" || record.expiresAt <= this.now())
      throw new AppError("This OAuth callback expired or was already used", 409);
    return this.serial(record.owner, record.serverId, async () => {
      const server = this.server(record.serverId),
        state = await this.db.get<State>(record.owner, "mcp-auth", record.serverId);
      if (
        !state ||
        state.generation !== record.generation ||
        state.flow !== flow ||
        record.expiresAt <= this.now() ||
        state.status !== "connecting" ||
        state.fingerprint !== hash(server)
      )
        throw new AppError("The connector changed; reconnect it", 409);
      if (
        !(await this.db.compareAndSwap(
          "__oauth__",
          "mcp-callbacks",
          flow,
          { status: "waiting" },
          { status: "consumed" },
        ))
      )
        throw new AppError("OAuth callback was already used", 409);
      try {
        const session = await this.provider(record.owner, server, state, nonce);
        const result = await auth(session.provider, {
          serverUrl: server.url,
          authorizationCode: code,
          fetchFn: this.fetcher(server),
        });
        if (result !== "AUTHORIZED") throw new Error("Authorization incomplete");
        await this.db.compareAndSwap(
          record.owner,
          "mcp-auth",
          server.id,
          { generation: state.generation, status: "connecting" },
          { status: "connected", flow: null },
        );
        return { connected: true };
      } catch {
        await this.db.compareAndSwap(
          record.owner,
          "mcp-auth",
          server.id,
          { generation: state.generation },
          { status: "needs_auth" },
        );
        throw new AppError(
          "The provider did not confirm this authorization. Reconnect from Apps.",
          409,
        );
      }
    });
  }
  async access(
    owner: string,
    server: McpServerConfig,
  ): Promise<{ headers: Record<string, string>; generation: string }> {
    if (!server.oauth) return { headers: {}, generation: "environment" };
    return this.serial(owner, server.id, async () => {
      const state = await this.db.get<State>(owner, "mcp-auth", server.id);
      if (!state || state.status !== "connected" || state.fingerprint !== hash(server))
        throw new AppError("Connect this MCP app in Apps", 409);
      const session = await this.provider(owner, server, state);
      let tokens = await session.provider.tokens();
      if (!tokens || Number(session.data.expiresAt) <= this.now() + 60_000) {
        try {
          if (
            (await auth(session.provider, {
              serverUrl: server.url,
              fetchFn: this.fetcher(server),
            })) !== "AUTHORIZED"
          )
            throw new Error();
          tokens = await session.provider.tokens();
        } catch {
          await this.db.compareAndSwap(
            owner,
            "mcp-auth",
            server.id,
            { generation: state.generation },
            { status: "needs_auth" },
          );
          throw new AppError("Reconnect this MCP app; its authorization expired", 409);
        }
      }
      const current = await this.db.get<State>(owner, "mcp-auth", server.id);
      if (!tokens || current?.generation !== state.generation || current.status !== "connected")
        throw new AppError("MCP authorization changed", 409);
      this.remember(tokens);
      this.activeGenerations.set(`${owner}:${server.id}`, state.generation);
      return {
        headers: { Authorization: `${tokens.token_type} ${tokens.access_token}` },
        generation: state.generation,
      };
    });
  }
  async disconnect(owner: string, id: string) {
    return this.serial(owner, id, async () => {
      this.server(id);
      const state = await this.db.get<State>(owner, "mcp-auth", id);
      this.activeGenerations.delete(`${owner}:${id}`);
      if (state) {
        await this.db.put(owner, "mcp-auth", {
          ...state,
          generation: randomUUID(),
          status: "disconnected",
          flow: null,
        });
        const saved = await this.vault.read(owner, state.credentialRef);
        if (saved) await this.vault.delete(owner, state.credentialRef, saved.version);
      }
      return { disconnected: true, providerRevoked: false };
    });
  }
  async status(owner: string) {
    return Promise.all(
      this.servers.map(async (server) => ({
        id: server.id,
        origin: new URL(server.url).origin,
        account: server.account,
        transport: server.transport,
        tools: Object.keys(server.tools),
        oauth: Boolean(server.oauth),
        status: server.oauth
          ? ((await this.db.get<State>(owner, "mcp-auth", server.id))?.status ?? "disconnected")
          : "configured",
      })),
    );
  }
}
