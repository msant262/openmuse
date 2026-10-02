import { ApiError } from "./api-errors";
import { normalizeServerOrigin } from "./auth-manager";

export interface WebSessionLocks {
  request<T>(name: string, operation: () => Promise<T>): Promise<T>;
}
/** Hold the browser's cross-tab lock through Set-Cookie application and response parsing. */
export async function withWebSessionLock<T>(
  serverOrigin: string,
  operation: () => Promise<T>,
  locks: WebSessionLocks | null = typeof navigator === "undefined"
    ? null
    : (navigator.locks ?? null),
): Promise<T> {
  if (!locks)
    throw new ApiError(
      "This browser needs Web Locks for durable pairing. Open the app in a browser with Web Locks support over HTTPS (localhost works for development).",
      503,
      "WEB_SESSION_COORDINATION_UNAVAILABLE",
    );
  return locks.request(`openmuse.device-session:${normalizeServerOrigin(serverOrigin)}`, operation);
}
