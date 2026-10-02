// Device/refresh protocol adapted from NousResearch/hermes-agent, MIT.
// Pinned source e05b16348b1d06a3311237423b0a4fc30d9c5aa1; see docs/licenses/HERMES-MIT.txt.
import { decodeJwt } from "jose";
import { z } from "zod";
import { readProtected, sleep, withCredentialLock, writeProtected } from "./credential-store.ts";
import { httpProviderError, ModelProviderError } from "./errors.ts";
import {
  type AuthContext,
  authUrl,
  clock,
  discovery,
  oauthForm,
  oauthRequest,
  terminalRefresh,
} from "./oauth.ts";

export const GROK_ISSUER = "https://auth.x.ai";
export const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const GROK_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const GROK_DEVICE_URL = `${GROK_ISSUER}/oauth2/device/code`;
export const GROK_API_URL = "https://api.x.ai/v1";
const schema = z.object({
  version: z.literal(1),
  provider: z.literal("grok"),
  token_endpoint: z.string(),
  access_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().finite().positive(),
  saved_at: z.iso.datetime(),
  token_type: z.literal("Bearer"),
});
type GrokCredential = z.infer<typeof schema>;
type GrokContext = AuthContext & { sleep?: typeof sleep };

async function read(file: string) {
  const raw = await readProtected(file);
  if (raw === undefined) return undefined;
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new ModelProviderError(
      "grok",
      "credentials_invalid",
      "Grok credentials have an invalid format. Run OpenMuse's Grok login command.",
    );
  authUrl(parsed.data.token_endpoint, GROK_ISSUER, true);
  return parsed.data;
}

function tokenFields(raw: Record<string, unknown>, ctx: AuthContext, previous?: GrokCredential) {
  const parsed = z
    .object({
      access_token: z.string().min(1),
      refresh_token: z.string().min(1).optional(),
      token_type: z.literal("Bearer").default("Bearer"),
      expires_in: z.number().finite().positive().optional(),
    })
    .safeParse(raw);
  if (!parsed.success || (!parsed.data.refresh_token && !previous?.refresh_token))
    throw new ModelProviderError(
      "grok",
      "invalid_token_response",
      "xAI did not return the required token set. Existing credentials were preserved.",
    );
  let jwtExpiry: number | undefined;
  try {
    jwtExpiry = decodeJwt(parsed.data.access_token).exp;
  } catch {
    /* An opaque token is also valid. */
  }
  const expiry = parsed.data.expires_in ?? (jwtExpiry ? jwtExpiry - clock(ctx) / 1000 : undefined);
  if (!expiry || expiry <= 0)
    throw new ModelProviderError(
      "grok",
      "invalid_token_response",
      "xAI did not provide a valid token expiry.",
    );
  return {
    ...parsed.data,
    expires_in: Math.min(expiry, jwtExpiry ? jwtExpiry - clock(ctx) / 1000 : expiry),
    refresh_token: parsed.data.refresh_token ?? previous?.refresh_token,
    saved_at: new Date(clock(ctx)).toISOString(),
  };
}

export async function grokDeviceLogin(
  file: string,
  onCode: (code: { url: string; code: string }) => void,
  ctx: GrokContext = {},
  signal?: AbortSignal,
) {
  const meta = await discovery(GROK_ISSUER, ctx, true);
  const device = await oauthForm(
    "grok",
    GROK_DEVICE_URL,
    { client_id: GROK_CLIENT_ID, scope: GROK_SCOPE },
    ctx,
    signal,
  );
  const parsed = z
    .object({
      device_code: z.string().min(1),
      user_code: z.string().min(1),
      verification_uri: z.string(),
      verification_uri_complete: z.string().optional(),
      expires_in: z.number().finite().positive().max(3600),
      interval: z.number().finite().positive().max(60),
    })
    .safeParse(device);
  if (!parsed.success)
    throw new ModelProviderError(
      "grok",
      "device_response_invalid",
      "xAI returned an incomplete device authorization response.",
    );
  const data = parsed.data;
  authUrl(data.verification_uri, GROK_ISSUER, true);
  onCode({
    url: authUrl(data.verification_uri_complete ?? data.verification_uri, GROK_ISSUER, true),
    code: data.user_code,
  });
  const deadline = clock(ctx) + data.expires_in * 1000;
  let interval = data.interval * 1000;
  while (clock(ctx) < deadline) {
    await (ctx.sleep ?? sleep)(Math.min(interval, deadline - clock(ctx)), signal);
    if (clock(ctx) >= deadline) break;
    const response = await oauthRequest(
      "grok",
      meta.token_endpoint,
      {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: GROK_CLIENT_ID,
          device_code: data.device_code,
        }),
      },
      ctx,
    );
    if (response.ok) {
      const fields = tokenFields(await response.json(), ctx);
      const record = schema.parse({
        ...fields,
        version: 1,
        provider: "grok",
        token_endpoint: meta.token_endpoint,
      });
      await withCredentialLock(file, () => writeProtected(file, record), signal);
      return;
    }
    const error = await httpProviderError("grok", response);
    if (error.code === "authorization_pending") continue;
    if (error.code === "slow_down") {
      interval += 5000;
      continue;
    }
    if (error.code === "access_denied" || error.code === "expired_token")
      throw new ModelProviderError(
        "grok",
        error.code,
        "Grok device authorization was declined or expired. Start a fresh login.",
      );
    throw error;
  }
  throw new ModelProviderError(
    "grok",
    "device_expired",
    "Grok device authorization expired. Start a fresh login.",
  );
}

export async function grokAccessToken(
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
          "grok",
          "credentials_missing",
          "Sign in with Grok using OpenMuse's device login command on this server.",
        );
      const expiry = Date.parse(saved.saved_at) + saved.expires_in * 1000;
      const lead = saved.expires_in <= 3600 ? Math.min(120000, saved.expires_in * 200) : 3600000;
      if (expiry - clock(ctx) > lead) return saved.access_token;
      try {
        const raw = await oauthForm(
          "grok",
          saved.token_endpoint,
          {
            grant_type: "refresh_token",
            client_id: GROK_CLIENT_ID,
            refresh_token: saved.refresh_token,
          },
          ctx,
          signal,
        );
        const fields = tokenFields(raw, ctx, saved);
        saved = schema.parse({ ...saved, ...fields });
        assertOwnership();
        await writeProtected(file, saved);
        return fields.access_token;
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
