import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { type Message, MessageSchema } from "@ag-ui/core";
import type { AdapterYieldChunk, AnyTextAdapter, ModelMessage, TextOptions } from "@tanstack/ai";
import { type AnthropicChatModel, anthropicText } from "@tanstack/ai-anthropic";
import { type GeminiTextModel, geminiText } from "@tanstack/ai-gemini";
import { type OpenAIChatModel, openaiText } from "@tanstack/ai-openai";
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible";
import { z } from "zod";
import type { ModelRequirements, WorkClass } from "../../../../packages/domain/src/runtime.ts";
import { modelAdmission, modelAdmissionSchema } from "./admission-diagnostics.ts";
import {
  type BrowserImageLoader,
  browserImageMessages,
  browserImageReference,
} from "./browser-images.ts";
import {
  defaultModelRouting,
  type ModelProviderConfig,
  modelProviderConfig,
  modelSpec,
  orderedModels,
} from "./config.ts";
import {
  fallbackAllowed,
  ModelProviderError,
  ModelUnavailableError,
  publicProviderMessage,
} from "./errors.ts";
import { GROK_API_URL } from "./grok-auth.ts";
import { canonicalModel, requestRequirements } from "./model-capabilities.ts";
import { type ModelLease, type ModelRouter, sharedModelRouter } from "./model-router.ts";
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
export const providerContinuationCheckpointSchema = z
  .object({
    version: z.literal(1),
    // AG-UI currently ships Zod 3. Validate through its boundary rather than
    // embedding that schema in Zod 4; whitelist history roles and public fields.
    messages: z
      .array(
        z.unknown().transform((input, ctx): Message => {
          const parsed = MessageSchema.safeParse(input);
          if (!parsed.success || !["user", "assistant", "tool"].includes(parsed.data.role)) {
            ctx.addIssue({ code: "custom", message: "Invalid continuation history message" });
            return z.NEVER;
          }
          const message = parsed.data;
          return MessageSchema.parse({
            id: message.id,
            role: message.role,
            content: Array.isArray(message.content)
              ? message.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n")
              : message.content,
            ...(message.role === "assistant" && message.toolCalls
              ? {
                  toolCalls: message.toolCalls.map((call) => ({
                    id: call.id,
                    type: "function" as const,
                    function: { name: call.function.name, arguments: call.function.arguments },
                  })),
                }
              : {}),
            ...(message.role === "tool" ? { toolCallId: message.toolCallId } : {}),
          });
        }),
      )
      .transform((messages) => {
        const completed = new Set(
          messages
            .filter((message) => message.role === "tool")
            .map((message) => message.toolCallId),
        );
        return messages.map((message) =>
          message.role === "assistant" && message.toolCalls
            ? { ...message, toolCalls: message.toolCalls.filter((call) => completed.has(call.id)) }
            : message,
        );
      }),
    partialText: z.string(),
    rejectedModel: z.string().min(1),
    accepted: z.boolean(),
    code: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
    failureCode: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,100}$/)
      .optional(),
    retryAt: z.iso.datetime().optional(),
    admission: modelAdmissionSchema.optional(),
  })
  .strict();
export type ProviderContinuationCheckpoint = z.infer<typeof providerContinuationCheckpointSchema>;
export interface ModelAdapterRuntime {
  /** A host harness may supply its own token accounting for model admission. */
  contextEstimate?: (options: TextOptions) => number;
  /** The native harness owns total and streaming idle deadlines. */
  harnessDeadlineMs?: number;
  /** Model-visible schemas; the owner retains the complete authorized execution registry. */
  projectTools?: (tools: NonNullable<TextOptions["tools"]>) => NonNullable<TextOptions["tools"]>;
  /** Resolve harness parameters for the actual admitted route, including fallbacks. */
  modelOptions?: (spec: string) => Record<string, unknown>;
  /** Reply composition prefers a final answer over a provider's progress preamble. */
  preferFinalText?: () => boolean;
  /** A successful model turn received these owner-verified image pixels. */
  onFileImageObserved?: (fileId: string) => Promise<void>;
  workClass?: WorkClass;
  requirements?: Partial<ModelRequirements>;
  router?: ModelRouter;
  onInterrupted?: (checkpoint: ProviderContinuationCheckpoint) => Promise<void> | void;
}

