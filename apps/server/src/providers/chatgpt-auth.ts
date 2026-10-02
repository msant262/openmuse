import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { z } from "zod";
import { hostId, readProtected, withCredentialLock, writeProtected } from "./credential-store.ts";
import { ModelProviderError } from "./errors.ts";
import { type AuthContext, clock, discovery, oauthForm, terminalRefresh } from "./oauth.ts";

export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;
const scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const credentialSchema = z.object({
  provider: z.literal("chatgpt").default("chatgpt"),
  version: z.literal(1).default(1),
  issuer: z.literal(CHATGPT_ISSUER),
  subject: z.string().min(1),
  client_id: z
    .string()
    .min(1)
    .refine((s) => s !== "dynamic_agent_client"),
  email: z.string().optional(),
  ext_agent_host_id: z.string().min(1),
  access_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  token_type: z.literal("Bearer"),
  expires_in: z.number().finite().positive(),
  saved_at: z.iso.datetime(),
  earliest_refresh_at: z.union([z.number().finite(), z.iso.datetime()]).optional(),
  scopes: z.array(z.string()),
});
export type ChatGPTCredential = z.infer<typeof credentialSchema>;
const random = () => randomBytes(32).toString("base64url");

async function read(file: string) {
  const raw = await readProtected(file);
  if (raw === undefined) return undefined;
  const result = credentialSchema.safeParse(raw);
  if (!result.success)
    throw new ModelProviderError(
      "chatgpt",
      "credentials_invalid",
      "ChatGPT credentials have an invalid format. Use OpenMuse's auth login/import command.",
    );
  return result.data;
}

export async function verifyChatGPTIdentity(
  idToken: string,
  clientId: string,
  nonce: string | undefined,
  ctx: AuthContext = {},
) {
  const meta = await discovery(CHATGPT_ISSUER, ctx);
  if (!meta.jwks_uri)
    throw new ModelProviderError(
      "chatgpt",
      "invalid_discovery",
      "OpenAI did not publish a JWKS endpoint.",
    );
  const keys = createRemoteJWKSet(new URL(meta.jwks_uri), {
    [customFetch]: (url, init) => (ctx.fetch ?? fetch)(url, { ...init, redirect: "error" }),
  });
  try {
    const { payload } = await jwtVerify(idToken, keys, {
      issuer: CHATGPT_ISSUER,
      audience: clientId,
      requiredClaims: ["sub", "exp", "iat"],
      clockTolerance: 5,
      currentDate: new Date(clock(ctx)),
      algorithms: ["RS256", "ES256"],
    });
    if (!payload.sub || (nonce !== undefined && payload.nonce !== nonce))
      throw new Error("Identity mismatch");
    return {
      subject: payload.sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
    };
  } catch {
    throw new ModelProviderError(
      "chatgpt",
      "identity_invalid",
      "ChatGPT identity validation failed. Sign in again; existing credentials were preserved.",
    );
  }
}

export interface SignInAttempt {
  url: string;
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  host: string;
  issuedClientId?: string;
  prior?: ChatGPTCredential;
  expiresAt: number;
  consumed: boolean;
}
export async function beginChatGPTSignIn(
  file: string,
  authDir: string,
  redirectUri: string,
  ctx: AuthContext = {},
): Promise<SignInAttempt> {
  const callback = new URL(redirectUri);
  if (
    callback.protocol !== "http:" ||
    callback.hostname !== "127.0.0.1" ||
    callback.pathname !== "/auth/callback" ||
    callback.search ||
    callback.hash ||
    callback.username ||
    callback.password
  )
    throw new Error("ChatGPT login requires an HTTP 127.0.0.1 /auth/callback listener.");
  const prior = await read(file);
  const registration = await readProtected(`${file}.registration.json`);
  const issuedClientId =
    prior?.client_id ??
    (registration &&
    typeof registration === "object" &&
    "client_id" in registration &&
    typeof registration.client_id === "string" &&
    registration.client_id !== "dynamic_agent_client"
      ? registration.client_id
      : undefined);
  const state = random(),
    nonce = random(),
    verifier = random();
  const host = await hostId(authDir);
  const url = new URL(`${CHATGPT_ISSUER}/api/accounts/authorize`);
  url.search = new URLSearchParams({
    client_id: issuedClientId ?? "dynamic_agent_client",
    ext_agent_host_id: host,
    ...(!issuedClientId && { agent_name_hint: "OpenMuse" }),
    response_type: "code",
    redirect_uri: redirectUri,
    scope: scopes,
    resource: CHATGPT_RESOURCE,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  }).toString();
  // Retain the ID token but omit optional id_token_hint: the CLI may print this URL.
  return {
    url: url.href,
    state,
    nonce,
    verifier,
    redirectUri,
    host,
    prior,
    issuedClientId,
    expiresAt: clock(ctx) + 10 * 60000,
    consumed: false,
  };
}

