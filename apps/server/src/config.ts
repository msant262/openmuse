import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { type McpServerConfig, readMcpConfig } from "./mcp.ts";
import {
  type ModelProviderConfig,
  modelProviderConfig,
  orderedModels,
} from "./providers/config.ts";
import type { PushConfig } from "./push.ts";

/** .env keys whose file value loses to a different value already set in the environment. */
export function shadowedEnvKeys(
  file: Record<string, string | undefined>,
  env: Record<string, string | undefined> = process.env,
): string[] {
  return Object.keys(file).filter((key) => env[key] !== undefined && env[key] !== file[key]);
}

if (existsSync(".env")) {
  // loadEnvFile never overrides existing variables. A stale shell or system-wide value
  // (for example OPENAI_API_KEY) would otherwise silently replace the .env setting.
  const shadowed = shadowedEnvKeys(parseEnv(readFileSync(".env", "utf8")));
  process.loadEnvFile(".env");
  if (shadowed.length)
    console.warn(
      `[OpenMuse] Using ${shadowed.join(", ")} from the environment instead of .env. ` +
        (shadowed.length === 1
          ? "Unset it to use the .env value."
          : "Unset them to use the .env values."),
    );
}
// Self-hosted threads must never contact the CopilotKit telemetry service.
process.env.DO_NOT_TRACK = "1";
process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";

export interface Config {
  routineTimezone?: string;
  mcpServers?: McpServerConfig[];
  push?: PushConfig;
  mode: "sample" | "live";
  approvalPolicy?: "money" | "all";
  port: number;
  host: string;
  publicUrl: string;
  dataDir: string;
  databaseUrl?: string;
  accessKey?: string;
  encryptionKey?: string;
  model?: string;
  modelFallbacks?: string[];
  modelProviders?: ModelProviderConfig;
  jevMode?: "off" | "sample" | "live";
  typesafeApiKey?: string;
  jevModel?: string;
  agentBackend: "sample" | "model" | "agui";
  agentUrl?: string;
  agentToken?: string;
  intelligenceApiKey?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri: string;
  workerUrl?: string;
  workerToken?: string;
  taskWorkerEnabled?: boolean;
  computerEnabled?: boolean;
  computerImage?: string;
  computerDeploymentId?: string;
  resourceHostId?: string;
  computerBackend?: "docker" | "rpc";
  computerProfile?: "offline" | "open";
  computerUrl?: string;
  computerToken?: string;
  computerCommandTimeoutMs?: number;
  allowedOrigins: string[];
  sessionDeviceIdleDays?: number;
}

/** Pinned so live rankings do not shift when TypeSafe moves the `jev-latest` alias. */
export const defaultJevModel = "jev-1.13.0";

export function required(name: string, message: string, value = process.env[name]): string {
  if (!value?.trim()) throw new Error(message);
  return value.trim();
}

/** Accept a full worker URL, or host:port from a platform that omits the scheme. */
export function browserWorkerUrl(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.includes("://") ? trimmed : `http://${trimmed}`;
}

