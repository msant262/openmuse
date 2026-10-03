import { AppError } from "../errors.ts";

export const composioBaseUrl = "https://backend.composio.dev/api/v3.1";
export type ComposioTransportInput = {
  apiKey: string;
  path: string;
  method?: "GET" | "POST" | "DELETE";
  query?: URLSearchParams;
  body?: unknown;
  signal?: AbortSignal;
  beforeDispatch?: () => Promise<void>;
  effect?: "read" | "write" | "money";
};
export type ComposioTransport = (input: ComposioTransportInput) => Promise<unknown>;

/** A fixed API host, bounded bodies, no redirects and no execution retries. The
 * platform key is never used as a user-service HTTP credential. */
export function composioTransport(fetcher: typeof fetch = fetch): ComposioTransport {
  return async (input) => {
    if (!/^\/[a-zA-Z0-9_/-]+$/.test(input.path) || input.path.includes("//"))
      throw new AppError("Invalid connection API route", 422);
    const url = new URL(`${composioBaseUrl}${input.path}`);
    if (input.query) url.search = input.query.toString();
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    if (body && Buffer.byteLength(body) > 1_000_000)
      throw new AppError("The connection request is too large", 413);
    const signal = AbortSignal.any([
      AbortSignal.timeout(60_000),
      ...(input.signal ? [input.signal] : []),
    ]);
    let dispatched = false;
    let rejected = false;
    try {
      await input.beforeDispatch?.();
      signal.throwIfAborted();
      dispatched = true;
      const response = await fetcher(url, {
        method: input.method ?? "GET",
        headers: {
          "x-api-key": input.apiKey,
          accept: "application/json",
          "content-type": "application/json",
        },
        body,
        signal,
        redirect: "error",
      });
      if (!response.ok) {
        rejected = response.status >= 400 && response.status < 500;
        await response.body?.cancel();
        throw new AppError(
          [401, 403].includes(response.status)
            ? "The Composio project key was rejected. Update it in Connections."
            : `The connection service returned HTTP ${response.status}. Try again shortly.`,
          [401, 403].includes(response.status) ? 503 : 502,
          [401, 403].includes(response.status) ? "COMPOSIO_SETUP_REQUIRED" : "COMPOSIO_UNAVAILABLE",
        );
      }
      if (response.status === 204) return {};
      const reader = response.body?.getReader();
      if (!reader) throw new AppError("The connection service returned an empty response", 502);
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 2_000_000) {
          await reader.cancel();
          throw new AppError("The connection response is too large", 502);
        }
        chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch (cause) {
      const error =
        cause instanceof AppError
          ? cause
          : new AppError(
              "The connection service could not confirm the response",
              502,
              "COMPOSIO_UNAVAILABLE",
            );
      if (dispatched && !rejected && input.effect && input.effect !== "read")
        Object.assign(error, { outcomeUnknown: true });
      throw error;
    }
  };
}
