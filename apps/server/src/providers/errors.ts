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
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ModelProviderError";
  }
}

const usage =
  "O limite de uso do ChatGPT para este aplicativo foi atingido. Veja https://chatgpt.com/settings/usage ou use outro provedor configurado.";

export class ModelUnavailableError extends ModelProviderError {
  constructor(
    readonly reason: "capability" | "cooldown" | "quota",
    readonly retryAt?: number,
  ) {
    super(
      "models",
      reason === "capability" ? "MODEL_CAPABILITY_UNAVAILABLE" : "MODEL_PROVIDER_UNAVAILABLE",
      reason === "capability"
        ? "Nenhum modelo configurado tem as capacidades ou o contexto necessários. O trabalho foi preservado; ajuste a configuração para continuar."
        : "Os provedores configurados estão temporariamente indisponíveis. O progresso foi preservado e o trabalho aguarda um provedor.",
    );
    this.name = "ModelUnavailableError";
  }
}

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
    return `A sessão do ${provider} expirou ou foi revogada. Conecte a conta novamente ou use outro provedor configurado.`;
  if (code === "subscription_sharing_usage_limit_exceeded") return usage;
  if (code === "subscription_sharing_usage_unavailable" || status === 503)
    return `${provider} está temporariamente indisponível. Tente mais tarde ou use outro provedor configurado.`;
  if (code === "subscription_sharing_unsupported_capability")
    return "Esta capacidade está indisponível via Sign in with ChatGPT. Use ferramentas locais ou outro provedor configurado.";
  if (provider === "grok" && status === 403)
    return "A xAI recusou o acesso à API de assinatura desta conta ou plano (tier). Verifique a assinatura ou use outro provedor configurado.";
  if (status === 401)
    return `As credenciais do ${provider} foram recusadas. Verifique a conta selecionada e reconecte se a sessão foi revogada.`;
  if (status === 403)
    return `O acesso ao ${provider} está restrito para esta conta, espaço ou região. Verifique as permissões ou use outro provedor configurado.`;
  if (status === 429)
    return `O uso do ${provider} está limitado. Tente mais tarde ou use outro provedor configurado.`;
  if (status && status >= 500)
    return `${provider} não conseguiu concluir a solicitação. Tente novamente mais tarde.`;
  if (code === "provider_network_error" || code === "provider_timeout")
    return `Não foi possível alcançar o ${provider}. O progresso foi preservado; tente mais tarde.`;
  if (code === "provider_stream_incomplete")
    return `A resposta do ${provider} foi interrompida. O progresso e os recibos concluídos foram preservados.`;
  return `${provider} não aceitou a solicitação do modelo${code ? ` (${code})` : ""}. Verifique a configuração.`;
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
    retryAfter(response.headers.get("retry-after")),
  );
}

export function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay >= 0 ? Math.ceil(delay) : undefined;
}

export function fallbackAllowed(error: unknown): boolean {
  if (!(error instanceof ModelProviderError)) return false;
  return (
    [
      "credentials_missing",
      "credentials_expired",
      "plan_disabled",
      "provider_network_error",
      "provider_timeout",
      "provider_stream_incomplete",
      "subscription_sharing_usage_limit_exceeded",
      "subscription_sharing_usage_unavailable",
      "subscription_sharing_unsupported_capability",
      "model_not_found",
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