function tokenFields(
  payload: Record<string, unknown>,
  ctx: AuthContext,
  prior?: ChatGPTCredential,
) {
  const result = z
    .object({
      access_token: z.string().min(1),
      refresh_token: z.string().min(1),
      id_token: z.string().min(1).optional(),
      token_type: z.literal("Bearer"),
      expires_in: z.number().finite().positive(),
      scope: z.string().optional(),
      earliest_refresh_at: z.union([z.number().finite(), z.iso.datetime()]).optional(),
    })
    .safeParse(payload);
  if (!result.success)
    throw new ModelProviderError(
      "chatgpt",
      "invalid_token_response",
      "OpenAI returned an incomplete token set. Existing credentials were preserved.",
    );
  return {
    ...result.data,
    id_token: result.data.id_token ?? prior?.id_token,
    scopes:
      result.data.scope !== undefined
        ? result.data.scope.split(/\s+/).filter(Boolean)
        : (prior?.scopes ?? []),
    saved_at: new Date(clock(ctx)).toISOString(),
  };
}

export async function completeChatGPTSignIn(
  file: string,
  attempt: SignInAttempt,
  params: URLSearchParams,
  ctx: AuthContext = {},
) {
  const returnedState = params.get("state") ?? "";
  if (
    attempt.consumed ||
    clock(ctx) > attempt.expiresAt ||
    returnedState.length !== attempt.state.length ||
    !timingSafeEqual(Buffer.from(returnedState), Buffer.from(attempt.state))
  )
    throw new ModelProviderError(
      "chatgpt",
      "state_invalid",
      "The ChatGPT login callback was expired, reused, or did not match.",
    );
  attempt.consumed = true;
  if (params.has("error"))
    throw new ModelProviderError(
      "chatgpt",
      "consent_denied",
      "ChatGPT sign-in was declined. Existing credentials were preserved.",
    );
  const code = params.get("code");
  const clientId = params.get("client_id") ?? attempt.issuedClientId;
  if (
    !code ||
    !clientId ||
    clientId === "dynamic_agent_client" ||
    (attempt.issuedClientId && clientId !== attempt.issuedClientId)
  )
    throw new ModelProviderError(
      "chatgpt",
      "registration_invalid",
      "ChatGPT registration did not return the expected issued client ID.",
    );
  // Keep a new issued registration if its one-use code expires, without activating it.
  if (!attempt.prior) await writeProtected(`${file}.registration.json`, { client_id: clientId });
  const payload = await oauthForm(
    "chatgpt",
    CHATGPT_TOKEN_URL,
    {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: attempt.verifier,
      redirect_uri: attempt.redirectUri,
      resource: CHATGPT_RESOURCE,
    },
    ctx,
  );
  const fields = tokenFields(payload, ctx);
  if (!fields.id_token)
    throw new ModelProviderError(
      "chatgpt",
      "identity_missing",
      "OpenAI did not return an ID token.",
    );
  const identity = await verifyChatGPTIdentity(fields.id_token, clientId, attempt.nonce, ctx);
  if (attempt.prior && identity.subject !== attempt.prior.subject)
    throw new ModelProviderError(
      "chatgpt",
      "identity_mismatch",
      "This ChatGPT registration belongs to another account. Existing credentials were preserved.",
    );
  const credential = credentialSchema.parse({
    ...fields,
    ...identity,
    issuer: CHATGPT_ISSUER,
    client_id: clientId,
    ext_agent_host_id: attempt.host,
  });
  await withCredentialLock(file, () => writeProtected(file, credential));
  return credential;
}

