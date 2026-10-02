import type { Config } from "../config.ts";
import { backgroundFailure } from "../log.ts";
import { chatGPTAccessToken } from "./chatgpt-auth.ts";
import { modelProviderConfig, modelSpec } from "./config.ts";
import { grokAccessToken } from "./grok-auth.ts";

/** Check expiry every minute: idle SIWC sessions renew just before their hourly expiry. */
export function startModelTokenMaintenance(config: Config, intervalMs = 60000) {
  const selected =
    config.agentBackend === "model" && config.model
      ? [config.model, ...(config.modelFallbacks ?? [])].map((s) => modelSpec(s).provider)
      : [];
  const providers = config.modelProviders ?? modelProviderConfig(config.dataDir);
  const abort = new AbortController();
  let running: Promise<void> | undefined;
  const tick = () => {
    if (running || abort.signal.aborted) return;
    running = (async () => {
      for (const provider of new Set(selected)) {
        try {
          if (provider === "chatgpt")
            await chatGPTAccessToken(providers.chatgptFile, {}, abort.signal);
          if (provider === "grok" || provider === "xai-oauth")
            await grokAccessToken(providers.grokFile, {}, abort.signal);
        } catch (error) {
          if (!abort.signal.aborted) backgroundFailure("model-token-refresh", error);
        }
      }
    })().finally(() => {
      running = undefined;
    });
  };
  const timer = selected.some((s) => ["chatgpt", "grok", "xai-oauth"].includes(s))
    ? setInterval(tick, intervalMs)
    : undefined;
  timer?.unref();
  if (timer) tick();
  return async () => {
    if (timer) clearInterval(timer);
    abort.abort();
    await running;
  };
}
