import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import * as authModule from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "device-sessions-"));
  const db = await createStore();
  t.after(async () => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    allowedOrigins: [],
    googleRedirectUri: "http://localhost:8787/api/google/callback",
  };
  return { db, directory, config, auth: await authModule.createAuth(db, config) };
}

test("access expires after fifteen minutes while pairing lasts thirty days and restarts", async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const { auth, db, config } = await fixture(t);
  const session = await auth.session(undefined, "phone");
  assert.equal(session.accessExpiresAt, now + 900_000);
  assert.equal(await auth.owner(`Bearer ${session.token}`), "local-user");
  now += 900_001;
  await assert.rejects(auth.owner(`Bearer ${session.token}`), { code: "SESSION_EXPIRED" });
  let refreshToken = session.refreshToken;
  for (const days of [2, 30]) {
    now = 1_800_000_000_000 + days * 86_400_000;
    const next = randomBytes(32).toString("base64url");
    const restarted = await authModule.createAuth(db, config);
    const refreshed = await restarted.devices.refresh({
      deviceId: session.deviceId,
      rotationId: `rotation-${days}`,
      currentToken: refreshToken,
      nextTokenHash: hash(next),
    });
    assert.equal(refreshed.deviceId, session.deviceId);
    assert.equal(await restarted.owner(`Bearer ${refreshed.token}`), "local-user");
    refreshToken = next;
  }
});

