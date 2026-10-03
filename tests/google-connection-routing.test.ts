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
  test(`Google without ${missing} directs clients to the app catalog without starting OAuth`, async (t) => {
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
      assert.match(error.error, /app catalog in Connections/);
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
