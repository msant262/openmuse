import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversationInbox, messageContentHash } from "../apps/server/src/conversation-inbox.ts";
import { createStore } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";
import { IntegrationService } from "../apps/server/src/integrations.ts";
import { LocalThreads } from "../apps/server/src/threads.ts";

test("deleting a chat removes its transcript and receipts, preserves files and other owners, and rejects stale sends", async (t) => {
  const db = await createStore();
  const threads = new LocalThreads(db);
  const inbox = new ConversationInbox(db);
  t.after(async () => {
    await threads.close();
    await db.close();
  });
  await threads.ensure("owner", "old-chat");
  await threads.ensure("other", "old-chat");
  const message = {
    threadId: "old-chat",
    clientMessageId: "first",
    text: "Private transcript",
    attachmentIds: [],
  };
  await inbox.acceptMessage("owner", { ...message, contentHash: messageContentHash(message) });
  await db.compareAndSwap(
    "owner",
    "conversation-inbox",
    "old-chat:first",
    {},
    { status: "finished" },
  );
  await threads.appendBackground("owner", "old-chat", "reply", "Saved reply");
  await db.put("owner", "artifacts", { id: "file", title: "Saved document" });
  await db.put("owner", "tasks", { id: "done", originThreadId: "old-chat", status: "succeeded" });
  const request = () =>
    new Request("http://local/api/copilotkit/threads/old-chat", { method: "DELETE" });
  assert.deepEqual(await (await threads.handle(request(), "owner"))!.json(), {
    deleted: true,
    threadId: "old-chat",
  });
  assert.deepEqual(await (await threads.handle(request(), "owner"))!.json(), {
    deleted: true,
    threadId: "old-chat",
  });
  assert.deepEqual(await db.list("owner", "thread-runs"), []);
  assert.deepEqual(await db.list("owner", "conversation-inbox"), []);
  assert.deepEqual(await db.list("owner", "mutation-receipts"), []);
  assert.deepEqual((await db.conversationEvents("owner", "old-chat", 0)).events, []);
  assert.deepEqual((await db.threadMessagePage("owner", "old-chat", { limit: 20 })).messages, []);
  assert.ok(await db.get("owner", "artifacts", "file"));
  assert.ok(await db.get("owner", "tasks", "done"));
  assert.equal((await threads.ensure("other", "old-chat")).id, "old-chat");
  assert.equal(await db.claimThread("owner", "old-chat", "stale", 30_000), false);
  await assert.rejects(
    threads.ensure("owner", "old-chat"),
    (error) => error instanceof AppError && error.status === 404,
  );
  await assert.rejects(
    inbox.acceptMessage("owner", { ...message, contentHash: messageContentHash(message) }),
    (error) => error instanceof AppError && error.status === 410,
  );
  assert.equal(await threads.appendBackground("owner", "old-chat", "late", "Late result"), true);
  assert.deepEqual(await db.list("owner", "thread-runs"), []);
  const listing = await threads.handle(
    new Request("http://local/api/copilotkit/threads?agentId=default&includeArchived=true"),
    "owner",
  );
  assert.deepEqual((await listing!.json()).threads, []);
});

test("main chat deletion rotates the main conversation while unfinished work blocks deletion", async (t) => {
  const db = await createStore();
  const threads = new LocalThreads(db);
  t.after(async () => {
    await threads.close();
    await db.close();
  });
  await threads.ensure("owner", "main-chat");
  await db.put("owner", "conversation-settings", {
    id: "main",
    threadId: "main-chat",
    existing: true,
  });
  assert.equal(await db.claimThread("owner", "main-chat", "active", 30_000), true);
  assert.equal((await db.deleteThread("owner", "main-chat", "new-main")).status, "busy");
  await db.compareAndSwap(
    "owner",
    "threads",
    "main-chat",
    {},
    { runToken: null, leaseUntil: null },
  );
  await db.put("owner", "tasks", {
    id: "pending",
    originThreadId: "main-chat",
    status: "waiting_input",
  });
  assert.equal((await db.deleteThread("owner", "main-chat", "new-main")).status, "busy");
  await db.compareAndSwap("owner", "tasks", "pending", {}, { status: "cancelled" });
  assert.deepEqual(await db.deleteThread("owner", "main-chat", "new-main"), {
    status: "deleted",
    mainThreadId: "new-main",
  });
  assert.equal((await db.get("owner", "conversation-settings", "main"))?.threadId, "new-main");
  assert.equal((await threads.ensure("owner", "new-main")).id, "new-main");
  assert.deepEqual(await db.deleteThread("owner", "main-chat", "ignored"), {
    status: "deleted",
    mainThreadId: "new-main",
  });
});

