import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { messageContentHash } from "../apps/server/src/conversation-inbox.ts";
import type { ConversationFileResource } from "../apps/server/src/conversation-resources.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { LocalThreads } from "../apps/server/src/threads.ts";

let db: Store;
let directory: string;
let server: Awaited<ReturnType<typeof createApp>>;
let token: string;
const appConfig = {
  mode: "sample" as const,
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  agentBackend: "sample" as const,
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: ["http://localhost:8081"],
};
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const imageBytes = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=",
    "base64",
  ),
);

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-conversation-resources-"));
  db = await createStore({ dataDir: join(directory, "db") });
  server = await createApp(db, { ...appConfig, dataDir: join(directory, "app") });
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  token = (await session.json()).token;
});

after(async () => {
  await server.agent.stop();
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("chat resource library serves owner files from VPS while Lenovo is offline and marks expired sessions", async () => {
  const file = await server.files.importAttachment(
    "local-user",
    "marked.png",
    imageBytes,
    "Conversation evidence",
    "image/png",
    undefined,
  );
  await db.put("local-user", "tasks", {
    id: "resource-task",
    title: "Create the report",
    status: "running",
    originThreadId: "resource-chat",
    artifactIds: [file.id],
    state: { browserId: "browser-offline", sessionId: "browser-expired" },
  });
  const now = new Date().toISOString();
  await db.put("local-user", "browsers", {
    id: "browser-offline",
    title: "Current website",
    url: "https://example.org",
    status: "active",
    updatedAt: now,
  });
  await db.put("local-user", "browsers", {
    id: "browser-expired",
    title: "Closed login",
    url: "https://example.net",
    status: "closed",
    updatedAt: now,
  });
  await db.put("other-owner", "files", { ...file, id: "private-other-owner" });

  // A remounted app gets the conversation inventory and signed file URLs from durable VPS data.
  await server.agent.stop();
  await db.close();
  db = await createStore({ dataDir: join(directory, "db") });
  server = await createApp(db, { ...appConfig, dataDir: join(directory, "app") });

  const response = await server.app.request("/api/conversations/resource-chat/resources", {
    headers: headers(),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const library = (await response.json()) as {
    files: ConversationFileResource[];
    sessions: { state: string }[];
    frameAvailable: boolean;
  };
  assert.equal(library.files.length, 1);
  assert.equal(library.files[0].file.id, file.id);
  assert.equal(library.files[0].version, createHash("sha256").update(imageBytes).digest("hex"));
  assert.equal(library.files[0].availableOffline, true);
  assert.deepEqual(library.files[0].origins, [
    { kind: "task", taskId: "resource-task", title: "Create the report" },
  ]);
  assert.deepEqual(library.sessions.map((item) => item.state).sort(), ["expired", "offline"]);
  assert.equal(library.frameAvailable, false);

  const contentUrl = new URL(library.files[0].file.url);
  const content = await server.app.request(`${contentUrl.pathname}${contentUrl.search}`);
  assert.equal(content.status, 200);
  assert.deepEqual(new Uint8Array(await content.arrayBuffer()), imageBytes);
});

test("message citations and image marks are source-checked and delivered with task steering", async () => {
  const threadId = "annotation-chat";
  const now = new Date().toISOString();
  const threads = server.threads;
  assert.ok(threads instanceof LocalThreads);
  await threads.ensure("local-user", threadId);
  await threads.appendBackground(
    "local-user",
    threadId,
    "citation-seed",
    "Quoted source text here.",
  );
  const sourceId = `publication-${createHash("sha256")
    .update(`publication:local-user:${threadId}:citation-seed`)
    .digest("hex")}`;
  const file = await server.files.importAttachment(
    "local-user",
    "diagram.png",
    imageBytes,
    "Uploaded by you",
    "image/png",
    undefined,
  );
  const fileVersion = createHash("sha256").update(imageBytes).digest("hex");
  await db.put("local-user", "tasks", {
    id: "annotation-task",
    title: "Check diagram",
    status: "running",
    state: { desiredRevision: 0 },
  });
  const body = {
    threadId,
    clientMessageId: "annotated-message",
    text: "Please review these references",
    attachmentIds: [file.id],
    targetTaskId: "annotation-task",
    annotations: [
      {
        reference: { kind: "message" as const, messageId: sourceId, quote: "source text" },
        comment: "This sentence is the context",
      },
      {
        reference: {
          kind: "attachment" as const,
          attachmentId: file.id,
          version: fileVersion,
          region: { x: 0.1, y: 0.15, width: 0.4, height: 0.3 },
        },
        comment: "Please inspect this portion",
      },
    ],
  };
  const accepted = await server.app.request(`/api/conversations/${threadId}/messages`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ ...body, contentHash: messageContentHash(body) }),
  });
  assert.equal(accepted.status, 202, await accepted.clone().text());
  const mailbox = await db.get<{ annotations: unknown[]; threadId: string }>(
    "local-user",
    "task-mailbox",
    `directive:${threadId}:${body.clientMessageId}`,
  );
  assert.equal(mailbox?.threadId, threadId);
  assert.deepEqual(mailbox?.annotations, body.annotations);

  const changedVersion = {
    ...body,
    clientMessageId: "stale-version",
    annotations: [
      {
        ...body.annotations[1],
        reference: { ...body.annotations[1].reference, version: "previous-hash" },
      },
    ],
  };
  const stale = await server.app.request(`/api/conversations/${threadId}/messages`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ ...changedVersion, contentHash: messageContentHash(changedVersion) }),
  });
  assert.equal(stale.status, 409, await stale.clone().text());

  const wrongOwnerSource = {
    ...body,
    clientMessageId: "wrong-owner-source",
    annotations: [
      {
        reference: { kind: "message" as const, messageId: "owned-by-other-account" },
        comment: "Try to cite a foreign source",
      },
    ],
  };
  await db.put("other-owner", "thread-runs", {
    id: "foreign-run",
    threadId,
    runId: "foreign-run",
    createdAt: now,
    status: "finished",
    events: [],
    messages: [{ id: "owned-by-other-account", role: "assistant", content: "private" }],
    state: {},
  });
  const foreign = await server.app.request(`/api/conversations/${threadId}/messages`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      ...wrongOwnerSource,
      contentHash: messageContentHash(wrongOwnerSource),
    }),
  });
  assert.equal(foreign.status, 409, await foreign.clone().text());
});
