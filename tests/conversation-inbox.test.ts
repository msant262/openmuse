import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConversationInbox, messageContentHash } from "../apps/server/src/conversation-inbox.ts";
import { createStore } from "../apps/server/src/db.ts";

test("ACK loss and restart keep one accepted message/run; changed payload conflicts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inbox-"));
  let db = await createStore({ dataDir: join(dir, "db") });
  const body = { threadId: "chat", clientMessageId: "m1", text: "hello", attachmentIds: [] };
  const envelope = { ...body, contentHash: messageContentHash(body) };
  try {
    let inbox = new ConversationInbox(db);
    const accepted = await inbox.acceptMessage("owner", envelope);
    await db.close();
    db = await createStore({ dataDir: join(dir, "db") });
    inbox = new ConversationInbox(db);
    const retry = await inbox.acceptMessage("owner", envelope);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.messageId, accepted.messageId);
    assert.equal(retry.runId, accepted.runId);
    assert.equal((await inbox.pending()).length, 1);
    assert.equal((await inbox.eventsAfter("owner", "chat", 0)).events.length, 1);
    await assert.rejects(
      inbox.acceptMessage("owner", {
        ...envelope,
        text: "different",
        contentHash: messageContentHash({ ...body, text: "different" }),
      }),
      { status: 409 },
    );
    assert.deepEqual((await inbox.eventsAfter("other", "chat", 0)).events, []);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("parallel admission has a monotonic gap-free cursor and terminal steering never reruns a task", async () => {
  const db = await createStore();
  const inbox = new ConversationInbox(db);
  try {
    await db.put("owner", "tasks", {
      id: "done",
      status: "succeeded",
      state: { desiredRevision: 3 },
    });
    const bodies = ["one", "two"].map((text, index) => ({
      threadId: "chat",
      clientMessageId: `m${index}`,
      text,
      attachmentIds: [],
      targetTaskId: "done",
    }));
    await Promise.all(
      bodies.map((body) =>
        inbox.acceptMessage("owner", { ...body, contentHash: messageContentHash(body) }),
      ),
    );
    const first = await inbox.eventsAfter("owner", "chat", 0);
    assert.deepEqual(
      first.events.map((event) => event.seq),
      [1, 2, 3, 4],
    );
    const mail = await db.list<{ status: string }>("owner", "task-mailbox");
    assert.equal(mail.length, 2);
    assert.ok(mail.every((receipt) => receipt.status === "completed_before_apply"));
    assert.equal((await db.get<{ status: string }>("owner", "tasks", "done"))?.status, "succeeded");
    const body = { threadId: "chat", clientMessageId: "m3", text: "next", attachmentIds: [] };
    await inbox.acceptMessage("owner", { ...body, contentHash: messageContentHash(body) });
    assert.deepEqual(
      (await inbox.eventsAfter("owner", "chat", first.nextCursor)).events.map((event) => event.seq),
      [5],
    );
  } finally {
    await db.close();
  }
});
test("a concurrent task checkpoint adding a state key survives mailbox admission CAS", async () => {
  const db = await createStore();
  try {
    await db.put("owner", "tasks", { id: "task", status: "running", state: {} });
    const mutation = db.durableMutation.bind(db);
    let interleave = true;
    db.durableMutation = async (...args) => {
      if (interleave && args[1].startsWith("message:")) {
        interleave = false;
        await db.compareAndSwap(
          "owner",
          "tasks",
          "task",
          {},
          { state: { toolReceipt: "durable" } },
        );
      }
      return mutation(...args);
    };
    const inbox = new ConversationInbox(db);
    const body = {
      threadId: "chat",
      clientMessageId: "steer",
      text: "Use the new date",
      attachmentIds: [],
      targetTaskId: "task",
    };
    await inbox.acceptMessage("owner", { ...body, contentHash: messageContentHash(body) });
    const task = await db.get<{ state: Record<string, unknown> }>("owner", "tasks", "task");
    assert.equal(task?.state.toolReceipt, "durable");
    assert.equal(task?.state.mailboxSeq, 1);
    assert.equal((await db.list("owner", "task-mailbox")).length, 1);
  } finally {
    await db.close();
  }
});
test("continuous task revision contention ends after a bounded number of attempts without accepting the message", async () => {
  const db = await createStore();
  try {
    await db.put("owner", "tasks", { id: "task", status: "running", state: {} });
    const mutation = db.durableMutation.bind(db);
    let attempts = 0;
    db.durableMutation = async (...args) => {
      if (args[1].startsWith("message:")) {
        attempts++;
        await db.compareAndSwap("owner", "tasks", "task", {}, { state: { checkpoint: attempts } });
      }
      return mutation(...args);
    };
    const inbox = new ConversationInbox(db);
    const body = {
      threadId: "chat",
      clientMessageId: "steer",
      text: "Use the new date",
      attachmentIds: [],
      targetTaskId: "task",
    };
    await assert.rejects(
      inbox.acceptMessage("owner", { ...body, contentHash: messageContentHash(body) }),
      { status: 409 },
    );
    assert.equal(attempts, 8);
    assert.equal((await inbox.pending()).length, 0);
    assert.equal((await inbox.eventsAfter("owner", "chat", 0)).events.length, 0);
  } finally {
    await db.close();
  }
});

test("ACK-loss retry confirms the original acceptance after its attachment or task has been removed", async () => {
  const db = await createStore();
  try {
    await db.put("owner", "tasks", { id: "task", status: "running", state: {} });
    let attachmentExists = true;
    const inbox = new ConversationInbox(db, async () => {
      if (!attachmentExists) throw new Error("Attachment was removed");
    });
    const body = {
      threadId: "chat",
      clientMessageId: "ack",
      text: "Check this file",
      attachmentIds: ["file"],
      targetTaskId: "task",
    };
    const accepted = await inbox.acceptMessage("owner", {
      ...body,
      contentHash: messageContentHash(body),
    });
    attachmentExists = false;
    await db.remove("owner", "tasks", "task");
    assert.deepEqual(
      await inbox.acceptMessage("owner", { ...body, contentHash: messageContentHash(body) }),
      { ...accepted, duplicate: true },
    );
    assert.equal((await db.list("owner", "task-mailbox")).length, 1);
  } finally {
    await db.close();
  }
});
