import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { messageContentHash } from "../../../apps/server/src/conversation-inbox.ts";
import { hashMessageContent, sha256 } from "../src/message-hash.ts";
import {
  ComposerSubmission,
  composerKeyIsSubmit,
  conversationDeliveryError,
  MessageOutbox,
} from "../src/message-outbox.ts";

function storage() {
  const records = new Map<string, string>();
  let writer: Promise<unknown> = Promise.resolve();
  const disk = {
    read: async (key: string) => records.get(key) ?? null,
    write: async (key: string, value: string) => {
      records.set(key, value);
    },
    update: (key: string, change: (previous: string | null) => string) => {
      const pending = writer.then(async () => {
        const next = change(records.get(key) ?? null);
        await disk.write(key, next);
        return next;
      });
      writer = pending.catch(() => {});
      return pending;
    },
  };
  return disk;
}
test("a persisted delivery failure stays visible after ACK/reopen and clears only when its original run starts", async () => {
  const disk = storage();
  let outbox = new MessageOutbox(disk, "owner:chat", "chat");
  const failure = {
    id: "failure",
    threadId: "chat",
    seq: 1,
    runId: "original-run",
    kind: "agui" as const,
    origin: "live" as const,
    payload: {
      type: "CUSTOM",
      name: "conversation_delivery_error",
      value: { message: "Your message is saved, but the reply could not start.", retryable: true },
    },
  };
  await outbox.applyReplay({ events: [failure], nextCursor: 1, snapshotRequired: false });
  outbox = new MessageOutbox(disk, "owner:chat", "chat");
  await outbox.open();
  assert.match(conversationDeliveryError(outbox.getSnapshot().events), /could not start/);
  await outbox.applyReplay({
    events: [
      {
        id: "other-start",
        threadId: "chat",
        seq: 2,
        runId: "other-run",
        kind: "agui",
        origin: "live",
        payload: { type: "RUN_STARTED" },
      },
    ],
    nextCursor: 2,
    snapshotRequired: false,
  });
  assert.match(conversationDeliveryError(outbox.getSnapshot().events), /could not start/);
  await outbox.applyReplay({
    events: [
      {
        id: "original-start",
        threadId: "chat",
        seq: 3,
        runId: "original-run",
        kind: "agui",
        origin: "live",
        payload: { type: "RUN_STARTED" },
      },
    ],
    nextCursor: 3,
    snapshotRequired: false,
  });
  assert.equal(conversationDeliveryError(outbox.getSnapshot().events), "");
});
test("two offline messages, lost ACK and restart preserve the full queue with original IDs", async () => {
  const disk = storage();
  let outbox = new MessageOutbox(disk, "owner:chat", "chat");
  await outbox.enqueue({ id: "one", text: "First" });
  await outbox.enqueue({ id: "two", text: "Second", attachmentIds: ["file1"] });
  await assert.rejects(
    outbox.flush(async () => {
      throw new Error("ACK lost");
    }),
  );
  outbox = new MessageOutbox(disk, "owner:chat", "chat");
  await outbox.open();
  assert.deepEqual(
    outbox.getSnapshot().pending.map((item) => item.id),
    ["one", "two"],
  );
  const ids: string[] = [];
  await outbox.flush(async (message) => {
    ids.push(message.id);
    return { messageId: message.id, runId: "run", duplicate: message.id === "one" };
  });
  assert.deepEqual(ids, ["one", "two"]);
  assert.equal(outbox.getSnapshot().pending.length, 0);
});
test("failed local persistence precedes any claim of a durable send; cursor and events commit together", async () => {
  const disk = storage();
  const outbox = new MessageOutbox(disk, "owner:chat", "chat");
  await outbox.open();
  const write = disk.write;
  disk.write = async () => {
    throw new Error("Disk full");
  };
  await assert.rejects(outbox.enqueue({ id: "one", text: "First" }), /Disk full/);
  assert.equal(outbox.getSnapshot().pending.length, 0);
  assert.match(outbox.getSnapshot().error, /not saved/);
  disk.write = write;
  const event = {
    id: "card1",
    seq: 1,
    threadId: "chat",
    origin: "task" as const,
    kind: "interaction" as const,
    payload: { id: "card" },
  };
  await outbox.applyReplay({ events: [event], nextCursor: 1, snapshotRequired: false });
  await outbox.applyReplay({ events: [event], nextCursor: 1, snapshotRequired: false });
  const restored = new MessageOutbox(disk, "owner:chat", "chat");
  await restored.open();
  assert.equal(restored.getSnapshot().cursor, 1);
  assert.equal(restored.getSnapshot().events.length, 1);
});
test("mobile hash is SHA-256 compatible for Unicode, attachments, steering and annotations", () => {
  for (const text of ["", "a", "x".repeat(1000), "Ana 🐺 português", "\ud800"])
    assert.equal(sha256(text), createHash("sha256").update(text).digest("hex"));
  const body = {
    text: "  Ana 🐺 português  ",
    attachmentIds: ["file1"],
    targetTaskId: "task1",
    annotations: [
      {
        reference: { kind: "message" as const, messageId: "m1", quote: "quote" },
        comment: "my comment",
      },
    ],
  };
  assert.equal(hashMessageContent(body), messageContentHash(body));
});