/** Import one selected, already validated registration; preserve the VM's host identity. */
export async function importChatGPTCredential(source: string, file: string, authDir: string) {
  const incoming = credentialSchema.parse(await readProtected(source));
  const host = await hostId(authDir);
  return withCredentialLock(file, async () => {
    const current = await read(file);
    if (
      current &&
      (current.client_id !== incoming.client_id || current.subject !== incoming.subject)
    )
      throw new ModelProviderError(
        "chatgpt",
        "identity_mismatch",
        "Choose a separate CHATGPT_AUTH_FILE for a different registration.",
      );
    await writeProtected(file, { ...incoming, ext_agent_host_id: host });
  });
}

export async function chatGPTAccessToken(
  file: string,
  ctx: AuthContext = {},
  signal?: AbortSignal,
): Promise<string> {
  return withCredentialLock(
    file,
    async (assertOwnership) => {
      let saved = await read(file);
      if (!saved?.access_token || !saved.refresh_token)
        throw new ModelProviderError(
          "chatgpt",
          "credentials_missing",
          "Continue with ChatGPT on a laptop, then import its protected credential file on this server.",
        );
      if (!saved.scopes.includes("chatgpt.tokens.use.direct"))
        throw new ModelProviderError(
          "chatgpt",
          "plan_disabled",
          "This ChatGPT registration has no plan-use permission. Sign in again and enable ChatGPT plan usage.",
        );
      const expiresAt = Date.parse(saved.saved_at) + saved.expires_in * 1000;
      const earliest =
        typeof saved.earliest_refresh_at === "number"
          ? saved.earliest_refresh_at * 1000
          : Date.parse(saved.earliest_refresh_at ?? "");
      if (expiresAt - clock(ctx) > 120000 || (Number.isFinite(earliest) && clock(ctx) < earliest)) {
        if (expiresAt <= clock(ctx))
          throw new ModelProviderError(
            "chatgpt",
            "credentials_expired",
            "ChatGPT's token expired before its permitted refresh time. Try again later.",
          );
        return saved.access_token;
      }
      try {
        const payload = await oauthForm(
          "chatgpt",
          CHATGPT_TOKEN_URL,
          {
            grant_type: "refresh_token",
            client_id: saved.client_id,
            refresh_token: saved.refresh_token,
            resource: CHATGPT_RESOURCE,
          },
          ctx,
          signal,
        );
        const fields = tokenFields(payload, ctx, saved);
        if (payload.id_token) {
          const identity = await verifyChatGPTIdentity(
            String(payload.id_token),
            saved.client_id,
            undefined,
            ctx,
          );
          if (identity.subject !== saved.subject)
            throw new ModelProviderError(
              "chatgpt",
              "identity_mismatch",
              "Refreshed ChatGPT identity did not match. Existing credentials were preserved.",
            );
        }
        saved = credentialSchema.parse({ ...saved, ...fields });
        assertOwnership();
        await writeProtected(file, saved);
        if (!saved.scopes.includes("chatgpt.tokens.use.direct"))
          throw new ModelProviderError(
            "chatgpt",
            "plan_disabled",
            "ChatGPT plan usage permission was removed. Enable it through sign-in.",
          );
        return fields.access_token;
      } catch (error) {
        if (terminalRefresh(error)) {
          assertOwnership();
          await writeProtected(file, {
            ...saved,
            access_token: undefined,
            refresh_token: undefined,
            id_token: undefined,
          });
        }
        throw error;
      }
    },
    signal,
  );
}
