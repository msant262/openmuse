import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { GoogleAuth } from "../apps/server/src/google-auth.ts";
import { createSamplePdf } from "../packages/integrations/src/pdf.ts";
import { encryptSecret } from "../packages/integrations/src/vault.ts";

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Promise was not initialized");
  };
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function oauthConfig(): Config {
  return {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: "unused",
    agentBackend: "model",
    allowedOrigins: [],
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    googleClientId: "synthetic-client",
    googleClientSecret: "synthetic-secret",
    encryptionKey: randomBytes(32).toString("base64"),
  };
}

test("Google revoked or unavailable never blocks essential/files and section reads call only their connector", async (t) => {
  const db = await createStore();
  const directory = await mkdtemp(join(tmpdir(), "connector-startup-"));
  t.after(async () => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const config = {
    ...oauthConfig(),
    dataDir: directory,
    accessKey: "synthetic-pairing-key-long-enough",
  };
  await db.put("local-user", "credentials", {
    id: "google",
    generation: "one",
    connectionId: "fixture-connection",
    secret: encryptSecret(
      JSON.stringify({
        connectionId: "fixture-connection",
        accessToken: "fixture-google-access",
        refreshToken: "fixture-google-refresh",
        expiresAt: Date.now() + 3600000,
        scopes: [],
        account: "me@example.com",
      }),
      config.encryptionKey!,
    ),
  });
  let mailCalls = 0,
    calendarCalls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input).includes("gmail.googleapis.com")) {
      mailCalls++;
      return Response.json({ error: { message: "Google access revoked" } }, { status: 401 });
    }
    if (String(input).includes("calendar")) {
      calendarCalls++;
      return new Response("gateway", { status: 502 });
    }
    throw new Error("unexpected external request");
  });
  const { app, files } = await createApp(db, config);
  const file = await files.import("local-user", "notes.pdf", await createSamplePdf(), "local");
  await db.put("local-user", "drafts", { id: "draft", subject: "Keep my work" });
  await db.put("local-user", "mail", {
    id: "cached-mail",
    threadId: "cached-thread",
    sender: "Reader",
    from: "reader@example.com",
    to: ["me@example.com"],
    subject: "Cached message",
    body: "Keep this message during an outage",
    date: "2026-10-01T10:00:00Z",
    unread: true,
    label: "Inbox",
    attachments: [],
    connectionId: "fixture-connection",
  });
  const paired = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessKey: config.accessKey }),
  });
  const token = (await paired.json()).token;
  const headers = { Authorization: `Bearer ${token}` };
  for (const section of ["essential", "files"]) {
    const response = await app.request(`/api/workspace?section=${section}`, { headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).files[0].id, file.id);
    assert.equal(mailCalls, 0);
    assert.equal(calendarCalls, 0);
  }
  const mail = await app.request("/api/workspace?section=mail", { headers });
  assert.equal(mail.status, 200);
  const snapshot = await mail.json();
  assert.equal(
    snapshot.connections.find((c: { id: string }) => c.id === "google").status,
    "disconnected",
  );
  assert.equal(snapshot.mail[0].subject, "Cached message");
  assert.equal(mailCalls, 1);
  assert.equal(calendarCalls, 0);
  const calendar = await app.request("/api/workspace?section=calendar", { headers });
  assert.equal(calendar.status, 200);
  assert.equal(mailCalls, 1);
  assert.ok(calendarCalls > 0);
  assert.equal((await app.request("/api/agent", { headers })).status, 200);
  assert.equal((await app.request("/api/drafts", { headers })).status, 200);
  assert.equal((await app.request(`/api/files/${file.id}`, { headers })).status, 200);
  assert.equal(
    (await db.get<{ subject: string }>("local-user", "drafts", "draft"))?.subject,
    "Keep my work",
  );
});

test("transient Google refresh failures keep credentials and use a connector error code", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const config = oauthConfig();
  await db.put("owner", "credentials", {
    id: "google",
    connectionId: "one",
    secret: encryptSecret(
      JSON.stringify({
        connectionId: "one",
        accessToken: "old",
        refreshToken: "refresh",
        expiresAt: 0,
        scopes: [],
        account: "me@example.com",
      }),
      config.encryptionKey!,
    ),
  });
  t.mock.method(globalThis, "fetch", async () => new Response("bad gateway", { status: 502 }));
  const auth = new GoogleAuth(db, config);
  await assert.rejects(auth.accessToken("owner"), { code: "GOOGLE_UNAVAILABLE", status: 502 });
  assert.equal((await auth.tokens("owner"))?.refreshToken, "refresh");
});