test("an accepted message and a deletion cannot leave hidden queued work", async (t) => {
  const db = await createStore();
  const threads = new LocalThreads(db);
  const inbox = new ConversationInbox(db);
  t.after(async () => {
    await threads.close();
    await db.close();
  });
  await threads.ensure("owner", "race");
  const value = {
    threadId: "race",
    clientMessageId: "racing",
    text: "Start work",
    attachmentIds: [],
  };
  const [deletion, acceptance] = await Promise.allSettled([
    db.deleteThread("owner", "race", "unused"),
    inbox.acceptMessage("owner", { ...value, contentHash: messageContentHash(value) }),
  ]);
  assert.equal(deletion.status, "fulfilled");
  if (deletion.status !== "fulfilled") return;
  if (deletion.value.status === "deleted") {
    assert.equal(acceptance.status, "rejected");
    assert.deepEqual(await db.list("owner", "conversation-inbox"), []);
  } else {
    assert.equal(deletion.value.status, "busy");
    assert.equal(acceptance.status, "fulfilled");
    assert.equal((await db.list("owner", "conversation-inbox")).length, 1);
  }
});

test("a secure card admitted before deletion cannot recreate the deleted conversation's records or events", async (t) => {
  const db = await createStore();
  const threads = new LocalThreads(db);
  t.after(async () => {
    await threads.close();
    await db.close();
  });
  await threads.ensure("owner", "credential-race");
  let release = () => {},
    entered = () => {};
  const blocked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = db.durableMutation.bind(db);
  t.mock.method(db, "durableMutation", async (...args: Parameters<typeof db.durableMutation>) => {
    if (args[1].startsWith("integration-request:")) {
      entered();
      await resume;
    }
    return original(...args);
  });
  const integrations = new IntegrationService(
    db,
    {
      read: async () => null,
      write: async () => 1,
      delete: async () => {},
    },
    { available: true },
  );
  const pending = integrations.request("owner", { id: "tavily", threadId: "credential-race" });
  await blocked;
  assert.equal((await db.deleteThread("owner", "credential-race", "unused")).status, "deleted");
  release();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof AppError && error.status === 409,
  );
  assert.deepEqual(await db.list("owner", "integration-requests"), []);
  assert.deepEqual(await db.list("owner", "interaction-requests"), []);
  assert.deepEqual(await db.list("owner", "mutation-receipts"), []);
  assert.deepEqual((await db.conversationEvents("owner", "credential-race", 0)).events, []);
});

test("deleting a conversation removes its choice and source caches without touching another owner or similarly named chat", async (t) => {
  const db = await createStore();
  const threads = new LocalThreads(db);
  t.after(async () => {
    await threads.close();
    await db.close();
  });
  for (const owner of ["owner", "other"]) {
    for (const threadId of ["old-chat", "old-chat-extra"]) {
      await threads.ensure(owner, threadId);
      await db.put(owner, "jev_threads", { id: threadId, currentPanelId: `panel-${threadId}` });
      await db.put(owner, "jev_panels", {
        id: `panel-${threadId}`,
        panel: { threadId, title: "Private choices" },
        candidates: [{ title: "Private option" }],
      });
      await db.put(owner, "jev_evidence", {
        id: `${threadId}:run:web:reference`,
        threadId,
        text: "Read source text",
      });
      await db.put(owner, "jev_mail_evidence", { id: `${threadId}:run` });
    }
  }
  assert.equal((await db.deleteThread("owner", "old-chat", "unused")).status, "deleted");
  for (const kind of ["jev_threads", "jev_panels", "jev_evidence", "jev_mail_evidence"]) {
    const own = await db.list("owner", kind);
    assert.equal(own.length, 1, kind);
    assert.ok(JSON.stringify(own[0]).includes("old-chat-extra"), kind);
    assert.equal((await db.list("other", kind)).length, 2, kind);
  }
});
