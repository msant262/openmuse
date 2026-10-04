import { CHATGPT_RESOURCE, chatGPTAccessToken } from "./chatgpt-auth.ts";
import type { ModelProviderConfig } from "./config.ts";
import { httpProviderError, ModelProviderError, publicProviderMessage } from "./errors.ts";
import { GROK_API_URL, grokAccessToken } from "./grok-auth.ts";

export interface DispatchState {
  accepted: boolean;
  expectedStreaming?: boolean;
  requiresCompletion?: boolean;
  completed?: boolean;
  failure?: ModelProviderError;
}

/** SDKs may synthesize success on EOF. Only the provider terminal event confirms success. */
function verifiedCompletion(
  response: Response,
  provider: string,
  state: DispatchState,
  api: "responses" | "chat-completions",
) {
  state.requiresCompletion = true;
  state.completed = false;
  if (!response.body) return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let lastTextItem: string | undefined;
  const inspect = (frame: string) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return frame;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return frame;
    }
    if (!parsed || typeof parsed !== "object") return frame;
    const event = parsed as Record<string, unknown>;
    if (api === "chat-completions") {
      const choices = Array.isArray(event.choices) ? event.choices : [];
      for (const choice of choices) {
        if (!choice || typeof choice !== "object") continue;
        const reason = (choice as Record<string, unknown>).finish_reason;
        if (typeof reason !== "string") continue;
        if (["stop", "tool_calls", "function_call"].includes(reason)) state.completed = true;
        else {
          state.failure = new ModelProviderError(
            provider,
            "provider_stream_incomplete",
            publicProviderMessage(provider, "provider_stream_incomplete"),
          );
          throw state.failure;
        }
      }
      return frame;
    }
    // The Responses SDK flattens all output messages into one AG-UI message.
    // Keep their paragraph boundary, including commentary followed by an answer.
    // Ordinary token chunks within the same message must remain untouched.
    if (
      event.type === "response.output_text.delta" &&
      typeof event.item_id === "string" &&
      typeof event.delta === "string" &&
      event.delta
    ) {
      if (lastTextItem && lastTextItem !== event.item_id) {
        event.delta = `\n\n${event.delta}`;
        frame = [
          ...frame.split(/\r?\n/).filter((line) => !line.startsWith("data:")),
          `data: ${JSON.stringify(event)}`,
        ].join("\n");
      }
      lastTextItem = event.item_id;
    }
    const result =
      event.response && typeof event.response === "object"
        ? (event.response as Record<string, unknown>)
        : undefined;
    const error =
      result?.error && typeof result.error === "object"
        ? (result.error as Record<string, unknown>)
        : undefined;
    if (event.type === "response.completed" && result?.status === "completed")
      state.completed = true;
    if (event.type === "response.failed" || event.type === "response.incomplete") {
      const code =
        error?.code === "subscription_sharing_usage_limit_exceeded"
          ? "subscription_sharing_usage_limit_exceeded"
          : "provider_stream_incomplete";
      state.failure = new ModelProviderError(
        provider,
        code,
        code === "subscription_sharing_usage_limit_exceeded"
          ? publicProviderMessage(provider, code)
          : "A resposta do provedor foi interrompida. O progresso e os recibos concluídos foram preservados.",
      );
      throw state.failure;
    }
    return frame;
  };
  const check = (controller: TransformStreamDefaultController<Uint8Array>, final = false) => {
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = final ? "" : (frames.pop() ?? "");
    for (const frame of frames) {
      if (frame.trim()) controller.enqueue(encoder.encode(`${inspect(frame)}\n\n`));
    }
  };
  const stream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        check(controller);
      },
      flush(controller) {
        buffer += decoder.decode();
        check(controller, true);
        if (!state.completed) {
          state.failure = new ModelProviderError(
            provider,
            "provider_stream_incomplete",
            "A resposta do provedor terminou sem confirmação. O progresso e os recibos concluídos foram preservados.",
          );
          throw state.failure;
        }
      },
    }),
  );
  return new Response(stream, { status: response.status, headers: response.headers });
}
const forbidden = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
];