test("old refresh cannot overwrite a newly connected Google account", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const key = randomBytes(32).toString("base64");
  const config: Config = {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: "unused",
    agentBackend: "model",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    encryptionKey: key,
  };
  const a = {
    connectionId: "connection-a",
    accessToken: "old-a",
    refreshToken: "refresh-a",
    expiresAt: 0,
    scopes: [],
    account: "a@example.com",
  };
  const b = {
    ...a,
    connectionId: "connection-b",
    accessToken: "new-b",
    account: "b@example.com",
    expiresAt: Date.now() + 3600000,
  };
  await db.put("owner", "credentials", {
    id: "google",
    connectionId: a.connectionId,
    secret: encryptSecret(JSON.stringify(a), key),
  });
  let release: ((response: Response) => void) | undefined;
  let started: (() => void) | undefined;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  t.mock.method(globalThis, "fetch", () => {
    started?.();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  const auth = new GoogleAuth(db, config);
  const refresh = auth.accessToken("owner", "connection-a");
  await requested;
  await db.put("owner", "credentials", {
    id: "google",
    connectionId: b.connectionId,
    secret: encryptSecret(JSON.stringify(b), key),
  });
  release?.(Response.json({ access_token: "refreshed-a", expires_in: 3600 }));
  await assert.rejects(refresh, /account changed/i);
  assert.equal((await auth.tokens("owner"))?.account, "b@example.com");
  await assert.rejects(auth.accessToken("owner", "connection-a"), /connection changed/i);
});

test("OAuth callbacks require a known, single-use state", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const config: Config = {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: "unused",
    agentBackend: "model",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  };
  const auth = new GoogleAuth(db, config);
  await assert.rejects(auth.callback("unknown-state", "untrusted-code"), /expired/);
  await db.put("system", "oauth", {
    id: "expired",
    owner: "owner",
    verifier: "example",
    scopes: [],
    expiresAt: Date.now() - 1,
  });
  await assert.rejects(auth.callback("expired", "untrusted-code"), /expired/);
  assert.equal(await db.get("system", "oauth", "expired"), null);
});

for (const stage of ["token", "profile"]) {
  test(`disconnect invalidates an OAuth callback suspended during ${stage}`, async (t) => {
    const db = await createStore();
    t.after(() => db.close());
    const auth = new GoogleAuth(db, oauthConfig());
    const { url } = await auth.connect("callback-race", true);
    const state = new URL(url).searchParams.get("state");
    assert.ok(state);
    const started = deferred<void>();
    const release = deferred<void>();
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      const isToken = String(input).includes("/token");
      if (isToken === (stage === "token")) {
        started.resolve();
        await release.promise;
      }
      return Response.json(
        isToken
          ? { access_token: "callback-access", refresh_token: "callback-refresh", expires_in: 3600 }
          : { emailAddress: "callback@example.com" },
      );
    });
    const callback = auth.callback(state, "synthetic-code");
    await started.promise;
    await auth.disconnect("callback-race");
    release.resolve();
    await assert.rejects(callback, /disconnect|expired|changed/i);
    assert.equal(await auth.tokens("callback-race"), null);
  });
}

test("disconnect invalidates pending OAuth state before a callback contacts Google", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const auth = new GoogleAuth(db, oauthConfig());
  const { url } = await auth.connect("pending-owner", false);
  const state = new URL(url).searchParams.get("state");
  assert.ok(state);
  await auth.disconnect("pending-owner");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    calls++;
    return Response.json(
      String(input).includes("/token")
        ? { access_token: "unused", expires_in: 3600 }
        : { emailAddress: "unused@example.com" },
    );
  });
  await assert.rejects(auth.callback(state, "synthetic-code"), /disconnect|expired|changed/i);
  assert.equal(calls, 0);
});

test("a newer connect attempt invalidates an older callback already exchanging its code", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const auth = new GoogleAuth(db, oauthConfig());
  const first = new URL((await auth.connect("reconnect-owner", false)).url).searchParams.get(
    "state",
  );
  assert.ok(first);
  const started = deferred<void>();
  const release = deferred<void>();
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("/token")) {
      const old = new URLSearchParams(String(init?.body)).get("code") === "old-code";
      if (old) {
        started.resolve();
        await release.promise;
      }
      return Response.json({ access_token: old ? "old-access" : "new-access", expires_in: 3600 });
    }
    return Response.json({ emailAddress: "new@example.com" });
  });
  const oldCallback = auth.callback(first, "old-code");
  await started.promise;
  const second = new URL((await auth.connect("reconnect-owner", true)).url).searchParams.get(
    "state",
  );
  assert.ok(second);
  await auth.callback(second, "new-code");
  release.resolve();
  await assert.rejects(oldCallback, /disconnect|expired|changed/i);
  assert.equal((await auth.tokens("reconnect-owner"))?.accessToken, "new-access");
});

test("an in-flight refresh cannot restore credentials after disconnect", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const config = oauthConfig();
  assert.ok(config.encryptionKey);
  await db.put("refresh-disconnect", "credentials", {
    id: "google",
    connectionId: "old-connection",
    secret: encryptSecret(
      JSON.stringify({
        connectionId: "old-connection",
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: 0,
        scopes: [],
        account: "me@example.com",
      }),
      config.encryptionKey,
    ),
  });
  const started = deferred<void>();
  const release = deferred<void>();
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input).includes("/revoke")) return new Response(null, { status: 200 });
    started.resolve();
    await release.promise;
    return Response.json({ access_token: "refreshed", expires_in: 3600 });
  });
  const auth = new GoogleAuth(db, config);
  const refresh = auth.accessToken("refresh-disconnect");
  await started.promise;
  await auth.disconnect("refresh-disconnect");
  release.resolve();
  await assert.rejects(refresh, /disconnected/i);
  assert.equal(await auth.tokens("refresh-disconnect"), null);
});
