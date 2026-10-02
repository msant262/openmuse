import { existsSync } from "node:fs";
import type { AdapterYieldChunk, AnyTextAdapter, TextOptions } from "@tanstack/ai";
import { type AnthropicChatModel, anthropicText } from "@tanstack/ai-anthropic";
import { type GeminiTextModel, geminiText } from "@tanstack/ai-gemini";
import { type OpenAIChatModel, openaiText } from "@tanstack/ai-openai";
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible";
import { MODEL_MAX_RETRIES } from "../config.ts";
import {
  type ModelProviderConfig,
  modelProviderConfig,
  modelSpec,
  orderedModels,
} from "./config.ts";
import { fallbackAllowed, ModelProviderError, publicProviderMessage, safeCode } from "./errors.ts";
import { GROK_API_URL } from "./grok-auth.ts";
import { type DispatchState, providerFetch } from "./transport.ts";

const known = [
  "openai",
  "anthropic",
  "google",
  "gemini",
  "google-gemini",
  "compatible",
  "mimo",
  "local",
  "ollama",
  "llamacpp",
  "chatgpt",
  "grok",
  "xai-oauth",
];
export type ModelSelection = { provider: string; model: string; fallback: boolean };
export function unknownProvider(
  provider: string,
  spec: string,
  baseUrl = process.env.OPENAI_BASE_URL,
) {
  const hint = baseUrl?.trim()
    ? ` For a model on your OPENAI_BASE_URL gateway, use "openai/${spec.trim()}".`
    : "";
  return new Error(
    `Unknown provider "${provider}" in "${spec}". Supported: ${known.join(", ")}.${hint}`,
  );
}

export function providerConfigured(model: string, config: ModelProviderConfig) {
  const { provider } = modelSpec(model);
  switch (provider) {
    case "openai":
      return Boolean(process.env.OPENAI_API_KEY?.trim());
    case "anthropic":
      return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
    case "google":
    case "gemini":
    case "google-gemini":
      return Boolean(process.env.GOOGLE_API_KEY?.trim() || process.env.GEMINI_API_KEY?.trim());
    case "compatible":
      return Boolean(config.compatible);
    case "mimo":
      return Boolean(config.mimo?.key);
    case "local":
    case "ollama":
    case "llamacpp":
      return true;
    case "chatgpt":
      return existsSync(config.chatgptFile);
    case "grok":
    case "xai-oauth":
      return existsSync(config.grokFile);
    default:
      return false;
  }
}

function attempt(spec: string, config: ModelProviderConfig) {
  const { provider: alias, model } = modelSpec(spec);
  const provider = alias === "xai-oauth" ? "grok" : alias;
  const state: DispatchState = { accepted: false };
  const transport = providerFetch(
    provider,
    state,
    config,
    fetch,
    ["openai", "anthropic", "google", "gemini", "google-gemini"].includes(provider),
  );
  const missingKey = (value: string | undefined) => {
    if (!value?.trim())
      throw new ModelProviderError(
        provider,
        "credentials_missing",
        `${provider} is missing its configured API key.`,
      );
  };
  let adapter: AnyTextAdapter;
  switch (provider) {
    case "openai":
      missingKey(process.env.OPENAI_API_KEY);
      adapter = openaiText(model as OpenAIChatModel, {
        baseURL: process.env.OPENAI_BASE_URL,
        maxRetries: MODEL_MAX_RETRIES,
        fetch: transport,
      });
      break;
    case "anthropic":
      missingKey(process.env.ANTHROPIC_API_KEY);
      adapter = anthropicText(model as AnthropicChatModel, {
        baseURL: process.env.ANTHROPIC_BASE_URL?.replace(/\/v1\/?$/, ""),
        maxRetries: MODEL_MAX_RETRIES,
        fetch: transport,
      });
      break;
    case "google":
    case "gemini":
    case "google-gemini":
      missingKey(process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY);
      adapter = geminiText(model as GeminiTextModel, {
        httpOptions: {
          baseUrl: process.env.GOOGLE_GENERATIVE_AI_BASE_URL?.replace(/\/v1beta\/?$/, ""),
          fetch: transport,
          retryOptions: { attempts: MODEL_MAX_RETRIES + 1 },
        },
      });
      break;
    case "compatible":
    case "mimo":
    case "local":
    case "ollama":
    case "llamacpp": {
      const settings =
        provider === "compatible"
          ? config.compatible
          : provider === "mimo"
            ? config.mimo
            : config.local;
      if (!settings)
        throw new ModelProviderError(
          provider,
          "configuration_missing",
          `${provider} requires its configured base URL.`,
        );
      if (provider === "mimo") missingKey(settings.key);
      adapter = openaiCompatibleText(model, {
        name: provider,
        baseURL: settings.baseUrl,
        apiKey: settings.key ?? "keyless-local-provider",
        api: settings.api,
        fetch: transport,
        maxRetries: MODEL_MAX_RETRIES,
      });
      break;
    }
    case "chatgpt":
    case "grok":
      adapter = openaiCompatibleText(model, {
        name: provider,
        baseURL: provider === "chatgpt" ? "https://api.openai.com/v1" : GROK_API_URL,
        apiKey: "resolved-at-dispatch",
        api: "responses",
        fetch: transport,
        maxRetries: 0,
      });
      break;
    default:
      throw unknownProvider(provider, spec);
  }
  return { adapter, state, provider };
}

