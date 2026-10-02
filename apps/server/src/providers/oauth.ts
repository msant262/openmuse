import { httpProviderError, ModelProviderError } from "./errors.ts";

export type AuthContext = { fetch?: typeof fetch; now?: () => number };
export const clock = (ctx: AuthContext) => ctx.now?.() ?? Date.now();

export function authUrl(value: string, issuer: string, subdomains = false) {
  const url = new URL(value);
  const host = new URL(issuer).hostname;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !(
      url.hostname === host ||
      (subdomains && (url.hostname === "x.ai" || url.hostname.endsWith(".x.ai")))
    )
  )
    throw new ModelProviderError(
      "oauth",
      "invalid_discovery",
      "OAuth discovery returned an untrusted endpoint.",
    );
  return url.href;
}

export async function oauthRequest(
  provider: string,
  url: string,
  init: RequestInit,
  ctx: AuthContext = {},
) {
  try {
    return await (ctx.fetch ?? fetch)(url, {
      ...init,
      redirect: "error",
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
    });
  } catch {
    if (init.signal?.aborted) init.signal.throwIfAborted();
    throw new ModelProviderError(
      provider,
      "provider_network_error",
      `${provider} authentication is temporarily unavailable. Credentials were preserved.`,
    );
  }
}

export async function oauthForm(
  provider: string,
  url: string,
  data: Record<string, string>,
  ctx: AuthContext = {},
  signal?: AbortSignal,
) {
  const response = await oauthRequest(
    provider,
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(data),
      signal,
    },
    ctx,
  );
  if (!response.ok) throw await httpProviderError(provider, response);
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object")
    throw new ModelProviderError(
      provider,
      "invalid_token_response",
      `${provider} returned an invalid authentication response.`,
    );
  return payload as Record<string, unknown>;
}

export async function discovery(issuer: string, ctx: AuthContext = {}, subdomains = false) {
  const response = await oauthRequest(
    "oauth",
    `${issuer}/.well-known/openid-configuration`,
    { headers: { Accept: "application/json" } },
    ctx,
  );
  if (!response.ok) throw await httpProviderError("oauth", response);
  const data = await response.json();
  if (data?.issuer !== issuer)
    throw new ModelProviderError(
      "oauth",
      "invalid_discovery",
      "OAuth discovery issuer did not match.",
    );
  return {
    issuer,
    token_endpoint: authUrl(String(data.token_endpoint ?? ""), issuer, subdomains),
    authorization_endpoint: authUrl(String(data.authorization_endpoint ?? ""), issuer, subdomains),
    ...(typeof data.jwks_uri === "string" && {
      jwks_uri: authUrl(data.jwks_uri, issuer, subdomains),
    }),
    ...(typeof data.revocation_endpoint === "string" && {
      revocation_endpoint: authUrl(data.revocation_endpoint, issuer, subdomains),
    }),
  };
}

export const terminalRefresh = (error: unknown) =>
  error instanceof ModelProviderError &&
  [
    "invalid_grant",
    "invalid_refresh_token",
    "token_expired",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "refresh_token_reused",
  ].includes(error.code);
