import { CHATGPT_RESOURCE, chatGPTAccessToken } from "./chatgpt-auth.ts";
import type { ModelProviderConfig } from "./config.ts";
import { httpProviderError, ModelProviderError } from "./errors.ts";
import { GROK_API_URL, grokAccessToken } from "./grok-auth.ts";

export interface DispatchState {
  accepted: boolean;
  failure?: ModelProviderError;
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
      const response = await upstream(dispatched, { redirect: "error" });
      if (response.ok) state.accepted = true;
      else {
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
              `${provider} could not be reached. Check its endpoint or try later.`,
            );
      throw state.failure;
    }
  };
}
