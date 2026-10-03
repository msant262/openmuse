import type { Config } from "../config.ts";
import { configuredSecretScrubber } from "../configured-secrets.ts";
import type { Store } from "../db.ts";
import { CHATGPT_RESOURCE, chatGPTAccessToken } from "./chatgpt-auth.ts";
import { type ModelProviderConfig, modelProviderConfig } from "./config.ts";
import { GROK_API_URL, grokAccessToken } from "./grok-auth.ts";
import type { ModelCapability } from "./model-capabilities.ts";
import { providerConfigured } from "./models.ts";

export type CatalogModel = {
  id: string;
  label: string;
  provider: string;
  capabilities?: ModelCapability;
};
export type SavedModelCatalog = {
  id: "model-catalog";
  checkedAt: string;
  models: CatalogModel[];
  providers: { provider: string; status: "available" | "unavailable" }[];
};

type CatalogOptions = {
  fetch?: typeof fetch;
  token?: (
    provider: "chatgpt" | "grok",
    config: ModelProviderConfig,
    signal: AbortSignal,
  ) => Promise<string>;
};
/** Public model metadata only. The same protected refresh lock as inference owns token rotation. */
export async function discoverSubscriptionModels(
  providers: ModelProviderConfig,
  options: CatalogOptions = {},
) {
  const output: SavedModelCatalog = {
    id: "model-catalog",
    checkedAt: new Date().toISOString(),
    models: [],
    providers: [],
  };
  await Promise.all(
    (["chatgpt", "grok"] as const).map(async (provider) => {
      if (!providerConfigured(`${provider}/catalog`, providers)) return;
      const signal = AbortSignal.timeout(12_000);
      try {
        const token = options.token
          ? await options.token(provider, providers, signal)
          : provider === "chatgpt"
            ? await chatGPTAccessToken(providers.chatgptFile, {}, signal)
            : await grokAccessToken(providers.grokFile, {}, signal);
        const response = await (options.fetch ?? fetch)(
          `${provider === "chatgpt" ? CHATGPT_RESOURCE : GROK_API_URL}/models`,
          {
            headers: { Authorization: `Bearer ${token}` },
            redirect: "error",
            signal,
          },
        );
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new Error("Unavailable catalog");
        }
        const reader = response.body?.getReader();
        let length = 0;
        const chunks: Uint8Array[] = [];
        try {
          for (;;) {
            const part = await reader?.read();
            if (!part || part.done) break;
            length += part.value.length;
            if (length > 1024 * 1024) throw new Error("Catalog exceeds limit");
            chunks.push(part.value);
          }
        } finally {
          await reader?.cancel().catch(() => {});
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        const entries =
          provider === "chatgpt" ? (body.models ?? body.data) : (body.data ?? body.models);
        if (!Array.isArray(entries)) throw new Error("Invalid catalog");
        const models: CatalogModel[] = [];
        const scrub = configuredSecretScrubber([token]);
        for (const raw of entries.slice(0, 500)) {
          if (!raw || typeof raw !== "object") continue;
          const item = raw as Record<string, unknown>;
          if (item.supported_in_api === false) continue;
          if (provider === "chatgpt" && item.visibility !== undefined && item.visibility !== "list")
            continue;
          const id = item.slug ?? item.id;
          if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,149}$/.test(id)) continue;
          // Catalogs can also contain embeddings, image, audio and realtime models.
          if (
            !/^(?:gpt-|o[1-9](?:-|$)|chatgpt-|grok-)/.test(id) ||
            /image|imagine|video|audio|realtime|transcri|tts|embed|moderation/i.test(id)
          )
            continue;
          if (id.includes(token)) continue;
          const label = scrub(typeof item.display_name === "string" ? item.display_name : id).slice(
            0,
            160,
          );
          const context = item.context_window ?? item.context_length;
          const modalities = Array.isArray(item.input_modalities) ? item.input_modalities : [];
          const features = Array.isArray(item.capabilities) ? item.capabilities : [];
          const capabilities: ModelCapability | undefined =
            typeof context === "number" &&
            Number.isInteger(context) &&
            context >= 256 &&
            context <= 4000000
              ? {
                  contextTokens: context,
                  tools: item.supports_tool_calls !== false,
                  structuredOutput: item.supports_structured_output !== false,
                  vision:
                    modalities.includes("image") ||
                    features.includes("vision") ||
                    features.includes("image") ||
                    (typeof item.prompt_image_token_price === "number" &&
                      item.prompt_image_token_price > 0),
                }
              : undefined;
          models.push({
            id: `${provider}/${id}`,
            label,
            provider,
            ...(capabilities ? { capabilities } : {}),
          });
        }
        output.models.push(...models);
        output.providers.push({ provider, status: "available" });
      } catch {
        output.providers.push({ provider, status: "unavailable" });
      }
    }),
  );
  output.models.sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label),
  );
  return output;
}
const refreshes = new WeakMap<Store, Map<string, Promise<void>>>();
export async function refreshModelCatalog(db: Store, config: Config, owner: string) {
  const saved = await db.get<SavedModelCatalog>(owner, "settings", "model-catalog");
  if (saved && Date.now() - Date.parse(saved.checkedAt) < 5 * 60_000) return;
  let owners = refreshes.get(db);
  if (!owners) {
    owners = new Map();
    refreshes.set(db, owners);
  }
  const existing = owners.get(owner);
  if (existing) return existing;
  const operation = (async () => {
    const catalog = await discoverSubscriptionModels(
      config.modelProviders ?? modelProviderConfig(config.dataDir),
    );
    // A temporary failure does not remove previously discovered selections.
    const refreshed = new Set(
      catalog.providers.filter((item) => item.status === "available").map((item) => item.provider),
    );
    catalog.models.push(...(saved?.models ?? []).filter((item) => !refreshed.has(item.provider)));
    await db.put(owner, "settings", catalog);
  })();
  owners.set(owner, operation);
  try {
    await operation;
  } finally {
    owners.delete(owner);
  }
}
