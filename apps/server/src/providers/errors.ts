/** Public, credential-free diagnostics. Provider response bodies are never logged. */
export class ModelProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly requestId?: string,
    readonly param?: string,
    readonly bodyShape?: "error" | "detail" | "other",
  ) {
    super(message);
    this.name = "ModelProviderError";
  }
}

const usage =
  "ChatGPT's usage limit for this app was reached. Manage usage at https://chatgpt.com/settings/usage, or use a configured fallback.";

export function publicProviderMessage(provider: string, code?: string, status?: number): string {
  if (
    code &&
    [
      "invalid_grant",
      "invalid_refresh_token",
      "token_expired",
      "refresh_token_expired",
      "refresh_token_invalidated",
      "refresh_token_reused",
    ].includes(code)
  )
    return `${provider}'s sign-in session expired or was revoked. Sign in again, or use a configured fallback.`;
  if (code === "subscription_sharing_usage_limit_exceeded") return usage;
  if (code === "subscription_sharing_usage_unavailable" || status === 503)
    return `${provider} is temporarily unavailable. Try again later or use a configured fallback.`;
  if (code === "subscription_sharing_unsupported_capability")
    return "This capability is unavailable through Sign in with ChatGPT. Use local tools or another configured provider.";
  if (provider === "grok" && status === 403)
    return "xAI denied subscription API access for this account or tier. Logging in again may not fix it; check your xAI subscription or use a configured fallback.";
  if (status === 401)
    return `${provider} credentials were not accepted. Check the selected account and sign in again if its session was revoked.`;
  if (status === 403)
    return `${provider} access is restricted for this account, workspace, or region. Check permissions or use a configured fallback.`;
  if (status === 429)
    return `${provider} usage is currently limited. Try later or use a configured fallback.`;
  if (status && status >= 500)
    return `${provider} could not complete the request. Try again later.`;
  return `${provider} could not accept this model request${code ? ` (${code})` : ""}. Check its configuration.`;
}

export const safeCode = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : undefined;

export async function httpProviderError(provider: string, response: Response) {
  const raw = await response.json().catch(() => null);
  const error = raw && typeof raw === "object" && "error" in raw ? raw.error : undefined;
  const code = safeCode(typeof error === "string" ? error : error?.code) ?? "provider_http_error";
  const requestId = safeCode(
    response.headers.get("x-request-id") ?? response.headers.get("openai-request-id"),
  );
  return new ModelProviderError(
    provider,
    code,
    publicProviderMessage(provider, code, response.status),
    response.status,
    requestId,
    safeCode(error?.param),
    error ? "error" : raw && typeof raw === "object" && "detail" in raw ? "detail" : "other",
  );
}

export function fallbackAllowed(error: unknown): boolean {
  if (!(error instanceof ModelProviderError)) return false;
  return (
    [
      "credentials_missing",
      "credentials_expired",
      "plan_disabled",
      "provider_network_error",
      "invalid_grant",
      "invalid_refresh_token",
      "token_expired",
      "refresh_token_expired",
      "refresh_token_invalidated",
      "refresh_token_reused",
    ].includes(error.code) ||
    error.status === 401 ||
    error.status === 403 ||
    error.status === 408 ||
    error.status === 409 ||
    error.status === 429 ||
    (error.status !== undefined && error.status >= 500)
  );
}
