import { randomUUID } from "node:crypto";
import { defineTool } from "@copilotkit/runtime/v2";
import { Hono } from "hono";
import { z } from "zod";
import type { CredentialInteractionRequest } from "../../../packages/domain/src/runtime.ts";
import type { SearchInput, SearchResult } from "../../../packages/domain/src/search.ts";
import { configuredSecretScrubber } from "./configured-secrets.ts";
import type { SecretStore } from "./credentials/contracts.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import type { SearchBackend, SearchContext } from "./search.ts";

const provider = {
  id: "tavily" as const,
  name: "Tavily",
  origin: "https://api.tavily.com",
  description: "Web search using your Tavily account",
};
type Connection = {
  id: "tavily";
  credentialRef: string;
  status: "connected" | "disconnected" | "invalid_credentials";
  updatedAt: string;
};
type SetupRequest = {
  id: string;
  integrationId: "tavily";
  expiresAt: string;
  credentialRef: string;
  clientResponseId?: string;
  interaction: CredentialInteractionRequest;
};
const responseSchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string(),
        url: z.string(),
        content: z.string().optional(),
        published_date: z.string().optional(),
      }),
    )
    .max(100),
});

/** Fixed-origin API credentials share the private vault, never model/tool arguments or records. */
export class IntegrationService {
  private queues = new Map<string, Promise<unknown>>();
  constructor(
    private readonly db: Store,
    private readonly vault: SecretStore,
    private readonly options: { available: boolean; fetch?: typeof fetch; now?: () => number },
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private serial<T>(owner: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(owner) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.queues.set(owner, next);
    return next.finally(() => {
      if (this.queues.get(owner) === next) this.queues.delete(owner);
    });
  }
  async catalog(owner: string) {
    const connection = await this.db.get<Connection>(owner, "integrations", provider.id);
    return [
      {
        ...provider,
        status: this.options.available ? (connection?.status ?? "disconnected") : "unavailable",
      },
    ];
  }
  private available() {
    if (!this.options.available)
      throw new AppError("Credential vault is not configured", 503, "VAULT_UNAVAILABLE");
  }
  async request(owner: string, input: { id: "tavily"; threadId?: string }) {
    this.available();
    if (input.id !== provider.id) throw new AppError("Integration not found", 404);
    return this.serial(owner, async () => {
      if (input.threadId) {
        const thread = await this.db.get<{ deletedAt?: string }>(owner, "threads", input.threadId);
        if (!thread || thread.deletedAt) throw new AppError("Conversation not found", 404);
      }
      const existing = (await this.db.list<SetupRequest>(owner, "integration-requests")).find(
        (request) =>
          request.integrationId === input.id &&
          request.interaction.threadId === input.threadId &&
          request.interaction.status === "waiting" &&
          Date.parse(request.expiresAt) > this.now(),
      );
      if (existing) return existing.interaction;
      const id = randomUUID();
      const interaction: CredentialInteractionRequest = {
        id,
        taskId: "integration:tavily",
        revision: 1,
        kind: "credential",
        status: "waiting",
        ...(input.threadId ? { threadId: input.threadId } : {}),
        createdAt: new Date(this.now()).toISOString(),
        schema: {
          integrationId: "tavily",
          title: "Connect Tavily",
          serviceName: "Tavily",
          origin: provider.origin,
          purpose:
            "Save your API key in the private vault to enable Tavily web search. Your key is never sent to the conversation or model.",
          fields: [{ id: "apiKey", label: "API key", type: "password", required: true }],
        },
      };
      const request: SetupRequest = {
        id,
        integrationId: "tavily",
        expiresAt: new Date(this.now() + 30 * 60_000).toISOString(),
        credentialRef: randomUUID(),
        interaction,
      };
      const mutation = await this.db.durableMutation(
        owner,
        `integration-request:${id}`,
        id,
        [
          { kind: "integration-requests", id, mode: "insert", value: request },
          { kind: "interaction-requests", id, mode: "insert", value: interaction },
        ],
        input.threadId
          ? [
              {
                id: `integration-request:${id}`,
                threadId: input.threadId,
                origin: "task",
                kind: "interaction",
                payload: interaction,
              },
            ]
          : [],
      );
      if (!["applied", "duplicate"].includes(mutation.status))
        throw new AppError("The connection request changed. Try again.", 409);
      return interaction;
    });
  }
  private async record(owner: string, id: string) {
    const record = await this.db.get<SetupRequest>(owner, "integration-requests", id);
    if (!record) throw new AppError("Connection request not found", 404);
    return record;
  }
  async status(owner: string, id: string) {
    const record = await this.record(owner, id);
    if (record.interaction.status === "waiting" && Date.parse(record.expiresAt) <= this.now())
      return { ...record.interaction, status: "expired" as const };
    return record.interaction;
  }
  private async call(
    path: "/usage" | "/search",
    apiKey: string,
    body?: unknown,
    signal?: AbortSignal,
  ) {
    try {
      const response = await (this.options.fetch ?? fetch)(`${provider.origin}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if ([401, 403].includes(response.status))
          throw new AppError(
            "Tavily rejected this API key. Check the key and try again.",
            422,
            "INTEGRATION_INVALID_KEY",
          );
        throw new AppError(
          "Tavily is unavailable or its usage limit was reached. Try again later.",
          502,
          "INTEGRATION_UNAVAILABLE",
        );
      }
      // Error bodies are deliberately discarded; they may echo credentials.
      if (path === "/usage") {
        await response.body?.cancel().catch(() => {});
        return undefined;
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader?.read();
          if (!part || part.done) break;
          size += part.value.length;
          if (size > 1024 * 1024) throw new Error("Response exceeds limit");
          chunks.push(part.value);
        }
      } finally {
        await reader?.cancel().catch(() => {});
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof AppError) throw error;
      throw new AppError(
        "Could not reach Tavily. Try again later.",
        502,
        "INTEGRATION_UNAVAILABLE",
      );
    }
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
        throw new AppError(
          "This connection form expired or was already completed. Open a new form.",
          409,
        );
      const parsed = z
        .object({
          apiKey: z
            .string()
            .trim()
            .min(8)
            .max(4096)
            .regex(/^[A-Za-z0-9_-]+$/),
        })
        .strict()
        .safeParse(input.values);
      if (!parsed.success) throw new AppError("Enter a valid API key in the secure field", 422);
      const apiKey = parsed.data.apiKey;
      await this.call("/usage", apiKey);
      // Reuse an uncertain save's reference/version, without storing a digest or plaintext in records.
      try {
        const previous = await this.vault.read(owner, record.credentialRef);
        await this.vault.write(owner, record.credentialRef, { apiKey }, previous?.version ?? 0);
      } catch {
        throw new AppError(
          "The vault could not save this API key. Try again.",
          503,
          "VAULT_UNAVAILABLE",
        );
      }
      const previous = await this.db.get<Connection>(owner, "integrations", provider.id);
      const timestamp = new Date(this.now()).toISOString();
      const interaction: CredentialInteractionRequest = {
        ...record.interaction,
        status: "saved",
        answeredAt: timestamp,
      };
      const connection: Connection = {
        id: "tavily",
        credentialRef: record.credentialRef,
        status: "connected",
        updatedAt: timestamp,
      };
      const mutation = await this.db.durableMutation(
        owner,
        `integration-save:${id}:${input.clientResponseId}`,
        id,
        [
          {
            kind: "integrations",
            id: "tavily",
            mode: previous ? "replace" : "insert",
            ...(previous ? { expected: { credentialRef: previous.credentialRef } } : {}),
            value: connection,
          },
          {
            kind: "integration-requests",
            id,
            mode: "replace",
            expected: { interaction: record.interaction },
            value: { ...record, clientResponseId: input.clientResponseId, interaction },
          },
          { kind: "interaction-requests", id, mode: "replace", value: interaction },
        ],
        interaction.threadId
          ? [
              {
                id: `integration-saved:${id}`,
                threadId: interaction.threadId,
                origin: "user",
                kind: "interaction",
                payload: interaction,
              },
            ]
          : [],
      );
      if (!["applied", "duplicate"].includes(mutation.status))
        throw new AppError("The connection changed while saving. Open the form again.", 409);
      await this.retireRequests(owner, id);
      // Replacing a connection must not leave the prior key recoverable in the vault.
      if (previous && previous.credentialRef !== record.credentialRef)
        await this.vault.delete(owner, previous.credentialRef);
      return interaction;
    });
  }
  async disconnect(owner: string) {
    this.available();
    return this.serial(owner, async () => {
      const current = await this.db.get<Connection>(owner, "integrations", provider.id);
      if (current) {
        await this.vault.delete(owner, current.credentialRef);
        await this.db.put(owner, "integrations", {
          ...current,
          status: "disconnected",
          updatedAt: new Date(this.now()).toISOString(),
        });
      }
      await this.retireRequests(owner);
      return (await this.catalog(owner))[0];
    });
  }
  private async retireRequests(owner: string, except?: string) {
    for (const request of await this.db.list<SetupRequest>(owner, "integration-requests")) {
      if (request.id === except || request.interaction.status !== "waiting") continue;
      const interaction = { ...request.interaction, status: "superseded" as const };
      await this.db.durableMutation(
        owner,
        `integration-retire:${request.id}`,
        request.id,
        [
          {
            kind: "integration-requests",
            id: request.id,
            mode: "replace",
            expected: { interaction: request.interaction },
            value: { ...request, interaction },
          },
          {
            kind: "interaction-requests",
            id: request.id,
            mode: "replace",
            expected: { status: "waiting" },
            value: interaction,
          },
        ],
        interaction.threadId
          ? [
              {
                id: `integration-retired:${request.id}`,
                threadId: interaction.threadId,
                origin: "task",
                kind: "interaction",
                payload: interaction,
              },
            ]
          : [],
      );
    }
  }
  async search(input: SearchInput, context: SearchContext): Promise<SearchResult | null> {
    context.signal?.throwIfAborted();
    const connection = await this.db.get<Connection>(context.owner, "integrations", "tavily");
    if (!this.options.available || connection?.status !== "connected") return null;
    await context.before?.();
    let apiKey: string;
    try {
      const secret = await this.vault.read(context.owner, connection.credentialRef);
      if (!secret?.data.apiKey) return null;
      apiKey = secret.data.apiKey;
    } catch {
      return null;
    }
    try {
      const response = responseSchema.parse(
        await this.call(
          "/search",
          apiKey,
          {
            query: input.query,
            max_results: input.limit,
            search_depth: "basic",
            include_answer: false,
            include_raw_content: false,
            include_images: false,
          },
          context.signal,
        ),
      );
      const scrub = configuredSecretScrubber([apiKey]);
      const sources: SearchResult["sources"] = [];
      for (const item of response.results) {
        let url: URL;
        try {
          url = new URL(item.url);
        } catch {
          continue;
        }
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          item.url.includes(apiKey)
        )
          continue;
        const title = scrub(item.title).trim().slice(0, 300);
        if (!title || url.href.length > 4096) continue;
        sources.push({
          title,
          url: url.href,
          snippet: scrub(item.content ?? "").slice(0, 1000),
          ...(item.published_date ? { date: scrub(item.published_date).slice(0, 80) } : {}),
        });
      }
      return {
        query: input.query,
        status: sources.length ? "ok" : "no_results",
        sources: sources.slice(0, input.limit),
        observedAt: new Date(this.now()).toISOString(),
        truncated: sources.length > input.limit,
        provenance: {
          backend: "http",
          provider: "tavily",
          searchUrl: `${provider.origin}/search`,
          fullPagesRead: false,
        },
      };
    } catch (error) {
      context.signal?.throwIfAborted();
      if (error instanceof AppError && error.code === "INTEGRATION_INVALID_KEY")
        await this.db.compareAndSwap(
          context.owner,
          "integrations",
          "tavily",
          { credentialRef: connection.credentialRef },
          { status: "invalid_credentials" },
        );
      return null;
    }
  }
}

export class ConnectedSearchBackend implements SearchBackend {
  constructor(
    private readonly integrations: IntegrationService,
    private readonly fallback: SearchBackend,
  ) {}
  async search(input: SearchInput, context: SearchContext) {
    return (await this.integrations.search(input, context)) ?? this.fallback.search(input, context);
  }
}

export const integrationInstructions =
  " To connect Tavily or enter its API key, call connect_integration with id tavily immediately. It opens the secure in-app field and returns only connection metadata. Do not claim the connector is unavailable without checking list_integrations. Never ask the person to paste keys into chat, tool arguments, files or commands. Once connected, search_web automatically uses Tavily. Connection setup is not a research task and needs no questionnaire.";
export function integrationTools(
  service: IntegrationService | undefined,
  owner: string,
  threadId?: string,
) {
  if (!service) return [];
  return [
    defineTool({
      name: "list_integrations",
      description: "List available in-app integrations and connection status, without credentials.",
      parameters: z.object({}).strict(),
      execute: () => service.catalog(owner),
    }),
    defineTool({
      name: "connect_integration",
      description:
        "Open the secure in-app API key form for Tavily. No key is accepted by this tool. Use when asked to connect Tavily or how to provide its key.",
      parameters: z.object({ id: z.literal("tavily") }).strict(),
      execute: async ({ id }) => {
        const current = (await service.catalog(owner)).find((integration) => integration.id === id);
        return current?.status === "connected"
          ? {
              ...current,
              message:
                "Tavily is connected and search_web uses it automatically. The key can be replaced in connection settings.",
            }
          : service.request(owner, { id, threadId });
      },
    }),
  ];
}
export function integrationRoutes(service: IntegrationService) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/integrations", async (c) => c.json(await service.catalog(c.get("owner"))));
  app.post("/integrations/tavily/request", async (c) => {
    const body = z
      .object({ threadId: z.string().min(1).max(200).optional() })
      .strict()
      .parse(await c.req.json());
    return c.json(await service.request(c.get("owner"), { id: "tavily", ...body }));
  });
  app.get("/integrations/tavily/requests/:id", async (c) =>
    c.json(await service.status(c.get("owner"), z.uuid().parse(c.req.param("id")))),
  );
  app.post("/integrations/tavily/requests/:id/submit", async (c) => {
    const body = z
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
    return c.json(await service.submit(c.get("owner"), z.uuid().parse(c.req.param("id")), body));
  });
  app.post("/integrations/tavily/disconnect", async (c) =>
    c.json(await service.disconnect(c.get("owner"))),
  );
  return app;
}
