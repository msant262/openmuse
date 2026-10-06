import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { type TestContext, test } from "node:test";
import type { Config } from "../apps/server/src/config.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const accessKey = "synthetic-google-routing-pairing-key";

async function fixture(t: TestContext, config: Partial<Config> = {}) {
  const server = await taskRuntime(t, { mode: "live", accessKey, ...config });
  const { token } = await server.auth.session(accessKey);
  return {
    ...server,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  };
}

test("Google availability requires pairing and exposes no configuration values", async (t) => {
  const server = await fixture(t);
  assert.equal((await server.app.request("/api/google/status")).status, 401);
  const response = await server.app.request("/api/google/status", { headers: server.headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { configured: false });
});

for (const missing of ["googleClientId", "googleClientSecret", "encryptionKey"] as const) {
  test(`Google without ${missing} explains app setup without asking the user for a platform key`, async (t) => {
    const server = await fixture(t, {
      googleClientId: "synthetic-google-client",
      googleClientSecret: "synthetic-google-secret",
      encryptionKey: randomBytes(32).toString("base64"),
      [missing]: undefined,
    });
    const status = await server.app.request("/api/google/status", { headers: server.headers });
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { configured: false });
    for (const capability of ["read", "write"]) {
      const response = await server.app.request("/api/google/connect", {
        method: "POST",
        headers: server.headers,
        body: JSON.stringify({ capability }),
      });
      assert.equal(response.status, 503);
      const error = await response.json();
      assert.equal(error.code, "GOOGLE_SETUP_REQUIRED");
      assert.match(error.error, /administrator.*app setup/i);
      assert.doesNotMatch(error.error, /GOOGLE_CLIENT|TOKEN_ENCRYPTION|synthetic-google/);
    }
    assert.deepEqual(await server.db.list("system", "oauth"), []);
    assert.equal(await server.db.get("local-user", "credentials", "google"), null);
  });
}

test("configured Google still starts native read and write OAuth with PKCE", async (t) => {
  const server = await fixture(t, {
    googleClientId: "synthetic-google-client",
    googleClientSecret: "synthetic-google-secret",
    encryptionKey: randomBytes(32).toString("base64"),
  });
  const status = await server.app.request("/api/google/status", { headers: server.headers });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { configured: true });
  for (const capability of ["read", "write"]) {
    const response = await server.app.request("/api/google/connect", {
      method: "POST",
      headers: server.headers,
      body: JSON.stringify({ capability }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    const url = new URL(result.url);
    assert.equal(url.origin, "https://accounts.google.com");
    assert.equal(url.searchParams.get("client_id"), "synthetic-google-client");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.ok(url.searchParams.get("code_challenge"));
    assert.ok(url.searchParams.get("state"));
    assert.equal(url.searchParams.get("prompt"), "select_account consent");
    assert.equal(url.searchParams.has("login_hint"), false);
    assert.match(url.searchParams.get("scope") ?? "", /gmail\.readonly/);
    assert.equal(
      (url.searchParams.get("scope") ?? "").includes("auth/gmail.send"),
      capability === "write",
    );
    assert.doesNotMatch(JSON.stringify(result), /synthetic-google-secret/);
  }
});

test("sample Google remains available and connects local data without OAuth", async (t) => {
  const server = await fixture(t, { mode: "sample" });
  const status = await server.app.request("/api/google/status", { headers: server.headers });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { configured: true });
  const response = await server.app.request("/api/google/connect", {
    method: "POST",
    headers: server.headers,
    body: JSON.stringify({ capability: "read" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: null, connected: true });
  assert.equal(await server.workspace.connected("local-user"), true);
  assert.deepEqual(await server.db.list("system", "oauth"), []);
});

test("Google app configuration never connects an account; account receipt requires pairing", async (t) => {
  const server = await fixture(t, {
    googleClientId: "synthetic-google-client",
    googleClientSecret: "synthetic-google-secret",
    encryptionKey: randomBytes(32).toString("base64"),
  });
  assert.equal((await server.app.request("/api/google/account")).status, 401);
  const response = await server.app.request("/api/google/account", { headers: server.headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { connected: false, accounts: [] });
  assert.equal(
    (await server.db.get<{ secret?: string }>("local-user", "credentials", "google"))?.secret ??
      null,
    null,
  );
});

test("cancelled and expired Google sign-in offer a usable return to the app", async (t) => {
  const server = await fixture(t, {
    googleClientId: "synthetic-google-client",
    googleClientSecret: "synthetic-google-secret",
    encryptionKey: randomBytes(32).toString("base64"),
  });
  const started = await server.app.request("/api/google/connect", {
    method: "POST",
    headers: server.headers,
    body: JSON.stringify({ capability: "read" }),
  });
  const { url } = await started.json();
  const state = new URL(url).searchParams.get("state");
  assert.ok(state);
  const cancelled = await server.app.request(
    `/api/google/callback?error=access_denied&state=${state}`,
  );
  assert.equal(cancelled.status, 400);
  assert.match(await cancelled.text(), /Voltar ao Okami/);
  assert.equal(cancelled.headers.get("cache-control"), "no-store");
  assert.equal(await server.db.get("system", "oauth", state), null);
  const expired = await server.app.request("/api/google/callback?state=expired&code=synthetic");
  assert.equal(expired.status, 400);
  assert.match(await expired.text(), /Voltar ao Okami/);
  assert.equal(
    (await server.db.get<{ secret?: string }>("local-user", "credentials", "google"))?.secret ??
      null,
    null,
  );
});