/** One model request at a time. The TanStack engine owns tools and completed history. */
class OrderedModelAdapter implements AnyTextAdapter {
  readonly kind = "text" as const;
  readonly name = "openmuse-models";
  readonly model: string;
  declare "~types": AnyTextAdapter["~types"];
  private selected = 0;
  private reported = -1;
  constructor(
    private readonly models: string[],
    private readonly config: ModelProviderConfig,
    private readonly onSelected?: (model: ModelSelection) => void,
  ) {
    this.model = modelSpec(models[0]).model;
    for (const spec of models) {
      const { provider } = modelSpec(spec);
      if (!known.includes(provider)) throw unknownProvider(provider, spec);
    }
  }
  async *chatStream(options: TextOptions): AsyncIterable<AdapterYieldChunk> {
    for (let index = this.selected; index < this.models.length; index++) {
      options.request?.signal?.throwIfAborted();
      let current: ReturnType<typeof attempt> | undefined;
      let visible = false;
      const pending: AdapterYieldChunk[] = [];
      try {
        current = attempt(this.models[index], this.config);
        for await (const event of current.adapter.chatStream({
          ...options,
          model: current.adapter.model,
        })) {
          if (event.type === "RUN_STARTED") {
            pending.push(event);
            continue;
          }
          if (
            event.type === "RUN_ERROR" &&
            !visible &&
            !current.state.accepted &&
            current.state.failure &&
            fallbackAllowed(current.state.failure) &&
            index < this.models.length - 1 &&
            !options.request?.signal?.aborted
          )
            break;
          if (!visible) {
            this.selected = index;
            if (current.state.accepted && this.reported !== index) {
              this.onSelected?.({
                provider: current.provider,
                model: current.adapter.model,
                fallback: index > 0,
              });
              this.reported = index;
            }
            for (const start of pending) yield start;
            visible = true;
          }
          if (
            event.type === "RUN_ERROR" &&
            !["openai", "anthropic", "google", "gemini", "google-gemini"].includes(current.provider)
          ) {
            const failure = current.state.failure;
            const code = safeCode(event.code);
            const message =
              failure?.message ??
              (code?.startsWith("subscription_sharing_")
                ? publicProviderMessage(current.provider, code)
                : `${current.provider}'s response was interrupted or incomplete. Existing tool results were kept; send a follow-up to continue.`);
            yield {
              ...event,
              rawEvent: undefined,
              message,
              error: { message, code: safeCode(event.code) },
              code: safeCode(event.code),
            };
          } else yield event;
        }
        if (visible || current.state.accepted || !current.state.failure) return;
      } catch (error) {
        if (
          options.request?.signal?.aborted ||
          visible ||
          current?.state.accepted ||
          !fallbackAllowed(error) ||
          index === this.models.length - 1
        )
          throw error;
      }
      // Advance for the next request too; never rerun a rejected primary every tool step.
      this.selected = index + 1;
    }
  }
  supportsCombinedToolsAndSchema() {
    return true;
  }
  async structuredOutput(options: Parameters<AnyTextAdapter["structuredOutput"]>[0]) {
    const current = attempt(this.models[this.selected], this.config);
    if (current.provider === "chatgpt")
      throw new ModelProviderError(
        "chatgpt",
        "unsupported_route",
        "Sign in with ChatGPT requires streaming structured output.",
      );
    return current.adapter.structuredOutput({
      ...options,
      chatOptions: { ...options.chatOptions, model: current.adapter.model },
    });
  }
  async *structuredOutputStream(
    options: Parameters<NonNullable<AnyTextAdapter["structuredOutputStream"]>>[0],
  ): AsyncIterable<AdapterYieldChunk> {
    const current = attempt(this.models[this.selected], this.config);
    if (!current.adapter.structuredOutputStream)
      throw new Error("Selected model has no streaming structured output adapter.");
    yield* current.adapter.structuredOutputStream({
      ...options,
      chatOptions: { ...options.chatOptions, model: current.adapter.model },
    });
  }
}

export function modelAdapter(
  model: string,
  fallbacks: readonly string[] = [],
  config = modelProviderConfig(process.env.DATA_DIR ?? ".openmuse"),
  onSelected?: (model: ModelSelection) => void,
): AnyTextAdapter {
  return new OrderedModelAdapter(
    orderedModels(model, fallbacks).map(({ spec }) => spec),
    config,
    onSelected,
  );
}

/** Capability seam for the computer/media milestone. Only explicitly configured image routes. */
export function modelCapabilities(model: string, config: ModelProviderConfig) {
  const { provider } = modelSpec(model);
  const settings =
    provider === "compatible"
      ? config.compatible
      : ["local", "ollama", "llamacpp"].includes(provider)
        ? config.local
        : undefined;
  const imageModel =
    provider === "openai"
      ? config.openaiImageModel
      : ["grok", "xai-oauth"].includes(provider)
        ? config.grokImageModel
        : settings?.imageModel;
  return {
    audioInput: provider !== "chatgpt",
    imageInput: "model-dependent" as const,
    imageGeneration: provider !== "chatgpt" && Boolean(imageModel),
    imageModel: provider === "chatgpt" ? undefined : imageModel,
  };
}
