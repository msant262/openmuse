import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";

test("unchanged app refresh returns no payload or rebuilt workspace; new data invalidates it", async (t) => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const directory = await mkdtemp(join(tmpdir(), "okami-conditional-"));
  const db = await createStore();
  t.after(async () => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  });
  const session = await (
    await server.app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
  ).json();
  const headers = { Authorization: `Bearer ${session.token}` };
  const snapshot = t.mock.method(server.agent, "snapshot");
  const first = await server.app.request("/api/agent", { headers });
  assert.equal(first.status, 200);
  // Initial provisioning may write once; read the post-provisioning checkpoint.
  const current = await server.app.request("/api/agent", { headers });
  const etag = current.headers.get("ETag");
  assert.ok(etag);
  const calls = snapshot.mock.calls.length;
  const unchanged = await server.app.request("/api/agent", {
    headers: { ...headers, "If-None-Match": etag },
  });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), "");
  assert.equal(snapshot.mock.calls.length, calls);
  const compressedProxy = await server.app.request("/api/agent", {
    headers: { ...headers, "If-None-Match": `"other", W/${etag}` },
  });
  assert.equal(
    compressedProxy.status,
    304,
    "compressed public responses keep the same read validator",
  );
  assert.equal(snapshot.mock.calls.length, calls);
  await db.put("local-user", "notifications", {
    id: "new",
    title: "New result",
    body: "Ready",
    read: false,
    createdAt: new Date().toISOString(),
  });
  const changed = await server.app.request("/api/agent", {
    headers: { ...headers, "If-None-Match": etag },
  });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get("ETag"), etag);
  assert.ok(
    (await changed.json()).notifications.some((notice: { id: string }) => notice.id === "new"),
  );
  const cards = t.mock.method(server.agent.interactions, "list");
  const path = "/api/conversations/research/interactions";
  const initial = await server.app.request(path, { headers });
  assert.equal(initial.status, 200);
  const cardEtag = initial.headers.get("ETag");
  assert.ok(cardEtag);
  const repeat = await server.app.request(path, {
    headers: { ...headers, "If-None-Match": `W/${cardEtag}` },
  });
  assert.equal(repeat.status, 304);
  assert.equal(cards.mock.calls.length, 1);
  assert.notEqual(cardEtag, etag, "different resources cannot share a cached response");
  // Idle desktop polling and persisted model receipts cannot redraw every card.
  await db.put("local-user", "task-operations", { id: "old-receipt", taskId: "old-task" });
  await db.put("local-user", "computer-commands", { id: "screen-refresh", status: "completed" });
  await db.put("local-user", "tasks", { id: "unrelated", status: "running" });
  const stillUnchanged = await server.app.request(path, {
    headers: { ...headers, "If-None-Match": cardEtag },
  });
  assert.equal(stillUnchanged.status, 304);
  assert.equal(cards.mock.calls.length, 1);
  // A change to the waiting card's own task must invalidate it immediately.
  await db.put("local-user", "interaction-requests", {
    id: "card",
    threadId: "research",
    taskId: "related",
    status: "waiting",
  });
  const relatedVersion = await db.workspaceVersion("local-user", "interactions:research");
  await db.put("local-user", "tasks", { id: "related", status: "cancelled" });
  assert.notEqual(await db.workspaceVersion("local-user", "interactions:research"), relatedVersion);
});