// Provider SDKs retry transient failures before the response starts, with
// exponential backoff: OpenAI and Anthropic retry HTTP 408, 409, 429, 5xx and
// connection errors and honor retry-after; Gemini retries 408, 429, 500, 502,
// 503 and 504. Other 4xx responses such as 400, 401 and 403 fail on the first
// attempt, and a stream that fails after it starts is not retried. External
// writes never re-fire here: they are dispatched outside the model loop through
// reviewed, idempotency-keyed actions.
export const MODEL_MAX_RETRIES = 2;
function integer(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}
/** The API is mounted at /; subpaths require proxy rewriting and are not accepted. */
function httpOrigin(value: string, name: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTP(S) origin`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      `${name} must be an HTTP(S) origin without credentials, query, fragment or subpath`,
    );
  return url.origin;
}
export function readConfig(): Config {
  const mode = process.env.WORKSPACE_MODE ?? "sample";
  if (mode !== "sample" && mode !== "live")
    throw new Error("WORKSPACE_MODE must be sample or live");
  const backend = process.env.AGENT_BACKEND ?? (mode === "sample" ? "sample" : "model");
  if (backend !== "sample" && backend !== "model" && backend !== "agui")
    throw new Error("AGENT_BACKEND must be sample, model or agui");
  if (mode === "live" && backend === "sample")
    throw new Error("Live workspaces cannot use the sample agent");
  const jevMode = process.env.JEV_MODE ?? "off";
  if (jevMode !== "off" && jevMode !== "sample" && jevMode !== "live")
    throw new Error("JEV_MODE must be off, sample or live");
  const typesafeApiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (jevMode === "live" && !typesafeApiKey)
    throw new Error("JEV_MODE=live requires a nonblank TYPESAFE_API_KEY");
  const port = integer("PORT", 8787, 1, 65535);
  const publicUrl = httpOrigin(
    process.env.PUBLIC_API_URL ?? `http://localhost:${port}`,
    "PUBLIC_API_URL",
  );
  const policy = process.env.APPROVAL_POLICY ?? "money";
  if (policy !== "money" && policy !== "all")
    throw new Error("APPROVAL_POLICY must be money or all");
  const config: Config = {
    approvalPolicy: policy,
    routineTimezone: process.env.ROUTINE_TIMEZONE?.trim() || "UTC",
    mcpServers: readMcpConfig(),
    push: {
      apnsKeyFile: process.env.APNS_KEY_FILE,
      apnsKeyId: process.env.APNS_KEY_ID,
      apnsTeamId: process.env.APNS_TEAM_ID,
      apnsTopic: process.env.APNS_TOPIC,
      apnsSandbox: process.env.APNS_SANDBOX === "true",
      fcmCredentialsFile: process.env.FCM_CREDENTIALS_FILE,
      fcmProjectId: process.env.FCM_PROJECT_ID,
    },
    mode,
    sessionDeviceIdleDays: integer("SESSION_DEVICE_IDLE_DAYS", 0, 0, 36500),
    port,
    host: process.env.HOST ?? "127.0.0.1",
    publicUrl,
    dataDir: resolve(process.env.DATA_DIR ?? ".openmuse"),
    databaseUrl: process.env.DATABASE_URL,
    accessKey: process.env.OPENMUSE_ACCESS_KEY,
    encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
    model: process.env.MODEL,
    modelFallbacks: process.env.MODEL_FALLBACKS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    modelProviders: modelProviderConfig(resolve(process.env.DATA_DIR ?? ".openmuse")),
    jevMode,
    typesafeApiKey,
    jevModel: process.env.JEV_MODEL?.trim() || defaultJevModel,
    agentBackend: backend,
    agentUrl: process.env.AGENT_URL,
    agentToken: process.env.AGENT_TOKEN,
    intelligenceApiKey: process.env.CPK_INTELLIGENCE_API_KEY?.trim() || undefined,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: `${publicUrl}/api/google/callback`,
    workerUrl: browserWorkerUrl(process.env.BROWSER_WORKER_URL),
    workerToken: process.env.WORKER_TOKEN,
    taskWorkerEnabled: process.env.TASK_WORKER_ENABLED !== "false",
    computerEnabled: process.env.COMPUTER_ENABLED === "true",
    computerImage: process.env.COMPUTER_IMAGE ?? "openmuse-computer:local",
    computerDeploymentId: process.env.COMPUTER_DEPLOYMENT_ID,
    resourceHostId: process.env.RESOURCE_HOST_ID?.trim() || "openmuse-server",
    computerBackend: (process.env.COMPUTER_BACKEND ?? "docker") as Config["computerBackend"],
    computerProfile: (process.env.COMPUTER_PROFILE ??
      (process.env.COMPUTER_BACKEND === "rpc" ? "open" : "offline")) as Config["computerProfile"],
    computerUrl: process.env.COMPUTER_URL?.replace(/\/+$/, ""),
    computerToken: process.env.COMPUTER_TOKEN,
    computerCommandTimeoutMs: Number(process.env.COMPUTER_COMMAND_TIMEOUT_MS ?? 1800000),
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "http://localhost:8081,http://127.0.0.1:8081")
      .split(",")
      .map((origin) => httpOrigin(origin.trim(), "ALLOWED_ORIGINS")),
  };
  if (config.model) orderedModels(config.model, config.modelFallbacks);
  if (
    !["docker", "rpc"].includes(config.computerBackend ?? "") ||
    !["offline", "open"].includes(config.computerProfile ?? "")
  )
    throw new Error("COMPUTER_BACKEND must be docker or rpc and COMPUTER_PROFILE offline or open");
  if (
    !Number.isInteger(config.computerCommandTimeoutMs) ||
    (config.computerCommandTimeoutMs ?? 0) < 1000 ||
    (config.computerCommandTimeoutMs ?? 0) > 1800000
  )
    throw new Error("COMPUTER_COMMAND_TIMEOUT_MS must be 1000..1800000");
  if (
    config.computerEnabled &&
    config.computerProfile === "open" &&
    config.computerBackend !== "rpc"
  )
    throw new Error("The open computer profile requires the guarded RPC backend");
  if (config.computerEnabled && config.computerBackend === "rpc") {
    if (
      config.computerProfile !== "open" ||
      !config.computerUrl ||
      !config.computerToken ||
      config.computerToken.length < 32
    )
      throw new Error(
        "RPC computer requires COMPUTER_PROFILE=open, COMPUTER_URL and COMPUTER_TOKEN (32+ characters)",
      );
    const url = new URL(config.computerUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error(
        "COMPUTER_URL must be the guarded HTTP(S) RPC origin without credentials or path",
      );
  }
  if (
    mode === "live" &&
    (!config.accessKey || config.accessKey.length < 24 || !config.encryptionKey)
  )
    throw new Error(
      "Live mode requires OPENMUSE_ACCESS_KEY (24+ characters) and TOKEN_ENCRYPTION_KEY (32-byte base64)",
    );
  if (mode === "sample" && !["127.0.0.1", "localhost", "::1"].includes(config.host))
    throw new Error("Sample workspace is local-only. HOST must be a loopback address.");
  return config;
}
