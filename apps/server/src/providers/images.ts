import type { ModelProviderConfig } from "./config.ts";
import { modelSpec } from "./config.ts";
import { httpProviderError, ModelProviderError } from "./errors.ts";
import { GROK_API_URL, grokAccessToken } from "./grok-auth.ts";
import { modelCapabilities } from "./models.ts";

/** Media-tool seam: credentials/URLs stay inside the adapter, never in tool results. */
export function imageProvider(
  model: string,
  config: ModelProviderConfig,
  upstream: typeof fetch = fetch,
) {
  const capability = modelCapabilities(model, config);
  if (!capability.imageGeneration || !capability.imageModel) return undefined;
  const { provider } = modelSpec(model);
  const settings = provider === "compatible" ? config.compatible : config.local;
  const subscription = provider === "grok" || provider === "xai-oauth";
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
        ? await grokAccessToken(config.grokFile, {}, signal)
        : provider === "openai"
          ? process.env.OPENAI_API_KEY
          : settings?.key;
      if (provider === "openai" && !key)
        throw new ModelProviderError(
          provider,
          "credentials_missing",
          "The explicitly selected OpenAI image provider has no API key.",
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
