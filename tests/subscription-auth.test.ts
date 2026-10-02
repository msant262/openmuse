import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { Config } from "../apps/server/src/config.ts";
import {
  beginChatGPTSignIn,
  CHATGPT_ISSUER,
  CHATGPT_RESOURCE,
  CHATGPT_TOKEN_URL,
  chatGPTAccessToken,
  completeChatGPTSignIn,
  importChatGPTCredential,
  verifyChatGPTIdentity,
} from "../apps/server/src/providers/chatgpt-auth.ts";
import { modelProviderConfig } from "../apps/server/src/providers/config.ts";
import {
  hostId,
  readProtected,
  writeProtected,
} from "../apps/server/src/providers/credential-store.ts";
import {
  GROK_CLIENT_ID,
  GROK_DEVICE_URL,
  GROK_ISSUER,
  GROK_SCOPE,
  grokAccessToken,
  grokDeviceLogin,
} from "../apps/server/src/providers/grok-auth.ts";
import { startModelTokenMaintenance } from "../apps/server/src/providers/maintenance.ts";
import { discovery } from "../apps/server/src/providers/oauth.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const now = Date.UTC(2026, 9, 2, 12);
const granted = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "openmuse-auth-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pair = await generateKeyPair("RS256", { extractable: true });
  const key = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256" };
  const calls: { url: string; body: URLSearchParams; redirect?: RequestRedirect }[] = [];
  let nonce = "test-nonce";
  let fields: Record<string, unknown> = {};
  let error: { code: string; status: number } | undefined;
  const sign = (
    claims: Record<string, unknown> = {},
    issuer = CHATGPT_ISSUER,
    audience = "oaiapp_test",
    expiry = now / 1000 + 3600,
  ) =>
    new SignJWT({ sub: "wife-account", email: "person@example.test", nonce, ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(now / 1000)
      .setExpirationTime(expiry)
      .sign(pair.privateKey);
  const fake: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = new URLSearchParams(
      typeof init?.body === "string" || init?.body instanceof URLSearchParams ? init.body : "",
    );
    calls.push({ url, body, redirect: init?.redirect });
    if (url.endsWith("/openid-configuration"))
      return json({
        issuer: CHATGPT_ISSUER,
        authorization_endpoint: `${CHATGPT_ISSUER}/api/accounts/authorize`,
        token_endpoint: CHATGPT_TOKEN_URL,
        jwks_uri: `${CHATGPT_ISSUER}/.well-known/jwks.json`,
      });
    if (url.endsWith("/jwks.json")) return json({ keys: [key] });
    if (url === CHATGPT_TOKEN_URL) {
      if (error) return json({ error: error.code }, error.status);
      return json({
        access_token: "access-rotated",
        refresh_token: "refresh-rotated",
        id_token: await sign(),
        token_type: "Bearer",
        expires_in: 3600,
        scope: granted,
        ...fields,
      });
    }
    throw new Error("Unexpected OAuth request");
  };
  return {
    dir,
    file: join(dir, "chatgpt.json"),
    ctx: { fetch: fake, now: () => now },
    calls,
    sign,
    nonce: (value: string) => {
      nonce = value;
    },
    fields: (value: Record<string, unknown>) => {
      fields = value;
    },
    error: (value: typeof error) => {
      error = value;
    },
  };
}

async function connect(f: Awaited<ReturnType<typeof fixture>>) {
  const attempt = await beginChatGPTSignIn(
    f.file,
    f.dir,
    "http://127.0.0.1:1455/auth/callback",
    f.ctx,
  );
  f.nonce(attempt.nonce);
  await completeChatGPTSignIn(
    f.file,
    attempt,
    new URLSearchParams({ state: attempt.state, code: "one-use-code", client_id: "oaiapp_test" }),
    f.ctx,
  );
  return attempt;
}