test("shared-key writers merge fresh persisted queues; snapshot/tail races preserve events and device scopes stay separate", async () => {
  const disk = storage();
  // Separate adapters represent two tabs sharing the storage transaction owner.
  const one = new MessageOutbox({ ...disk }, "server\nowner\ndevice\nchat", "chat");
  const two = new MessageOutbox({ ...disk }, "server\nowner\ndevice\nchat", "chat");
  await Promise.all([one.open(), two.open()]);
  await Promise.all([
    one.enqueue({ id: "tab-one", text: "First", attachmentIds: ["file1"] }),
    two.enqueue({ id: "tab-two", text: "Second" }),
  ]);
  await one.saveDraft("Keep my unsent draft", ["file2"]);
  const older = {
    id: "event1",
    seq: 1,
    threadId: "chat",
    origin: "task" as const,
    kind: "interaction" as const,
    payload: { id: "question" },
  };
  const newer = { ...older, id: "event2", seq: 2 };
  await Promise.all([
    two.applyReplay({ events: [newer], nextCursor: 2, snapshotRequired: false }),
    one.applyReplay({ events: [older], nextCursor: 1, snapshotRequired: false }),
  ]);
  const restored = new MessageOutbox(disk, "server\nowner\ndevice\nchat", "chat");
  await restored.open();
  assert.deepEqual(
    restored.getSnapshot().pending.map((item) => item.id),
    ["tab-one", "tab-two"],
  );
  assert.equal(restored.getSnapshot().cursor, 2);
  // A stale snapshot cannot roll back the cursor or overwrite a newer card.
  assert.equal(restored.getSnapshot().events.at(-1)?.id, "event2");
  assert.deepEqual(
    restored.getSnapshot().events.map((event) => event.id),
    ["event1", "event2"],
  );
  assert.deepEqual(restored.getSnapshot().draft.attachmentIds, ["file2"]);
  const otherDevice = new MessageOutbox(disk, "server\nowner\nother-device\nchat", "chat");
  await otherDevice.open();
  assert.equal(otherDevice.getSnapshot().pending.length, 0);
});

test("composer double taps/Enter coalesce before persistence and keep later offline messages", async () => {
  const disk = storage();
  const outbox = new MessageOutbox(disk, "owner:chat", "chat");
  const submission = new ComposerSubmission();
  let ids = 0;
  const persist = async () => {
    await outbox.enqueue({ id: `message${++ids}`, text: "Same unchanged draft" });
  };
  await Promise.all([submission.submit(persist), submission.submit(persist)]);
  assert.equal(ids, 1);
  assert.equal(outbox.getSnapshot().pending.length, 1);
  assert.equal(composerKeyIsSubmit({ key: "Enter" }), true);
  assert.equal(composerKeyIsSubmit({ key: "Enter", shiftKey: true }), false);
  assert.equal(composerKeyIsSubmit({ key: "Enter", isComposing: true }), false);
  await submission.submit(async () =>
    outbox.enqueue({ id: "follow-up", text: "Independent next question" }),
  );
  assert.equal(outbox.getSnapshot().pending.length, 2);
});
