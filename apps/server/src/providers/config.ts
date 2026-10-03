import { resolve } from "node:path";
import { z } from "zod";
import {
  canonicalModel,
  canonicalProvider,
  capabilityConfigSchema,
  type ModelCapability,
} from "./model-capabilities.ts";

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
  codexFile?: string;
  codexImageModel?: string;
  codexResponsesModel?: string;
  openaiImageModel?: string;
  grokImageModel?: string;
  compatible?: CompatibleSettings;
  mimo?: CompatibleSettings;
  local: CompatibleSettings;
  routing?: ModelRoutingConfig;
}

export interface ModelRoutingConfig {
  quotaScope: "process";
  capabilities: Record<string, ModelCapability>;
  quotas: Record<string, { total: number; background: number; interactive: number }>;
  maxAttempts: number;
  deadlineMs: number;
  attemptTimeoutMs: number;
  imageContextTokens: number;
  cooldownMs: number;
}
const quotaSchema = z
  .object({
    total: z.number().int().min(1).max(32),
    background: z.number().int().min(1).max(3).default(3),
    interactive: z.number().int().min(1).max(1).default(1),
  })
  .strict();
export const defaultModelRouting: ModelRoutingConfig = {
  quotaScope: "process",
  capabilities: {},
  quotas: {},
  maxAttempts: 3,
  deadlineMs: 300000,
  attemptTimeoutMs: 60000,
  imageContextTokens: 8192,
  cooldownMs: 200,
};

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
  const json = (name: string) => {
    try {
      return JSON.parse(env[name]?.trim() || "{}");
    } catch {
      throw new Error(`${name} must be valid JSON.`);
    }
  };
  const capabilities = Object.fromEntries(
    Object.entries(capabilityConfigSchema.parse(json("MODEL_CAPABILITIES"))).map(
      ([model, capability]) => [canonicalModel(model), capability],
    ),
  );
  const quotas = Object.fromEntries(
    Object.entries(z.record(z.string(), quotaSchema).parse(json("MODEL_PROVIDER_QUOTAS"))).map(
      ([provider, quota]) => [canonicalProvider(provider), quota],
    ),
  );
  const integer = (name: string, fallback: number, min: number, max: number) =>
    z
      .number()
      .int()
      .min(min)
      .max(max)
      .parse(Number(env[name]?.trim() || fallback));
  if (env.MODEL_QUOTA_SCOPE?.trim() && env.MODEL_QUOTA_SCOPE.trim() !== "process")
    throw new Error(
      "MODEL_QUOTA_SCOPE=shared requires a shared inference admission adapter, which is not configured. This router guarantees quotas within one API process with its embedded worker. Select process explicitly only if each process has a separate quota budget.",
    );
  return {
    authDir,
    chatgptFile: resolve(env.CHATGPT_AUTH_FILE?.trim() || `${authDir}/chatgpt.json`),
    grokFile: resolve(env.GROK_AUTH_FILE?.trim() || `${authDir}/grok.json`),
    codexFile: resolve(env.CODEX_AUTH_FILE?.trim() || `${authDir}/codex.json`),
    codexImageModel: env.CODEX_IMAGE_MODEL?.trim() || "gpt-image-2",
    codexResponsesModel: env.CODEX_IMAGE_RESPONSES_MODEL?.trim() || "gpt-6-astra",
    openaiImageModel: env.OPENAI_IMAGE_MODEL?.trim() || undefined,
    grokImageModel: env.GROK_IMAGE_MODEL?.trim() || undefined,
    compatible: settings("OPENAI_COMPATIBLE"),
    mimo,
    local: settings("LOCAL", "http://127.0.0.1:11434/v1") ?? {
      baseUrl: "http://127.0.0.1:11434/v1",
      api: "chat-completions",
    },
    routing: {
      quotaScope: "process",
      capabilities,
      quotas,
      maxAttempts: integer("MODEL_MAX_ATTEMPTS", 3, 1, 10),
      deadlineMs: integer("MODEL_DEADLINE_MS", 300000, 100, 300000),
      attemptTimeoutMs: integer("MODEL_ATTEMPT_TIMEOUT_MS", 60000, 100, 300000),
      imageContextTokens: integer("MODEL_IMAGE_CONTEXT_TOKENS", 8192, 1, 4000000),
      cooldownMs: integer("MODEL_COOLDOWN_MS", 200, 1, 60000),
    },
  };
}