test("SIWC dynamic registration uses PKCE, validates identity, then reuses its issued client and host", async (t) => {
  const f = await fixture(t);
  const attempt = await connect(f);
  const query = new URL(attempt.url).searchParams;
  assert.equal(query.get("client_id"), "dynamic_agent_client");
  assert.equal(query.get("agent_name_hint"), "OpenMuse");
  assert.equal(query.get("resource"), CHATGPT_RESOURCE);
  assert.equal(query.get("scope"), granted);
  assert.equal(query.get("code_challenge_method"), "S256");
  assert.equal(
    query.get("code_challenge"),
    createHash("sha256").update(attempt.verifier).digest("base64url"),
  );
  const exchange = f.calls.find((c) => c.url === CHATGPT_TOKEN_URL);
  assert.ok(exchange);
  assert.equal(exchange.body.get("client_id"), "oaiapp_test");
  assert.equal(exchange.body.get("code_verifier"), attempt.verifier);
  assert.equal(exchange.body.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
  assert.equal(exchange.body.has("client_secret"), false);
  assert.equal(exchange.redirect, "error");
  const saved = (await readProtected(f.file)) as Record<string, unknown>;
  assert.equal(saved.subject, "wife-account");
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  const returning = await beginChatGPTSignIn(
    f.file,
    f.dir,
    "http://127.0.0.1:15432/auth/callback",
    f.ctx,
  );
  assert.equal(new URL(returning.url).searchParams.get("client_id"), "oaiapp_test");
  assert.equal(new URL(returning.url).searchParams.has("agent_name_hint"), false);
  assert.equal(new URL(returning.url).searchParams.has("id_token_hint"), false);
  assert.equal(returning.host, attempt.host);
  assert.notEqual(returning.state, attempt.state);
  assert.notEqual(returning.nonce, attempt.nonce);
});

test("SIWC rejects mismatched/reused state, rejected consent, missing registration and wrong returning account", async (t) => {
  const f = await fixture(t);
  let attempt = await beginChatGPTSignIn(
    f.file,
    f.dir,
    "http://127.0.0.1:1455/auth/callback",
    f.ctx,
  );
  await assert.rejects(
    completeChatGPTSignIn(
      f.file,
      attempt,
      new URLSearchParams({ state: "wrong", code: "unused" }),
      f.ctx,
    ),
    /callback/,
  );
  assert.equal(f.calls.length, 0);
  await assert.rejects(
    completeChatGPTSignIn(
      f.file,
      attempt,
      new URLSearchParams({ state: attempt.state, error: "access_denied" }),
      f.ctx,
    ),
    /declined/,
  );
  await assert.rejects(
    completeChatGPTSignIn(
      f.file,
      attempt,
      new URLSearchParams({ state: attempt.state, code: "unused", client_id: "oaiapp_test" }),
      f.ctx,
    ),
    /reused/,
  );
  attempt = await beginChatGPTSignIn(f.file, f.dir, "http://127.0.0.1:1455/auth/callback", f.ctx);
  await assert.rejects(
    completeChatGPTSignIn(
      f.file,
      attempt,
      new URLSearchParams({ state: attempt.state, code: "unused" }),
      f.ctx,
    ),
    /issued client/,
  );
  await connect(f);
  attempt = await beginChatGPTSignIn(f.file, f.dir, "http://127.0.0.1:1455/auth/callback", f.ctx);
  await assert.rejects(
    completeChatGPTSignIn(
      f.file,
      attempt,
      new URLSearchParams({ state: attempt.state, code: "unused", client_id: "oaiapp_other" }),
      f.ctx,
    ),
    /issued client/,
  );
  attempt = await beginChatGPTSignIn(f.file, f.dir, "http://127.0.0.1:1455/auth/callback", f.ctx);
  f.nonce(attempt.nonce);
  f.fields({ id_token: await f.sign({ sub: "another-account" }) });
  await assert.rejects(
    completeChatGPTSignIn(
      f.file,
      attempt,
      new URLSearchParams({ state: attempt.state, code: "unused" }),
      f.ctx,
    ),
    /another account/,
  );
  assert.equal(((await readProtected(f.file)) as Record<string, unknown>).subject, "wife-account");
});

test("SIWC verifies JWKS signature, issuer, audience, expiration and nonce", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await verifyChatGPTIdentity(await f.sign(), "oaiapp_test", "test-nonce", f.ctx)).subject,
    "wife-account",
  );
  for (const token of [
    await f.sign({}, "https://attacker.test"),
    await f.sign({}, CHATGPT_ISSUER, "wrong-client"),
    await f.sign({}, CHATGPT_ISSUER, "oaiapp_test", now / 1000 - 10),
    await f.sign({ nonce: "wrong" }),
  ]) {
    await assert.rejects(
      verifyChatGPTIdentity(token, "oaiapp_test", "test-nonce", f.ctx),
      /validation failed/,
    );
  }
  const token = await f.sign();
  const parts = token.split(".");
  const signature = Buffer.from(parts[2], "base64url");
  signature[0] ^= 1;
  parts[2] = signature.toString("base64url");
  await assert.rejects(
    verifyChatGPTIdentity(parts.join("."), "oaiapp_test", "test-nonce", f.ctx),
    /validation failed/,
  );
  await assert.rejects(
    beginChatGPTSignIn(f.file, f.dir, "http://localhost:1455/auth/callback", f.ctx),
    /127.0.0.1/,
  );
});

