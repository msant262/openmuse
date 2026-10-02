import { resolve } from "node:path";
import { z } from "zod";

export type CompatibleApi = "chat-completions" | "responses";
export interface CompatibleSettings {
  baseUrl: string;
  key?: string;
  api: CompatibleApi;
  imageModel?: string;
}
export interface ModelProviderConfig {
  authDir: string;
  chatgptFile: string;
  grokFile: string;
  openaiImageModel?: string;
  grokImageModel?: string;
  compatible?: CompatibleSettings;
  mimo?: CompatibleSettings;
  local: CompatibleSettings;
}

export function modelSpec(spec: string) {
  const match = spec.trim().match(/^([^/:\s]+)[/:](.+)$/);
  if (!match?.[2].trim()) throw new Error('Invalid MODEL. Use "provider/model-id".');
  return { provider: match[1].toLowerCase(), model: match[2].trim() };
}

export function orderedModels(model: string, fallbacks: readonly string[] = []) {
  return [...new Set([model, ...fallbacks].map((s) => s.trim()).filter(Boolean))].map((spec) => ({
    spec,
    ...modelSpec(spec),
  }));
}

export function modelProviderConfig(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): ModelProviderConfig {
  const authDir = resolve(dataDir, "credentials");
  const api = (name: string, fallback: CompatibleApi): CompatibleApi => {
    const value = env[name]?.trim() || fallback;
    return z.enum(["chat-completions", "responses"]).parse(value);
  };
  const settings = (
    prefix: string,
    defaultUrl?: string,
    defaultApi: CompatibleApi = "chat-completions",
  ): CompatibleSettings | undefined => {
    const baseUrl = env[`${prefix}_BASE_URL`]?.trim() || defaultUrl;
    if (!baseUrl) return undefined;
    const url = new URL(baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        `${prefix}_BASE_URL must be an HTTP(S) URL without embedded credentials, query, or fragment.`,
      );
    return {
      baseUrl: baseUrl.replace(/\/+$/, ""),
      key: env[`${prefix}_API_KEY`]?.trim() || undefined,
      api: api(`${prefix}_API`, defaultApi),
      imageModel: prefix === "MIMO" ? undefined : env[`${prefix}_IMAGE_MODEL`]?.trim() || undefined,
    };
  };
  const mimo = settings("MIMO", undefined, "responses");
  if (mimo && !/^https:\/\/token-plan-[a-z0-9-]+\.xiaomimimo\.com\/v1$/.test(mimo.baseUrl))
    throw new Error(
      "MIMO_BASE_URL must use your region's Xiaomi Token Plan endpoint (https://token-plan-{region}.xiaomimimo.com/v1). For a billed endpoint, select compatible explicitly.",
    );
  return {
    authDir,
    chatgptFile: resolve(env.CHATGPT_AUTH_FILE?.trim() || `${authDir}/chatgpt.json`),
    grokFile: resolve(env.GROK_AUTH_FILE?.trim() || `${authDir}/grok.json`),
    openaiImageModel: env.OPENAI_IMAGE_MODEL?.trim() || undefined,
    grokImageModel: env.GROK_IMAGE_MODEL?.trim() || undefined,
    compatible: settings("OPENAI_COMPATIBLE"),
    mimo,
    local: settings("LOCAL", "http://127.0.0.1:11434/v1") ?? {
      baseUrl: "http://127.0.0.1:11434/v1",
      api: "chat-completions",
    },
  };
}
