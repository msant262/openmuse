export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
/** Gateways may return HTML or nothing; preserve the HTTP diagnostic without leaking bodies. */
export function parsePayload<T>(body: string, status: number, statusText = ""): T {
  let payload: unknown;
  try {
    payload = body.trim() ? JSON.parse(body) : undefined;
  } catch {
    /* Non-JSON is a diagnosed response. */
  }
  if (status < 200 || status >= 300) {
    const value =
      payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    throw new ApiError(
      typeof value.error === "string"
        ? value.error.slice(0, 500)
        : `Workspace request failed (HTTP ${status}${statusText ? ` ${statusText}` : ""})`,
      status,
      typeof value.code === "string" ? value.code : undefined,
    );
  }
  if (payload === undefined && status !== 204)
    throw new ApiError(
      `Workspace returned an invalid response (HTTP ${status})`,
      status,
      "INVALID_RESPONSE",
    );
  return payload as T;
}
export async function parseResponse<T>(response: Response): Promise<T> {
  return parsePayload<T>(await response.text(), response.status, response.statusText);
}