test("SIWC no-plan consent is retained without enabling inference; VM import keeps independent stable host", async (t) => {
  const f = await fixture(t);
  f.fields({ scope: "openid profile email offline_access resource.invoke" });
  await connect(f);
  await assert.rejects(chatGPTAccessToken(f.file, f.ctx), /no plan-use permission/);
  const laptop = (await readProtected(f.file)) as Record<string, unknown>;
  const vmDir = join(f.dir, "vm");
  const vmHost = await hostId(vmDir);
  await importChatGPTCredential(f.file, join(vmDir, "chatgpt.json"), vmDir);
  const imported = (await readProtected(join(vmDir, "chatgpt.json"))) as Record<string, unknown>;
  assert.equal(imported.ext_agent_host_id, vmHost);
  assert.notEqual(imported.ext_agent_host_id, laptop.ext_agent_host_id);
  assert.equal(imported.client_id, laptop.client_id);
  assert.equal(await hostId(vmDir), vmHost);
});

test("SIWC concurrent refresh atomically rotates once, respects earliest time, and keeps credentials on transient failures", async (t) => {
  const f = await fixture(t);
  await connect(f);
  const original = (await readProtected(f.file)) as Record<string, unknown>;
  await writeProtected(f.file, {
    ...original,
    saved_at: new Date(now - 3600000).toISOString(),
    access_token: "old-access",
    refresh_token: "old-refresh",
  });
  f.calls.length = 0;
  assert.deepEqual(
    await Promise.all([
      chatGPTAccessToken(f.file, f.ctx),
      chatGPTAccessToken(f.file, f.ctx),
      chatGPTAccessToken(f.file, f.ctx),
    ]),
    ["access-rotated", "access-rotated", "access-rotated"],
  );
  const refreshes = f.calls.filter((c) => c.url === CHATGPT_TOKEN_URL);
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].body.get("grant_type"), "refresh_token");
  assert.equal(refreshes[0].body.get("refresh_token"), "old-refresh");
  assert.equal(refreshes[0].body.get("scope"), null);
  assert.equal(
    ((await readProtected(f.file)) as Record<string, unknown>).refresh_token,
    "refresh-rotated",
  );
  const expired = { ...original, saved_at: new Date(now - 3600000).toISOString() };
  await writeProtected(f.file, { ...expired, earliest_refresh_at: now / 1000 + 60 });
  f.calls.length = 0;
  await assert.rejects(chatGPTAccessToken(f.file, f.ctx), /permitted refresh time/);
  assert.equal(f.calls.length, 0);
  await writeProtected(f.file, expired);
  f.error({ code: "temporarily_unavailable", status: 503 });
  await assert.rejects(chatGPTAccessToken(f.file, f.ctx), /temporarily unavailable/);
  assert.equal(
    ((await readProtected(f.file)) as Record<string, unknown>).refresh_token,
    original.refresh_token,
  );
  f.error({ code: "invalid_grant", status: 400 });
  await assert.rejects(chatGPTAccessToken(f.file, f.ctx));
  const cleared = (await readProtected(f.file)) as Record<string, unknown>;
  assert.equal(cleared.access_token, undefined);
  assert.equal(cleared.refresh_token, undefined);
  assert.equal(cleared.client_id, "oaiapp_test");
  assert.equal(cleared.subject, original.subject);
});

