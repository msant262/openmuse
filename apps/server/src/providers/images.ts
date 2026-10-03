import { resolve } from "node:path";
import { codexStatus } from "./codex-auth.ts";
import { codexImageProvider } from "./codex-images.ts";
import type { ModelProviderConfig } from "./config.ts";
import { modelSpec } from "./config.ts";
import { readProtected } from "./credential-store.ts";
import { httpProviderError, ModelProviderError } from "./errors.ts";
import { GROK_API_URL, grokAccessToken } from "./grok-auth.ts";
import { ImageNotDispatchedError } from "./image-errors.ts";
import { modelCapabilities, providerConfigured } from "./models.ts";

/** Media routing is independent of the conversation model. Never add a billed API implicitly. */
export async function availableImageModels(
  selectedModel: string | undefined,
  config: ModelProviderConfig,
) {
  const codexReady = await codexStatus(config.codexFile ?? resolve(config.authDir, "codex.json"))
    .then((status) => status.connected)
    .catch(() => false);
  const grokReady = await readProtected(config.grokFile)
    .then((value) =>
      Boolean(
        value &&
          typeof value === "object" &&
          "provider" in value &&
          value.provider === "grok" &&
          "access_token" in value &&
          value.access_token &&
          "refresh_token" in value &&
          value.refresh_token,
      ),
    )
    .catch(() => false);
  const configured =
    selectedModel &&
    (!/^(grok|xai-oauth)\//.test(selectedModel) || grokReady) &&
    providerConfigured(selectedModel, config) &&
    imageProvider(selectedModel, config)
      ? [selectedModel]
      : [];
  const codex = codexReady ? ["codex/gpt-image-2"] : [];
  const grok = grokReady ? ["grok/grok-imagine-image-2.0"] : [];
  return [...new Set([...codex, ...grok, ...configured])];
}

/** Media-tool seam: credentials/URLs stay inside the adapter, never in tool results. */
export function imageProvider(
  model: string,
  config: ModelProviderConfig,
  upstream: typeof fetch = fetch,
) {
  if (modelSpec(model).provider === "codex") return codexImageProvider(config, upstream);
  const capability = modelCapabilities(model, config);
  const subscription = ["grok", "xai-oauth"].includes(modelSpec(model).provider);
  if (subscription && !capability.imageModel) {
    capability.imageModel = "grok-imagine-image-2.0";
    capability.imageGeneration = true;
  }
  if (!capability.imageGeneration || !capability.imageModel) return undefined;
  const { provider } = modelSpec(model);
  const settings = provider === "compatible" ? config.compatible : config.local;
  if (!subscription && provider !== "openai" && !settings) return undefined;
  const baseUrl = subscription
    ? GROK_API_URL
    : provider === "openai"
      ? process.env.OPENAI_BASE_URL?.replace(/\/+$/, "") || "https://api.openai.com/v1"
      : settings?.baseUrl;
  return {
    model: capability.imageModel,
    async generate(body: Record<string, unknown>, signal?: AbortSignal) {
      const key = subscription
        ? await grokAccessToken(config.grokFile, {}, signal).catch((error) => {
            throw new ImageNotDispatchedError(error);
          })
        : provider === "openai"
          ? process.env.OPENAI_API_KEY
          : settings?.key;
      if (provider === "openai" && !key)
        throw new ImageNotDispatchedError(
          new ModelProviderError(
            provider,
            "credentials_missing",
            "The explicitly selected OpenAI image provider has no API key.",
          ),
        );
      let response: Response;
      try {
        response = await upstream(`${baseUrl}/images/generations`, {
          method: "POST",
          redirect: "error",
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
            : AbortSignal.timeout(120000),
          headers: {
            "Content-Type": "application/json",
            ...(key && { Authorization: `Bearer ${key}` }),
            "User-Agent": "OpenMuse/0.1",
          },
          body: JSON.stringify({ ...body, model: capability.imageModel }),
        });
      } catch {
        if (signal?.aborted) signal.throwIfAborted();
        throw new ModelProviderError(
          provider,
          "provider_network_error",
          "Image generation could not be reached. Try again later.",
        );
      }
      if (!response.ok) throw await httpProviderError(provider, response);
      return response;
    },
  };
}