/** The SIWC preview supports client function tools, grouped in a namespace. */
export function siwcRequest(body: Record<string, unknown>) {
  if (!Array.isArray(body.input))
    throw new ModelProviderError(
      "chatgpt",
      "unsupported_input",
      "ChatGPT requires a full history array for each request.",
    );
  const checkInput = (input: unknown): void => {
    if (!input || typeof input !== "object") return;
    const item = input as Record<string, unknown>;
    if (
      (typeof item.type === "string" && /audio|video/.test(item.type)) ||
      (typeof item.mime_type === "string" && /^(audio|video)\//.test(item.mime_type)) ||
      (typeof item.filename === "string" &&
        /\.(mp3|wav|m4a|ogg|flac|mp4|webm|mov|avi)$/i.test(item.filename))
    )
      throw new ModelProviderError(
        "chatgpt",
        "unsupported_input",
        "Audio and video input are unavailable through Sign in with ChatGPT. Transcribe the attachment locally first.",
      );
    for (const value of Object.values(item)) {
      if (Array.isArray(value)) value.forEach(checkInput);
      else if (value && typeof value === "object") checkInput(value);
    }
  };
  body.input.forEach(checkInput);
  const input = body.input.map((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const item = raw as Record<string, unknown>;
    if (item.role === "system") return { ...item, role: "developer" };
    if (item.type === "function_call" || item.type === "custom_tool_call")
      return { ...item, namespace: "openmuse" };
    return item;
  });
  const tools = body.tools;
  if (
    tools !== undefined &&
    (!Array.isArray(tools) ||
      tools.some((tool) => !tool || !["function", "custom"].includes(tool.type)))
  )
    throw new ModelProviderError(
      "chatgpt",
      "unsupported_tool",
      "Hosted tools are unavailable through Sign in with ChatGPT. Use OpenMuse's local function tools.",
    );
  const request: Record<string, unknown> = { ...body, input, store: false, stream: true };
  for (const key of forbidden) delete request[key];
  if (Array.isArray(tools) && tools.length)
    request.tools = [
      {
        type: "namespace",
        name: "openmuse",
        description: "OpenMuse's client-executed personal agent tools.",
        tools,
      },
    ];
  return request;
}

/** Capture admission independently of the SDK's synthetic RUN_STARTED error event. */
export function providerFetch(
  provider: string,
  state: DispatchState,
  config: ModelProviderConfig,
  upstream: typeof fetch = fetch,
  legacy = false,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    let dispatched = request;
    try {
      if (provider === "chatgpt" || provider === "grok") {
        const origin = provider === "chatgpt" ? CHATGPT_RESOURCE : GROK_API_URL;
        if (request.url !== `${origin}/responses` || request.method !== "POST")
          throw new ModelProviderError(
            provider,
            "unsupported_route",
            `${provider} subscription inference only supports its documented Responses route.`,
          );
        const body = JSON.parse(await request.text());
        const prepared = provider === "chatgpt" ? siwcRequest(body) : { ...body, store: false };
        const token =
          provider === "chatgpt"
            ? await chatGPTAccessToken(config.chatgptFile, {}, request.signal)
            : await grokAccessToken(config.grokFile, {}, request.signal);
        const headers = new Headers(request.headers);
        headers.set("Authorization", `Bearer ${token}`);
        headers.set("User-Agent", "OpenMuse/0.1");
        dispatched = new Request(request.url, {
          method: "POST",
          headers,
          body: JSON.stringify(prepared),
          signal: request.signal,
          redirect: "error",
        });
      }
      const compatible =
        provider === "compatible"
          ? config.compatible
          : ["local", "ollama", "llamacpp"].includes(provider)
            ? config.local
            : undefined;
      if (compatible && !compatible.key) {
        const headers = new Headers(dispatched.headers);
        headers.delete("Authorization");
        dispatched = new Request(dispatched, { headers });
      }
      const path = new URL(dispatched.url).pathname;
      const protocol = path.endsWith("/responses")
        ? "responses"
        : path.endsWith("/chat/completions")
          ? "chat-completions"
          : undefined;
      let streaming = state.expectedStreaming === true;
      if (protocol && !streaming) {
        const body: unknown = await dispatched
          .clone()
          .json()
          .catch(() => undefined);
        streaming = Boolean(
          body && typeof body === "object" && "stream" in body && body.stream === true,
        );
      }
      if (protocol && streaming) {
        // Request semantics decide the boundary, never a provider-controlled MIME header.
        state.requiresCompletion = true;
        state.completed = false;
      }
      const response = await upstream(dispatched, { redirect: "error" });
      if (response.ok) {
        state.accepted = true;
        if (protocol && streaming) return verifiedCompletion(response, provider, state, protocol);
      } else {
        state.failure = await httpProviderError(provider, response.clone());
        if (!legacy)
          return new Response(
            JSON.stringify({
              error: {
                code: state.failure.code,
                message: state.failure.message,
                param: state.failure.param,
              },
            }),
            { status: response.status, headers: response.headers },
          );
      }
      return response;
    } catch (error) {
      if (request.signal.aborted) request.signal.throwIfAborted();
      state.failure =
        error instanceof ModelProviderError
          ? error
          : new ModelProviderError(
              provider,
              "provider_network_error",
              publicProviderMessage(provider, "provider_network_error"),
            );
      throw state.failure;
    }
  };
}