test("shared-volume lock prevents API and standalone-worker refresh-token races", async (t) => {
  const f = await fixture(t);
  await connect(f);
  await writeProtected(f.file, {
    ...((await readProtected(f.file)) as object),
    saved_at: new Date(Date.now() - 3600000).toISOString(),
  });
  let refreshes = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.equal(new URLSearchParams(body).get("refresh_token"), "refresh-rotated");
    refreshes++;
    await new Promise((resolve) => setTimeout(resolve, 150));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        access_token: "process-shared-new",
        refresh_token: "process-shared-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        scope: granted,
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const module = new URL("../apps/server/src/providers/chatgpt-auth.ts", import.meta.url).href;
  const source = `import {chatGPTAccessToken} from ${JSON.stringify(module)}; await chatGPTAccessToken(process.argv[1], {fetch: (_url, init) => fetch(process.argv[2], init)});`;
  const child = () =>
    new Promise<void>((resolve, reject) => {
      const processChild = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          source,
          f.file,
          `http://127.0.0.1:${address.port}`,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let errors = "";
      processChild.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      processChild.on("error", reject);
      processChild.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(errors))));
    });
  await Promise.all([child(), child()]);
  assert.equal(refreshes, 1);
  assert.equal(
    ((await readProtected(f.file)) as Record<string, unknown>).refresh_token,
    "process-shared-refresh",
  );
});

test("protected credentials reject loose modes, symlinks and unsafe discovery redirects", async (t) => {
  const f = await fixture(t);
  await connect(f);
  await chmod(f.file, 0o644);
  await assert.rejects(readProtected(f.file), /permissions/);
  await chmod(f.file, 0o600);
  const link = join(f.dir, "linked.json");
  await symlink(f.file, link);
  await assert.rejects(readProtected(link), /protected credentials/);
  await assert.rejects(writeProtected(link, {}), /regular file/);
  const malicious: typeof fetch = async () =>
    json({
      issuer: GROK_ISSUER,
      authorization_endpoint: `${GROK_ISSUER}/authorize`,
      token_endpoint: "https://attacker.test/token",
    });
  await assert.rejects(discovery(GROK_ISSUER, { fetch: malicious }, true), /untrusted endpoint/);
  await assert.rejects(
    discovery(GROK_ISSUER, { fetch: async () => json({ issuer: "https://attacker.test" }) }, true),
    /issuer/,
  );
});