test("web refresh is cookie-only, origin protected and recovers a lost Set-Cookie after thirty days", async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const { db, config } = await fixture(t);
  config.allowedOrigins = ["http://localhost:8081"];
  const { app } = await createApp(db, config);
  const headers = {
    "Content-Type": "application/json",
    Origin: "http://localhost:8081",
    "X-OpenMuse-CSRF": "1",
  };
  const paired = await app.request("/api/session", {
    method: "POST",
    headers,
    body: JSON.stringify({ transport: "web", deviceLabel: "browser" }),
  });
  assert.equal(paired.status, 200);
  const session = await paired.json();
  assert.equal("refreshToken" in session, false);
  const setCookie = paired.headers.get("set-cookie")!;
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=Lax/i);
  const cookie = setCookie.split(";")[0];
  const refresh = (cookieHeader: string, origin?: string, csrf = "1") =>
    app.request("/api/session/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        ...(origin ? { Origin: origin } : {}),
        "X-OpenMuse-CSRF": csrf,
      },
      body: JSON.stringify({ transport: "web", rotationId: "rotation-lost-web-cookie" }),
    });
  assert.equal((await refresh(cookie)).status, 403);
  assert.equal((await refresh(cookie, "http://localhost:8081", "")).status, 403);
  const lost = await refresh(cookie, "http://localhost:8081");
  assert.equal(lost.status, 200);
  const successorCookie = lost.headers.get("set-cookie")!.split(";")[0];
  now += 30 * 86_400_000;
  const recovered = await refresh(cookie, "http://localhost:8081");
  assert.equal(recovered.status, 200);
  assert.equal(recovered.headers.get("set-cookie")!.split(";")[0], successorCookie);
  assert.equal("refreshToken" in (await recovered.json()), false);
  const listed = await app.request("/api/devices", {
    headers: {
      Authorization: `Bearer ${(await (await refresh(successorCookie, "http://localhost:8081")).json()).token}`,
    },
  });
  assert.equal(listed.status, 200);
  const records = JSON.stringify(await db.list("system", "device-sessions"));
  assert.equal(records.includes(successorCookie.split(".").at(-1)!), false);
  const revoke = await app.request(`/api/devices/${session.deviceId}/revoke`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${(await (await refresh(successorCookie, "http://localhost:8081")).json()).token}`,
    },
  });
  assert.equal(revoke.status, 200);
  assert.equal((await refresh(successorCookie, "http://localhost:8081")).status, 401);
});

test("native rotation survives lost responses and cannot bind a receipt to different arguments", async (t) => {
  const { auth, db, config } = await fixture(t);
  const session = await auth.session(undefined, "phone");
  const next = randomBytes(32).toString("base64url");
  const request = {
    deviceId: session.deviceId,
    rotationId: "rotation-lost-response",
    currentToken: session.refreshToken,
    nextTokenHash: hash(next),
  };
  await auth.devices.refresh(request); // Server commits, process/response is lost.
  const restarted = await authModule.createAuth(db, config);
  const recovered = await restarted.devices.refresh(request);
  assert.equal(await restarted.owner(`Bearer ${recovered.token}`), "local-user");
  await assert.rejects(
    restarted.devices.refresh({ ...request, nextTokenHash: hash("different-successor") }),
    { code: "SESSION_ROTATION_CONFLICT" },
  );
  await restarted.devices.refresh({
    ...request,
    rotationId: "rotation-after-recovery",
    currentToken: next,
    nextTokenHash: hash("second-successor"),
  });
  const records = JSON.stringify(await db.list("system", "device-sessions"));
  assert.equal(records.includes(session.refreshToken), false);
  assert.equal(records.includes(next), false);
});

test("concurrent refreshes recover the same native rotation and revocation isolates one device", async (t) => {
  const { auth } = await fixture(t);
  const first = await auth.session(undefined, "phone"),
    second = await auth.session(undefined, "tablet");
  const request = {
    deviceId: first.deviceId,
    rotationId: "rotation-concurrent",
    currentToken: first.refreshToken,
    nextTokenHash: hash("successor"),
  };
  const results = await Promise.all(
    Array.from({ length: 10 }, () => auth.devices.refresh(request)),
  );
  for (const result of results) assert.equal(result.deviceId, first.deviceId);
  await auth.devices.revoke("local-user", first.deviceId);
  await assert.rejects(auth.owner(`Bearer ${first.token}`), { code: "SESSION_REVOKED" });
  await assert.rejects(auth.devices.refresh(request), { code: "SESSION_REVOKED" });
  assert.equal(await auth.owner(`Bearer ${second.token}`), "local-user");
  await assert.rejects(auth.devices.revoke("someone-else", second.deviceId), { status: 404 });
  assert.equal(
    (await auth.devices.list("local-user")).find((d) => d.id === second.deviceId)?.deviceLabel,
    "tablet",
  );
});

test("a refresh never undoes concurrent revocation", async (t) => {
  const { auth } = await fixture(t);
  const session = await auth.session();
  await Promise.allSettled([
    auth.devices.refresh({
      deviceId: session.deviceId,
      rotationId: "rotation-race",
      currentToken: session.refreshToken,
      nextTokenHash: hash("next"),
    }),
    auth.devices.revoke("local-user", session.deviceId),
  ]);
  await assert.rejects(auth.owner(`Bearer ${session.token}`), { code: "SESSION_REVOKED" });
});

test("signing-key publication is complete and atomic for concurrent first starts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "signing-key-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(typeof authModule.getOrCreateSigningKey, "function");
  const keys = await Promise.all(
    Array.from({ length: 20 }, () => authModule.getOrCreateSigningKey(directory)),
  );
  assert.equal(new Set(keys).size, 1);
  assert.equal(Buffer.from(keys[0], "base64").length, 32);
  assert.equal(await readFile(join(directory, "session-signing-key"), "utf8"), keys[0]);
  assert.equal((await stat(join(directory, "session-signing-key"))).mode & 0o777, 0o600);
  assert.equal(await authModule.getOrCreateSigningKey(directory), keys[0]);
});

test("device authority and rotation receipts survive closing and reopening the sole database writer", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "device-durable-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    allowedOrigins: [],
    googleRedirectUri: "http://localhost:8787/api/google/callback",
  };
  const first = await createStore({ dataDir: join(directory, "db") });
  const auth = await authModule.createAuth(first, config);
  const paired = await auth.session();
  const request = {
    deviceId: paired.deviceId,
    rotationId: "durable-rotation",
    currentToken: paired.refreshToken,
    nextTokenHash: hash("saved-successor"),
  };
  await auth.devices.refresh(request);
  await first.close();
  const reopened = await createStore({ dataDir: join(directory, "db") });
  try {
    const restored = await authModule.createAuth(reopened, config);
    const recovered = await restored.devices.refresh(request);
    assert.equal(await restored.owner(`Bearer ${recovered.token}`), "local-user");
    await restored.devices.revoke("local-user", paired.deviceId);
    await assert.rejects(restored.owner(`Bearer ${paired.token}`), { code: "SESSION_REVOKED" });
  } finally {
    await reopened.close();
  }
});
