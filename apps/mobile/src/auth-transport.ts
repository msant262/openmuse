import { ApiError, parsePayload } from "./api-errors";
import type { AuthManager } from "./auth-manager";

export async function authenticatedFetch(
  manager: AuthManager,
  input: RequestInfo | URL,
  init: RequestInit = {},
  fetcher: typeof fetch = globalThis.fetch,
): Promise<Response> {
  const request = input instanceof Request ? input.clone() : input;
  let authorization = await manager.authorization();
  const send = (header: string) => {
    const headers = new Headers(
      init.headers ?? (request instanceof Request ? request.headers : undefined),
    );
    headers.set("Authorization", header);
    return fetcher(request instanceof Request ? request.clone() : request, {
      ...init,
      headers,
      credentials: "include",
    });
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await send(authorization);
    if (response.status !== 401) return response;
    const text = await response.text();
    try {
      parsePayload(text, response.status, response.statusText);
    } catch (error) {
      if (error instanceof ApiError && error.code === "SESSION_EXPIRED" && attempt === 0) {
        await manager.recoverExpiredSession(authorization);
        authorization = await manager.authorization();
        continue;
      }
      if (error instanceof ApiError && error.code === "SESSION_REVOKED")
        await manager.confirmRevocation();
    }
    return new Response(text, {
      status: response.status,
      headers: response.headers,
      statusText: response.statusText,
    });
  }
  throw new Error("Workspace authentication recovery failed");
}

export async function authenticatedUpload<T>(
  manager: AuthManager,
  upload: (authorization: string) => Promise<{ status: number; body: string }>,
): Promise<T> {
  let authorization = await manager.authorization();
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await upload(authorization);
    try {
      return parsePayload<T>(result.body, result.status);
    } catch (error) {
      if (error instanceof ApiError && error.code === "SESSION_EXPIRED" && attempt === 0) {
        await manager.recoverExpiredSession(authorization);
        authorization = await manager.authorization();
        continue;
      }
      if (error instanceof ApiError && error.code === "SESSION_REVOKED")
        await manager.confirmRevocation();
      throw error;
    }
  }
  throw new Error("Workspace authentication recovery failed");
}

/** CopilotKit exposes no fetch override; scope its transport wrapper to our runtime origin/path. */
export function installRuntimeAuthFetch(baseUrl: string, manager: AuthManager) {
  const original = globalThis.fetch;
  const runtime = new URL(`${baseUrl}/api/copilotkit`);
  const wrapped: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), baseUrl);
    return url.origin === runtime.origin &&
      (url.pathname === runtime.pathname || url.pathname.startsWith(`${runtime.pathname}/`))
      ? authenticatedFetch(manager, input, init, original)
      : original(input, init);
  };
  globalThis.fetch = wrapped;
  return () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = original;
  };
}
