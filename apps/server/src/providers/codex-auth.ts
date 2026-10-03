// Implements OpenAI Codex's published device-code protocol. See docs/superpowers/research/2026-10-03-openclaw-harness-correction.md.
// Kept separate from Sign in with ChatGPT token sharing: the grants authorize different resources.
import { unlink } from "node:fs/promises";
import { decodeJwt } from "jose";
import { z } from "zod";
import { readProtected, sleep, withCredentialLock, writeProtected } from "./credential-store.ts";
import { httpProviderError, ModelProviderError } from "./errors.ts";
import { type AuthContext, clock, oauthForm, oauthRequest, terminalRefresh } from "./oauth.ts";

export const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const schema = z.object({
  version: z.literal(1),
  provider: z.literal("codex"),
  access_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
  expires_at: z.number().finite().positive(),
  account_id: z.string().min(1).max(300).optional(),
});
type Credential = z.infer<typeof schema>;
type CodexAuthContext = AuthContext & { sleep?: typeof sleep };
export type CodexDeviceCode = {
  url: string;
  code: string;
  expiresAt: number;
  intervalSeconds: number;
};

async function read(file: string) {
  const raw = await readProtected(file);
  if (raw === undefined) return undefined;
  const value = schema.safeParse(raw);
  if (!value.success)
    throw new ModelProviderError(
      "codex",
      "credentials_invalid",
      "A conexão do GPT Image é inválida. Conecte novamente nas Configurações.",
    );
  return value.data;
}
function tokenFields(raw: unknown, ctx: AuthContext, previous?: Credential): Credential {
  const parsed = z
    .object({
      access_token: z.string().min(1),
      refresh_token: z.string().min(1).optional(),
      expires_in: z.number().positive().optional(),
    })
    .safeParse(raw);
  if (!parsed.success || (!parsed.data.refresh_token && !previous?.refresh_token))
    throw new ModelProviderError(
      "codex",
      "invalid_token_response",
      "A autorização do ChatGPT não retornou credenciais válidas.",
    );
  let expiry: number | undefined;
  let account: string | undefined;
  // Metadata comes from a token issued by the pinned HTTPS token endpoint. It never grants app authority.
  try {
    const claims = decodeJwt(parsed.data.access_token);
    expiry = typeof claims.exp === "number" ? claims.exp * 1000 : undefined;
    const auth = claims["https://api.openai.com/auth"];
    if (
      auth &&
      typeof auth === "object" &&
      "chatgpt_account_id" in auth &&
      typeof auth.chatgpt_account_id === "string"
    )
      account = auth.chatgpt_account_id;
  } catch {}
  const declared = parsed.data.expires_in ? clock(ctx) + parsed.data.expires_in * 1000 : undefined;
  const expiresAt = declared && expiry ? Math.min(declared, expiry) : (declared ?? expiry);
  if (!expiresAt || expiresAt <= clock(ctx))
    throw new ModelProviderError(
      "codex",
      "invalid_token_response",
      "A autorização do ChatGPT não informou uma validade utilizável.",
    );
  return schema.parse({
    version: 1,
    provider: "codex",
    access_token: parsed.data.access_token,
    refresh_token: parsed.data.refresh_token ?? previous?.refresh_token,
    expires_at: expiresAt,
    account_id: account ?? previous?.account_id,
  });
}