/** Persist AG-UI text/tool receipts, never hydrated images, thinking, raw errors or provider metadata. */
export function continuationMessages(messages: ModelMessage[]): Message[] {
  const completed = new Set(messages.filter((m) => m.role === "tool").map((m) => m.toolCallId));
  return messages.map((message) => {
    const content =
      typeof message.content === "string"
        ? message.content
        : (message.content ?? [])
            .filter((p) => p.type === "text")
            .map((p) => ("content" in p ? p.content : ""))
            .join("\n");
    const toolCalls = message.toolCalls
      ?.filter((call) => completed.has(call.id))
      .map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.function.name, arguments: call.function.arguments },
      }));
    return MessageSchema.parse({
      id: message.id ?? randomUUID(),
      role: message.role,
      content,
      ...(toolCalls?.length ? { toolCalls } : {}),
      ...(message.role === "tool" ? { toolCallId: message.toolCallId } : {}),
    });
  });
}
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

function attempt(spec: string, config: ModelProviderConfig, expectedStreaming = false) {
  const { provider: alias, model } = modelSpec(spec);
  const provider = alias === "xai-oauth" ? "grok" : alias;
  const state: DispatchState = { accepted: false, expectedStreaming };
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
        maxRetries: 0,
        fetch: transport,
      });
      break;
    case "anthropic":
      missingKey(process.env.ANTHROPIC_API_KEY);
      adapter = anthropicText(model as AnthropicChatModel, {
        baseURL: process.env.ANTHROPIC_BASE_URL?.replace(/\/v1\/?$/, ""),
        maxRetries: 0,
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
          retryOptions: { attempts: 1 },
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
        maxRetries: 0,
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
  private readonly router: ModelRouter;
  constructor(
    private readonly models: string[],
    private readonly config: ModelProviderConfig,
    private readonly onSelected?: (model: ModelSelection) => void,
    private readonly loadBrowserImage?: BrowserImageLoader,
    private readonly loadFileImage?: BrowserImageLoader,
    private readonly runtime: ModelAdapterRuntime = {},
  ) {
    this.model = modelSpec(models[0]).model;
    for (const spec of models) {
      const { provider } = modelSpec(spec);
      if (!known.includes(provider)) throw unknownProvider(provider, spec);
    }
    this.router = runtime.router ?? sharedModelRouter(config);
    this.router.register(models);
  }
  async *chatStream(options: TextOptions): AsyncIterable<AdapterYieldChunk> {
    const messages = await browserImageMessages(
      options.messages,
      this.loadBrowserImage,
      this.loadFileImage,
    );
    yield* this.stream({ ...options, messages }, options.messages, false);
  }
  supportsCombinedToolsAndSchema() {
    return true;
  }
  async structuredOutput(options: Parameters<AnyTextAdapter["structuredOutput"]>[0]) {
    const routing = this.config.routing ?? defaultModelRouting;
    const deadline = Date.now() + (this.runtime.harnessDeadlineMs ?? routing.deadlineMs);
    const signal = this.signal(options.chatOptions, routing.deadlineMs);
    const messages = await browserImageMessages(
      options.chatOptions.messages,
      this.loadBrowserImage,
      this.loadFileImage,
    );
    const chatOptions = {
      ...options.chatOptions,
      messages,
      outputSchema: options.outputSchema,
      tools:
        this.runtime.projectTools?.(options.chatOptions.tools ?? []) ?? options.chatOptions.tools,
    };
    const requirements = this.requirements(chatOptions);
    let excluded: string[] = [];
    for (let count = 0; count < routing.maxAttempts; count++) {
      let lease: ModelLease | undefined, current: ReturnType<typeof attempt> | undefined;
      let dispatchSignal = signal;
      try {
        lease = await this.acquire(requirements, signal, deadline, excluded);
        dispatchSignal = this.attemptSignal(signal, deadline);
        current = attempt(lease.model, this.config);
        if (current.provider === "chatgpt")
          throw new ModelProviderError(
            "chatgpt",
            "unsupported_route",
            "Sign in with ChatGPT requires streaming structured output.",
          );
        const result = await current.adapter.structuredOutput({
          ...options,
          chatOptions: {
            ...chatOptions,
            modelOptions: {
              ...chatOptions.modelOptions,
              ...this.runtime.modelOptions?.(lease.model),
            },
            model: current.adapter.model,
            request: this.request(options.chatOptions.request, dispatchSignal),
          },
        });
        await this.fileImageObserved(options.chatOptions.messages);
        this.report(lease, current);
        this.router.release(lease, { status: "succeeded" });
        return result;
      } catch (error) {
        let failure: ModelProviderError;
        try {
          failure = this.failure(error, current, dispatchSignal);
        } catch (aborted) {
          if (lease) this.router.release(lease, { status: "cancelled" });
          throw aborted;
        }
        if (lease) this.router.release(lease, { status: "failed", failure });
        if (signal.aborted || current?.state.accepted || !fallbackAllowed(failure)) throw failure;
        excluded = await this.retry(
          lease?.model,
          failure,
          excluded,
          count,
          deadline,
          signal,
          requirements,
        );
      }
    }
    throw new ModelUnavailableError("cooldown");
  }
  async *structuredOutputStream(
    options: Parameters<NonNullable<AnyTextAdapter["structuredOutputStream"]>>[0],
  ): AsyncIterable<AdapterYieldChunk> {
    const messages = await browserImageMessages(
      options.chatOptions.messages,
      this.loadBrowserImage,
      this.loadFileImage,
    );
    yield* this.stream(
      { ...options.chatOptions, messages, outputSchema: options.outputSchema },
      options.chatOptions.messages,
      true,
    );
  }

  private signal(options: TextOptions, deadlineMs: number) {
    const signals: AbortSignal[] = this.runtime.harnessDeadlineMs
      ? []
      : [AbortSignal.timeout(deadlineMs)];
    if (options.request?.signal) signals.push(options.request.signal);
    return AbortSignal.any(signals);
  }
  private async fileImageObserved(messages: ModelMessage[]) {
    const reference = browserImageReference(messages);
    if (reference?.file && this.loadFileImage)
      await this.runtime.onFileImageObserved?.(reference.id);
  }
  private attemptSignal(signal: AbortSignal, deadline: number) {
    if (this.runtime.harnessDeadlineMs) return signal;
    const timeout = Math.max(
      1,
      Math.min(this.config.routing?.attemptTimeoutMs ?? 60000, deadline - Date.now()),
    );
    return AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
  }
  private request(request: TextOptions["request"], signal: AbortSignal): Request | RequestInit {
    return request instanceof Request ? new Request(request, { signal }) : { ...request, signal };
  }
  private requirements(options: TextOptions) {
    const requirements = requestRequirements(
      options,
      this.runtime.requirements,
      this.config.routing?.imageContextTokens,
    );
    if (this.runtime.contextEstimate)
      requirements.contextTokens = Math.max(
        this.runtime.contextEstimate(options),
        this.runtime.requirements?.contextTokens ?? 0,
      );
    return requirements;
  }
  private candidates(requirements: ModelRequirements) {
    // Keep an accepted fallback sticky while it still fits the next request.
    // Images, schemas or growing context can require an earlier configured model.
    return this.router.eligibleModels(requirements, [this.models[this.selected]]).length
      ? this.models.slice(this.selected)
      : this.models;
  }
  private acquire(
    requirements: ModelRequirements,
    signal: AbortSignal,
    deadline: number,
    excluded: string[],
  ) {
    return this.router.select({
      models: this.candidates(requirements),
      workClass: this.runtime.workClass ?? "interactive",
      requirements,
      excludedModels: excluded,
      signal,
      deadline,
    });
  }
  private report(lease: ModelLease, current: ReturnType<typeof attempt>) {
    const index = this.models.indexOf(lease.model);
    this.selected = index;
    if (this.reported !== index) {
      this.router.selected(lease.model, index > 0);
      this.onSelected?.({
        provider: current.provider,
        model: current.adapter.model,
        fallback: index > 0,
      });
      this.reported = index;
    }
  }
  private failure(
    error: unknown,
    current: ReturnType<typeof attempt> | undefined,
    signal: AbortSignal,
  ) {
    if (current?.state.failure) return current.state.failure;
    if (error instanceof ModelProviderError) return error;
    if (signal.aborted && signal.reason?.name !== "TimeoutError") throw signal.reason;
    const provider = current?.provider ?? "models";
    const code = signal.aborted
      ? "provider_timeout"
      : current?.state.accepted
        ? "provider_stream_incomplete"
        : "model_request_invalid";
    return new ModelProviderError(
      provider,
      code,
      publicProviderMessage(provider, code),
      signal.aborted ? 408 : undefined,
    );
  }
  private async retry(
    model: string | undefined,
    failure: ModelProviderError,
    excluded: string[],
    count: number,
    deadline: number,
    signal: AbortSignal,
    requirements: ModelRequirements,
  ) {
    const routing = this.config.routing ?? defaultModelRouting;
    const next = [...excluded, ...(model ? [model] : [])];
    const candidates = this.router.eligibleModels(requirements, this.candidates(requirements));
    if (!candidates.length) throw new ModelUnavailableError("capability");
    if (count + 1 >= routing.maxAttempts)
      throw new ModelUnavailableError(
        "cooldown",
        Math.min(...candidates.map((m) => this.router.health.get(m).cooldownUntil)),
      );
    const excludedCandidates = new Set(next.map(canonicalModel));
    if (
      candidates.some(
        (m) =>
          !excludedCandidates.has(canonicalModel(m)) &&
          this.router.health.get(m).cooldownUntil <= Date.now(),
      )
    )
      return next;
    const transient =
      [408, 409, 429].includes(failure.status ?? 0) ||
      (failure.status ?? 0) >= 500 ||
      ["provider_network_error", "provider_timeout"].includes(failure.code);
    const retryAt = Math.min(...candidates.map((m) => this.router.health.get(m).cooldownUntil));
    const delay = Math.max(1, retryAt - Date.now());
    if (!transient || retryAt >= deadline || delay > 2000)
      throw new ModelUnavailableError("cooldown", retryAt);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, delay);
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
    });
    return [];
  }
  private async *stream(
    options: TextOptions,
    originalMessages: ModelMessage[],
    structured: boolean,
  ): AsyncIterable<AdapterYieldChunk> {
    options = {
      ...options,
      tools: this.runtime.projectTools?.(options.tools ?? []) ?? options.tools,
    };
    const routing = this.config.routing ?? defaultModelRouting;
    const requirements = this.requirements(options);
    const deadline = Date.now() + (this.runtime.harnessDeadlineMs ?? routing.deadlineMs),
      signal = this.signal(options, routing.deadlineMs);
    let excluded: string[] = [],
      partialText = "";
    for (let count = 0; count < routing.maxAttempts; count++) {
      let lease: ModelLease | undefined, current: ReturnType<typeof attempt> | undefined;
      let dispatchSignal = signal;
      const dispatchController = new AbortController();
      let visible = false;
      let terminal: AdapterYieldChunk | undefined;
      const pending: AdapterYieldChunk[] = [],
        tools: AdapterYieldChunk[] = [];
      try {
        lease = await this.acquire(requirements, signal, deadline, excluded);
        dispatchSignal = AbortSignal.any([
          this.attemptSignal(signal, deadline),
          dispatchController.signal,
        ]);
        current = attempt(lease.model, this.config, true);
        current.state.preferFinalText = this.runtime.preferFinalText?.();
        const prepared = {
          ...options,
          modelOptions: { ...options.modelOptions, ...this.runtime.modelOptions?.(lease.model) },
          model: current.adapter.model,
          request: this.request(options.request, dispatchSignal),
        };
        const events = structured
          ? current.adapter.structuredOutputStream?.({
              chatOptions: prepared,
              outputSchema: options.outputSchema as Parameters<
                AnyTextAdapter["structuredOutput"]
              >[0]["outputSchema"],
            })
          : current.adapter.chatStream(prepared);
        if (!events)
          throw new ModelProviderError(
            current.provider,
            "capability_unavailable",
            "Este modelo não oferece saída estruturada em streaming.",
          );
        for await (const event of events) {
          if (event.type === "RUN_STARTED") {
            if (current.state.accepted) this.report(lease, current);
            pending.push(event);
            continue;
          }
          if (event.type === "RUN_ERROR") throw this.failure(event, current, dispatchSignal);
          if (event.type.startsWith("TOOL_CALL_")) {
            tools.push(event);
            continue;
          }
          if (event.type === "RUN_FINISHED") {
            if (
              current.state.completed === false ||
              (current.state.requiresCompletion && current.state.completed !== true)
            )
              throw this.failure(event, current, signal);
            terminal = event;
            continue;
          }
          if (!visible) {
            this.report(lease, current);
            for (const start of pending) yield start;
            visible = true;
          }
          if (event.type === "TEXT_MESSAGE_CONTENT") partialText += event.delta;
          yield event;
        }
        if (!terminal || (current.state.requiresCompletion && current.state.completed !== true))
          throw new ModelProviderError(
            current.provider,
            "provider_stream_incomplete",
            "A resposta do provedor não confirmou conclusão. O progresso foi preservado.",
          );
        // SIWC can omit streamed function calls from response.completed.output. The
        // Responses SDK then reports "stop", which skips TanStack's tool phase.
        // Only recover completed calls after the entire inference is verified.
        if (
          current.provider === "chatgpt" &&
          terminal.finishReason === "stop" &&
          tools.some((event) => event.type === "TOOL_CALL_END")
        )
          terminal = { ...terminal, finishReason: "tool_calls" };
        if (!visible) {
          this.report(lease, current);
          for (const start of pending) yield start;
        }
        this.router.release(lease, { status: "succeeded" });
        await this.fileImageObserved(originalMessages);
        for (const tool of tools) yield tool;
        yield terminal;
        return;
      } catch (error) {
        let failure: ModelProviderError;
        try {
          failure = this.failure(error, current, dispatchSignal);
        } catch (aborted) {
          if (lease) this.router.release(lease, { status: "cancelled" });
          throw aborted;
        }
        if (lease) this.router.release(lease, { status: "failed", failure });
        const accepted = Boolean(current?.state.accepted);
        if (!accepted && !visible && fallbackAllowed(failure) && !signal.aborted) {
          try {
            excluded = await this.retry(
              lease?.model,
              failure,
              excluded,
              count,
              deadline,
              signal,
              requirements,
            );
            continue;
          } catch (error) {
            failure =
              error instanceof ModelProviderError ? error : this.failure(error, current, signal);
          }
        }
        const code = accepted || visible ? "MODEL_PROVIDER_INTERRUPTED" : failure.code;
        const retryable =
          failure.code !== "subscription_sharing_usage_limit_exceeded" &&
          ([
            "provider_stream_incomplete",
            "provider_network_error",
            "provider_timeout",
            "subscription_sharing_usage_unavailable",
          ].includes(failure.code) ||
            [408, 409, 429].includes(failure.status ?? 0) ||
            (failure.status ?? 0) >= 500);
        const retryAt =
          failure instanceof ModelUnavailableError && failure.retryAt
            ? failure.retryAt
            : retryable
              ? Math.max(
                  Date.now() + 5000,
                  lease ? this.router.health.get(lease.model).cooldownUntil : 0,
                )
              : undefined;
        const checkpoint = providerContinuationCheckpointSchema.parse({
          version: 1,
          messages: continuationMessages(originalMessages),
          partialText,
          rejectedModel: lease?.model ?? this.models[this.selected],
          accepted,
          code,
          failureCode: failure.code,
          admission: modelAdmission(
            "provider_dispatch",
            requirements,
            this.models,
            this.router,
            this.candidates(requirements),
          ),
          ...(retryAt ? { retryAt: new Date(retryAt).toISOString() } : {}),
        });
        await this.runtime.onInterrupted?.(checkpoint);
        for (const start of pending) if (!visible) yield start;
        yield {
          type: "RUN_ERROR",
          model: current?.adapter.model ?? this.model,
          timestamp: Date.now(),
          code,
          message: failure.message,
          error: { code, message: failure.message },
        } as AdapterYieldChunk;
        return;
      } finally {
        dispatchController.abort();
        if (lease) this.router.release(lease, { status: "cancelled" });
      }
    }
  }
}

export function modelAdapter(
  model: string,
  fallbacks: readonly string[] = [],
  config = modelProviderConfig(process.env.DATA_DIR ?? ".openmuse"),
  onSelected?: (model: ModelSelection) => void,
  loadBrowserImage?: BrowserImageLoader,
  loadFileImage?: BrowserImageLoader,
  runtime: ModelAdapterRuntime = {},
): AnyTextAdapter {
  return new OrderedModelAdapter(
    orderedModels(model, fallbacks).map(({ spec }) => spec),
    config,
    onSelected,
    loadBrowserImage,
    loadFileImage,
    runtime,
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
