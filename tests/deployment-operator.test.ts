import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { browserFallbackFixture } from "./helpers/browser-fallback.ts";

const token = () => `odb1.${randomBytes(32).toString("base64url")}`;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

test("actual backup operator works after paired/legacy access expiry and admits only exact maintenance routes and bodies", async (t) => {
  const operator = token();
  const server = await browserFallbackFixture(t, {
    deploymentOperatorTokenSha256: digest(operator),
  });
  const device = await server.auth.session(undefined, "expired backup device");
  const now = Date.now();
  await server.db.put("system", "sessions", {
    id: digest("expired-legacy-fixture"),
    owner: "local-user",
    expiresAt: now - 1,
  });
  t.mock.method(Date, "now", () => now + 16 * 60_000);
  const request = (
    path: string,
    body?: unknown,
    credential = operator,
    method = body === undefined ? "GET" : "POST",
  ) =>
    server.app.request(path, {
      method,
      headers: { authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  for (const expired of [device.token, "expired-legacy-fixture"]) {
    const denied = await request("/api/deployment/status", undefined, expired);
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).code, "SESSION_EXPIRED");
  }
  assert.equal((await request("/api/deployment/status")).status, 200);
  const devicesBefore = await server.auth.devices.list("local-user");
  for (const [method, path, body] of [
    ["GET", "/api/workspace", undefined],
    ["GET", "/api/files", undefined],
    ["POST", "/api/agent/tasks", { prompt: "Operator cannot create tasks" }],
    ["POST", "/api/copilotkit", {}],
    ["POST", "/api/session", {}],
    ["POST", "/api/session/refresh", {}],
    ["POST", `/executor/lenovo-bot/claim`, {}],
    ["GET", "/api/health", undefined],
    ["GET", "/", undefined],
    ["GET", "/api/deployment/maintenance", undefined],
    ["POST", "/api/deployment/status", {}],
    ["GET", "/api/agent/runtime-pause", undefined],
    ["GET", "/api/deployment/status?owner=local-user", undefined],
    ["GET", "/api/deployment/%73tatus", undefined],
    ["OPTIONS", "/api/deployment/status", undefined],
  ] as const) {
    const response = await request(path, body, operator, method);
    assert.equal(response.status, 403, path);
    assert.equal((await response.json()).code, "DEPLOYMENT_OPERATOR_SCOPE");
  }
  assert.deepEqual(await server.auth.devices.list("local-user"), devicesBefore);
  assert.equal(
    (await request(server.auth.sign("local-user", "/api/files/fixture/content"))).status,
    403,
  );
  assert.equal((await request("/api/deployment/status", undefined, token())).status, 401);
  assert.equal((await request("/api/deployment/status", undefined, "odb1.short")).status, 401);
  const id = randomUUID();
  for (const body of [
    { id, operation: "begin", owner: "local-user" },
    { id, operation: "begin", ttlMs: 120001 },
    { id, operation: "override" },
  ])
    assert.equal((await request("/api/deployment/maintenance", body)).status, 422);
  assert.equal(
    (await request("/api/agent/runtime-pause", { paused: true, expectedRevision: 0, force: true }))
      .status,
    422,
  );
  assert.equal((await request("/api/deployment/status")).status, 200);
  assert.equal(
    (await request("/api/deployment/maintenance", { id, operation: "begin", ttlMs: 120000 }))
      .status,
    200,
  );
  assert.equal(
    (await request("/api/deployment/maintenance", { id, operation: "renew", ttlMs: 120000 }))
      .status,
    200,
  );
  const pause = await request("/api/agent/runtime-pause", { paused: true, expectedRevision: 0 });
  assert.equal(pause.status, 200);
  assert.equal((await pause.json()).revision, 1);
  assert.equal(
    (await request("/api/agent/runtime-pause", { paused: false, expectedRevision: 0 })).status,
    409,
  );
  assert.equal(
    (await request("/api/deployment/maintenance", { id, operation: "finish" })).status,
    200,
  );
  assert.equal(
    (await request("/api/agent/runtime-pause", { paused: false, expectedRevision: 1 })).status,
    200,
  );
  assert.equal(server.nativeCalls.length, 0);
  const oversized = await request("/api/agent/runtime-pause", {
    paused: true,
    expectedRevision: 2,
    padding: "x".repeat(5000),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).code, "DEPLOYMENT_OPERATOR_BODY_TOO_LARGE");
  assert.equal(server.vpsCalls.length, 0);
});

test("actual API rejects a rotated or disabled operator hash without changing paired-device authentication", async (t) => {
  const old = token(),
    replacement = token();
  for (const configured of [digest(replacement), undefined]) {
    const server = await browserFallbackFixture(t, { deploymentOperatorTokenSha256: configured });
    const request = (credential: string) =>
      server.app.request("/api/deployment/status", {
        headers: { authorization: `Bearer ${credential}` },
      });
    assert.equal((await request(old)).status, 401);
    assert.equal((await request(replacement)).status, configured ? 200 : 401);
    const device = await server.auth.session(undefined, "regular device");
    assert.equal(
      (
        await server.app.request("/api/workspace", {
          headers: { authorization: `Bearer ${device.token}` },
        })
      ).status,
      200,
    );
  }
});