export async function codexDeviceLogin(
  file: string,
  onCode: (code: CodexDeviceCode) => void,
  ctx: CodexAuthContext = {},
  signal?: AbortSignal,
): Promise<void> {
  const request = (path: string, body: Record<string, string>) =>
    oauthRequest(
      "codex",
      `${CODEX_ISSUER}${path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "OpenMuse/0.1",
          originator: "openmuse",
        },
        body: JSON.stringify(body),
        signal,
      },
      ctx,
    );
  const response = await request("/api/accounts/deviceauth/usercode", {
    client_id: CODEX_CLIENT_ID,
  });
  if (!response.ok) throw await httpProviderError("codex", response);
  const raw = await response.json();
  const code = z
    .object({
      device_auth_id: z.string().min(1).max(2048),
      user_code: z.string().min(1).max(100),
      interval: z.coerce.number().finite().min(1).max(60).default(5),
    })
    .safeParse({ ...raw, user_code: raw.user_code ?? raw.usercode });
  if (!code.success)
    throw new ModelProviderError(
      "codex",
      "device_response_invalid",
      "Não foi possível iniciar a autorização do GPT Image.",
    );
  const expiresAt = clock(ctx) + 15 * 60_000;
  onCode({
    url: `${CODEX_ISSUER}/codex/device`,
    code: code.data.user_code,
    expiresAt,
    intervalSeconds: code.data.interval,
  });
  while (clock(ctx) < expiresAt) {
    signal?.throwIfAborted();
    await (ctx.sleep ?? sleep)(Math.min(code.data.interval * 1000, expiresAt - clock(ctx)), signal);
    if (clock(ctx) >= expiresAt) break;
    const poll = await request("/api/accounts/deviceauth/token", {
      device_auth_id: code.data.device_auth_id,
      user_code: code.data.user_code,
    });
    if (poll.status === 403 || poll.status === 404) {
      await poll.body?.cancel().catch(() => {});
      continue;
    }
    if (!poll.ok) throw await httpProviderError("codex", poll);
    const exchange = z
      .object({ authorization_code: z.string().min(1), code_verifier: z.string().min(1) })
      .safeParse(await poll.json());
    if (!exchange.success)
      throw new ModelProviderError(
        "codex",
        "device_response_invalid",
        "A confirmação do ChatGPT não retornou o código de autorização.",
      );
    signal?.throwIfAborted();
    const rawTokens = await oauthForm(
      "codex",
      `${CODEX_ISSUER}/oauth/token`,
      {
        grant_type: "authorization_code",
        code: exchange.data.authorization_code,
        code_verifier: exchange.data.code_verifier,
        client_id: CODEX_CLIENT_ID,
        redirect_uri: `${CODEX_ISSUER}/deviceauth/callback`,
      },
      ctx,
      signal,
    );
    const credential = tokenFields(rawTokens, ctx);
    signal?.throwIfAborted();
    await withCredentialLock(
      file,
      async (assertOwnership) => {
        signal?.throwIfAborted();
        assertOwnership();
        await writeProtected(file, credential);
      },
      signal,
    );
    return;
  }
  throw new ModelProviderError(
    "codex",
    "device_expired",
    "O código expirou. Inicie uma nova conexão do GPT Image nas Configurações.",
  );
}

export async function codexStatus(file: string) {
  const saved = await read(file);
  return { connected: Boolean(saved?.access_token && saved.refresh_token) };
}
export async function disconnectCodex(file: string) {
  await withCredentialLock(file, async () => {
    await unlink(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  });
}
export async function codexAccessToken(
  file: string,
  ctx: AuthContext = {},
  signal?: AbortSignal,
): Promise<{ token: string; accountId?: string }> {
  return withCredentialLock(
    file,
    async (assertOwnership) => {
      let saved = await read(file);
      if (!saved?.access_token || !saved.refresh_token)
        throw new ModelProviderError(
          "codex",
          "credentials_missing",
          "Conecte GPT Image com sua conta ChatGPT nas Configurações.",
        );
      if (saved.expires_at - clock(ctx) > 120_000)
        return { token: saved.access_token, accountId: saved.account_id };
      try {
        // Once rotation is sent, preserve its replacement even if this consumer disconnects.
        const raw = await oauthForm(
          "codex",
          `${CODEX_ISSUER}/oauth/token`,
          {
            grant_type: "refresh_token",
            client_id: CODEX_CLIENT_ID,
            refresh_token: saved.refresh_token,
          },
          ctx,
        );
        saved = tokenFields(raw, ctx, saved);
        assertOwnership();
        await writeProtected(file, saved);
        return { token: saved.access_token!, accountId: saved.account_id };
      } catch (error) {
        if (terminalRefresh(error)) {
          assertOwnership();
          await writeProtected(file, {
            ...saved,
            access_token: undefined,
            refresh_token: undefined,
          });
        }
        throw error;
      }
    },
    signal,
  );
}