test("Grok uses Hermes's device protocol with pending/slow_down and refreshes short-lived rotating tokens", async (t) => {
  const f = await fixture(t);
  const file = join(f.dir, "grok.json");
  let time = now,
    polls = 0,
    refreshes = 0;
  const waits: number[] = [],
    grants: URLSearchParams[] = [];
  const fake: typeof fetch = async (input, init) => {
    assert.equal(init?.redirect, "error");
    const url = String(input),
      form = new URLSearchParams(init?.body as URLSearchParams);
    if (url.endsWith("/openid-configuration"))
      return json({
        issuer: GROK_ISSUER,
        authorization_endpoint: `${GROK_ISSUER}/authorize`,
        token_endpoint: `${GROK_ISSUER}/discovered-token`,
      });
    if (url === GROK_DEVICE_URL) {
      assert.equal(form.get("client_id"), GROK_CLIENT_ID);
      assert.equal(form.get("scope"), GROK_SCOPE);
      return json({
        device_code: "private-device-code",
        user_code: "ABCD",
        verification_uri: "https://accounts.x.ai/device",
        verification_uri_complete: "https://accounts.x.ai/device?code=ABCD",
        expires_in: 600,
        interval: 1,
      });
    }
    assert.equal(url, `${GROK_ISSUER}/discovered-token`);
    grants.push(form);
    if (form.get("grant_type") === "refresh_token") {
      refreshes++;
      assert.equal(form.get("refresh_token"), "device-refresh");
      return json({
        access_token: "grok-new",
        refresh_token: "grok-rotated",
        token_type: "Bearer",
        expires_in: 900,
      });
    }
    polls++;
    if (polls <= 2)
      return json({ error: polls === 1 ? "authorization_pending" : "slow_down" }, 400);
    return json({
      access_token: "grok-initial",
      refresh_token: "device-refresh",
      token_type: "Bearer",
      expires_in: 900,
    });
  };
  const ctx = {
    fetch: fake,
    now: () => time,
    sleep: async (ms: number) => {
      waits.push(ms);
      time += ms;
    },
  };
  let shown: { url: string; code: string } | undefined;
  await grokDeviceLogin(
    file,
    (value) => {
      shown = value;
    },
    ctx,
  );
  assert.deepEqual(shown, { url: "https://accounts.x.ai/device?code=ABCD", code: "ABCD" });
  assert.deepEqual(waits, [1000, 1000, 6000]);
  assert.equal(grants[0].get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
  assert.equal(grants[0].get("device_code"), "private-device-code");
  assert.equal(await grokAccessToken(file, ctx), "grok-initial");
  assert.equal(refreshes, 0);
  time += 800000;
  assert.equal(await grokAccessToken(file, ctx), "grok-new");
  assert.equal(refreshes, 1);
  assert.equal(
    ((await readProtected(file)) as Record<string, unknown>).refresh_token,
    "grok-rotated",
  );
  assert.equal(await grokAccessToken(file, ctx), "grok-new");
  assert.equal(refreshes, 1);
});

test("Grok denial/expiry/cancellation stop device polling and tier refusals retain the session", async (t) => {
  const f = await fixture(t);
  const file = join(f.dir, "grok.json");
  for (const code of ["access_denied", "expired_token"]) {
    const fake: typeof fetch = async (input) =>
      String(input).endsWith("/openid-configuration")
        ? json({
            issuer: GROK_ISSUER,
            authorization_endpoint: `${GROK_ISSUER}/authorize`,
            token_endpoint: `${GROK_ISSUER}/token`,
          })
        : String(input) === GROK_DEVICE_URL
          ? json({
              device_code: "device",
              user_code: "CODE",
              verification_uri: "https://accounts.x.ai/device",
              expires_in: 30,
              interval: 1,
            })
          : json({ error: code }, 400);
    await assert.rejects(
      grokDeviceLogin(file, () => {}, { fetch: fake, sleep: async () => {} }),
      /declined or expired/,
    );
  }
  await writeProtected(file, {
    version: 1,
    provider: "grok",
    token_endpoint: `${GROK_ISSUER}/token`,
    access_token: "grok-old",
    refresh_token: "grok-refresh",
    expires_in: 900,
    saved_at: new Date(now - 900000).toISOString(),
    token_type: "Bearer",
  });
  await assert.rejects(
    grokAccessToken(file, { now: () => now, fetch: async () => json({ error: "forbidden" }, 403) }),
    /tier/,
  );
  assert.equal(
    ((await readProtected(file)) as Record<string, unknown>).refresh_token,
    "grok-refresh",
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(grokAccessToken(file, {}, abort.signal), { name: "AbortError" });
});

test("SIWC saves a validated rotating grant before honoring consumer cancellation", async (t) => {
  const f = await fixture(t);
  await connect(f);
  await writeProtected(f.file, {
    ...((await readProtected(f.file)) as object),
    saved_at: new Date(now - 3600000).toISOString(),
    access_token: "old-access",
    refresh_token: "old-refresh",
  });
  f.calls.length = 0;
  const abort = new AbortController();
  const fetchAfterRotation: typeof fetch = async (input, init) => {
    const response = await f.ctx.fetch(input, init);
    if (String(input) === CHATGPT_TOKEN_URL) {
      // The authority already rotated the token set; the consumer now cancels.
      const payload = await response.json();
      abort.abort();
      return json(payload);
    }
    return response;
  };
  await assert.rejects(
    chatGPTAccessToken(f.file, { ...f.ctx, fetch: fetchAfterRotation }, abort.signal),
    { name: "AbortError" },
  );
  const saved = (await readProtected(f.file)) as Record<string, unknown>;
  assert.equal(saved.access_token, "access-rotated");
  assert.equal(saved.refresh_token, "refresh-rotated");
  assert.equal(await chatGPTAccessToken(f.file, f.ctx), "access-rotated");
  assert.equal(f.calls.filter((c) => c.url === CHATGPT_TOKEN_URL).length, 1);
});

test("Grok saves a rotating grant before honoring consumer cancellation", async (t) => {
  const f = await fixture(t),
    file = join(f.dir, "grok.json");
  await writeProtected(file, {
    version: 1,
    provider: "grok",
    token_endpoint: `${GROK_ISSUER}/oauth2/token`,
    access_token: "grok-old",
    refresh_token: "grok-old-refresh",
    expires_in: 900,
    saved_at: new Date(now - 900000).toISOString(),
    token_type: "Bearer",
  });
  const abort = new AbortController();
  let refreshes = 0;
  const fake: typeof fetch = async (_input, init) => {
    assert.equal(
      new URLSearchParams(init?.body as URLSearchParams).get("refresh_token"),
      "grok-old-refresh",
    );
    refreshes++;
    abort.abort();
    return json({
      access_token: "grok-new",
      refresh_token: "grok-new-refresh",
      expires_in: 900,
      token_type: "Bearer",
    });
  };
  await assert.rejects(grokAccessToken(file, { fetch: fake, now: () => now }, abort.signal), {
    name: "AbortError",
  });
  const saved = (await readProtected(file)) as Record<string, unknown>;
  assert.equal(saved.access_token, "grok-new");
  assert.equal(saved.refresh_token, "grok-new-refresh");
  assert.equal(await grokAccessToken(file, { fetch: fake, now: () => now }), "grok-new");
  assert.equal(refreshes, 1);
});

test("maintenance shutdown waits for successful grant persistence for each subscription", async (t) => {
  for (const provider of ["chatgpt", "grok"] as const) {
    await t.test(provider, async (t) => {
      const f = await fixture(t);
      const providers = modelProviderConfig(f.dir, {});
      const file = provider === "chatgpt" ? providers.chatgptFile : providers.grokFile;
      if (provider === "chatgpt") {
        await connect(f);
        await writeProtected(file, {
          ...((await readProtected(f.file)) as object),
          saved_at: new Date(Date.now() - 3600000).toISOString(),
          access_token: "old-access",
          refresh_token: "old-refresh",
        });
      } else {
        await writeProtected(file, {
          version: 1,
          provider,
          token_endpoint: `${GROK_ISSUER}/oauth2/token`,
          access_token: "old-access",
          refresh_token: "old-refresh",
          expires_in: 900,
          saved_at: new Date(Date.now() - 900000).toISOString(),
          token_type: "Bearer",
        });
      }
      let rotationReady: () => void = () => {},
        releaseBody: () => void = () => {};
      const ready = new Promise<void>((resolve) => {
        rotationReady = resolve;
      });
      const body = new Promise<void>((resolve) => {
        releaseBody = resolve;
      });
      let refreshes = 0;
      const originalFetch = globalThis.fetch;
      t.after(() => {
        globalThis.fetch = originalFetch;
        releaseBody();
      });
      globalThis.fetch = async (input, init) => {
        assert.equal(
          String(input),
          provider === "chatgpt" ? CHATGPT_TOKEN_URL : `${GROK_ISSUER}/oauth2/token`,
        );
        assert.equal(
          new URLSearchParams(init?.body as URLSearchParams).get("refresh_token"),
          "old-refresh",
        );
        refreshes++;
        const response = json({
          access_token: "maintenance-new",
          refresh_token: "maintenance-refresh",
          token_type: "Bearer",
          expires_in: provider === "chatgpt" ? 3600 : 900,
          scope: granted,
        });
        const decoded = response.json.bind(response);
        response.json = async () => {
          const payload = await decoded();
          rotationReady();
          await body;
          return payload;
        };
        return response;
      };
      const stop = startModelTokenMaintenance(
        {
          agentBackend: "model",
          model: `${provider}/test`,
          modelProviders: providers,
          dataDir: f.dir,
        } as Config,
        5,
      );
      t.after(stop);
      await ready;
      let stopped = false;
      const stopping = stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      assert.equal(stopped, false);
      releaseBody();
      await stopping;
      const saved = (await readProtected(file)) as Record<string, unknown>;
      assert.equal(saved.access_token, "maintenance-new");
      assert.equal(saved.refresh_token, "maintenance-refresh");
      assert.equal(
        provider === "chatgpt" ? await chatGPTAccessToken(file) : await grokAccessToken(file),
        "maintenance-new",
      );
      assert.equal(refreshes, 1);
    });
  }
});
