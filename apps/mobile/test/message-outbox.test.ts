import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { messageContentHash } from "../../../apps/server/src/conversation-inbox.ts";
import { acceptedMessageSchema } from "../../../packages/domain/src/runtime.ts";
import { ApiError } from "../src/api-errors.ts";
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

test("journal polling honors Retry-After across reload without duplicating or discarding the message", async (t) => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  const disk = storage();
  let outbox = new MessageOutbox(disk, "rate-limited", "chat");
  await outbox.enqueue({ id: "original-id", text: "Procure meu compromisso" });
  let calls = 0;
  const send = async (message: { id: string }) => {
    assert.equal(message.id, "original-id");
    if (++calls === 1) throw new ApiError("Too many requests", 429, "API_QUOTA_EXCEEDED", 30_000);
  };
  await assert.rejects(outbox.flush(send), /Too many requests/);
  for (let second = 1; second < 30; second++) {
    now = 100_000 + second * 1000;
    outbox.resume(true);
    await outbox.flush(send);
  }
  assert.equal(calls, 1, "polling must not spend the quota repeatedly");
  outbox = new MessageOutbox(disk, "rate-limited", "chat");
  await outbox.open();
  outbox.resume(true);
  await outbox.flush(send);
  assert.equal(calls, 1, "reloading must retain the server's retry deadline");
  now = 130_000;
  outbox.resume(true);
  await outbox.flush(send);
  assert.equal(calls, 2);
  assert.equal(outbox.getSnapshot().pending.length, 0);
});

test("maintenance waits automatically while permanent rejection and human Stop stay paused", async (t) => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  const outbox = new MessageOutbox(storage(), "maintenance", "chat");
  await outbox.enqueue({ id: "same-id", text: "Crie meu documento" });
  let calls = 0;
  const send = async () => {
    calls++;
    throw new ApiError("Maintenance", 503, "DEPLOYMENT_MAINTENANCE", 15_000);
  };
  await assert.rejects(outbox.flush(send));
  outbox.resume(true);
  await outbox.flush(send);
  assert.equal(calls, 1);
  now += 15_000;
  outbox.resume(true);
  await assert.rejects(
    outbox.flush(async () => {
      throw new ApiError("Task removed", 404);
    }),
  );
  outbox.resume(true);
  assert.equal(
    outbox.getSnapshot().paused,
    true,
    "a permanent rejection needs the person's decision",
  );
  outbox.resume();
  outbox.pause();
  outbox.resume(true);
  assert.equal(outbox.getSnapshot().paused, true, "a journal read must not undo Stop");
});
test("stream snapshots coalesce disk writes and persist only the recent display page", async () => {
  const disk = storage();
  let writes = 0;
  const original = disk.update;
  disk.update = (key, change) => {
    writes++;
    return original(key, change);
  };
  const outbox = new MessageOutbox(disk, "stream", "chat");
  await outbox.open();
  const history = Array.from({ length: 500 }, (_, i) => ({
    id: `old-${i}`,
    role: "assistant",
    content: "Saved answer",
  }));
  await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      outbox.saveMessages([...history, { id: "live", role: "assistant", content: `Chunk ${i}` }]),
    ),
  );
  assert.ok(writes <= 2, `100 stream snapshots caused ${writes} complete transcript writes`);
  const restored = new MessageOutbox(disk, "stream", "chat");
  await restored.open();
  assert.equal((restored.getSnapshot().messages.at(-1) as { content: string }).content, "Chunk 99");
  assert.equal(restored.getSnapshot().messages.length, 50);
  assert.equal((restored.getSnapshot().messages[0] as { id: string }).id, "old-451");
});
test("prior lost ACK remains uncertain after later authentication or task rejection", async (t) => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  const disk = storage();
  let outbox = new MessageOutbox(disk, "task-guidance", "chat");
  await outbox.enqueue({
    id: "direction",
    text: "Use a shorter title",
    targetTaskId: "selected-task",
  });
  await assert.rejects(() =>
    outbox.flush(async () => {
      throw new Error("ACK lost");
    }),
  );
  outbox = new MessageOutbox(disk, "task-guidance", "chat");
  await outbox.open();
  assert.equal(outbox.getSnapshot().pending[0].targetTaskId, "selected-task");
  await assert.rejects(() => outbox.remove("direction"), /accepted/i);
  now += 1000;
  outbox.resume(true);
  await assert.rejects(() =>
    outbox.flush(async () => {
      throw new ApiError("Task was removed", 404);
    }),
  );
  assert.equal(outbox.getSnapshot().pending[0].delivery, "uncertain");
  assert.equal(outbox.getSnapshot().pending[0].attempts, 2);
  await assert.rejects(() => outbox.remove("direction"), /accepted/i);
  outbox = new MessageOutbox(disk, "task-guidance", "chat");
  await outbox.open();
  await assert.rejects(
    outbox.flush(async () => {
      throw new ApiError("Expired authentication", 401);
    }),
  );
  assert.equal(outbox.getSnapshot().pending[0].delivery, "uncertain");
  await assert.rejects(() => outbox.remove("direction"), /accepted/i);
  outbox.resume();
  await outbox.flush(async (message) => ({
    messageId: message.id,
    runId: "original-run",
    duplicate: true,
  }));
  assert.equal(outbox.getSnapshot().pending.length, 0);
});
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
test("two offline messages, lost ACK and restart preserve the full queue with original IDs", async (t) => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
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
  now += 1000;
  outbox.resume(true);
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

test("staged annotations persist in the composer draft across reopen and join the accepted envelope", async () => {
  const disk = storage();
  const citation = {
    reference: { kind: "message" as const, messageId: "source-message", quote: "Check this" },
    comment: "This is the part I mean",
  };
  let outbox = new MessageOutbox(disk, "owner:chat", "chat");
  await outbox.saveDraft("Please review", [], [citation]);
  outbox = new MessageOutbox(disk, "owner:chat", "chat");
  await outbox.open();
  assert.deepEqual(outbox.getSnapshot().draft.annotations, [citation]);
  await outbox.enqueue({ id: "annotated", text: "Please review", annotations: [citation] });
  assert.deepEqual(outbox.getSnapshot().pending[0].annotations, [citation]);
  assert.deepEqual(outbox.getSnapshot().draft.annotations, [citation]);
  await outbox.enqueue({ id: "clear", text: "Send", annotations: [citation], clearDraft: true });
  assert.deepEqual(outbox.getSnapshot().draft.annotations, []);
});

test("frame marking persists only the masked frame reference, never screenshot bytes or credentials", () => {
  const body = {
    threadId: "chat",
    clientMessageId: "marked-frame",
    text: "Check this screen",
    contentHash: "a".repeat(64),
    attachmentIds: [],
    annotations: [
      {
        reference: {
          kind: "frame" as const,
          frameId: "frame-1",
          sessionGeneration: "6cbbf4e2-7646-47ad-8e7b-367bd77f0802",
          region: { x: 0.2, y: 0.1, width: 0.2, height: 0.3 },
        },
        comment: "Please inspect this masked region",
      },
    ],
  };
  const parsed = acceptedMessageSchema.parse(body);
  assert.equal(JSON.stringify(parsed).includes("PASSWORD_CANARY"), false);
  assert.equal(JSON.stringify(parsed).includes("base64"), false);
  assert.equal(JSON.stringify(parsed).includes("frame-1"), true);
  assert.throws(() =>
    acceptedMessageSchema.parse({
      ...body,
      annotations: [
        {
          ...body.annotations[0],
          reference: { ...body.annotations[0].reference, image: "PASSWORD_CANARY" },
        },
      ],
    }),
  );
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

test("a first definitive rejection can be removed without erasing another uncertain send", async () => {
  const outbox = new MessageOutbox(storage(), "first-rejection", "chat");
  await outbox.enqueue({ id: "never-accepted", text: "Guidance", targetTaskId: "selected-task" });
  await assert.rejects(
    outbox.flush(async () => {
      throw new ApiError("Task removed", 404);
    }),
  );
  assert.equal(outbox.getSnapshot().pending[0].delivery, "rejected");
  await outbox.remove("never-accepted");
  assert.equal(outbox.getSnapshot().pending.length, 0);
});

test("quotes and stickers remain renderable after ACK, a stale stream snapshot, and reopen", async () => {
  const disk = storage();
  const outbox = new MessageOutbox(disk, "social-cache", "chat");
  const replyTo = { messageId: "source", role: "assistant" as const, text: "Want to celebrate?" };
  await outbox.saveDraft("Keep typing", [], [], replyTo);
  await outbox.enqueue({
    id: "sticker-reply",
    text: "Nice!",
    stickerId: "celebrate",
    replyToMessageId: "source",
    displayReplyTo: replyTo,
  });
  assert.deepEqual(outbox.getSnapshot().messageDetails, [
    {
      messageId: "sticker-reply",
      text: "Nice!",
      stickerId: "celebrate",
      replyTo,
    },
  ]);
  await outbox.flush(async (message) => {
    assert.equal("displayReplyTo" in message, false);
    assert.equal(message.replyToMessageId, "source");
  });
  await outbox.saveMessages([{ id: "source", role: "assistant", content: "Want to celebrate?" }]);
  const restored = new MessageOutbox(disk, "social-cache", "chat");
  await restored.open();
  assert.equal(restored.getSnapshot().pending.length, 0);
  assert.equal(restored.getSnapshot().messageDetails[0].stickerId, "celebrate");
  assert.deepEqual(restored.getSnapshot().messageDetails[0].replyTo, replyTo);
  assert.equal(
    restored
      .getSnapshot()
      .messages.filter((value) => (value as { id: string }).id === "sticker-reply").length,
    1,
  );
  await restored.saveMessages([
    { id: "source", role: "assistant", content: "Want to celebrate?" },
    { id: "sticker-reply", role: "user", content: "Nice!\n[Companion sticker: celebrate]" },
  ]);
  assert.equal(
    restored
      .getSnapshot()
      .messages.filter((value) => (value as { id: string }).id === "sticker-reply").length,
    1,
  );
});

test("canonical quote metadata replaces the preview without dropping unsent local stickers", async () => {
  const outbox = new MessageOutbox(storage(), "canonical-social", "chat");
  await outbox.enqueue({ id: "local", text: "Thanks", stickerId: "thanks" });
  await outbox.saveMessageDetails([
    {
      messageId: "remote",
      text: "Reply",
      replyTo: {
        messageId: "source",
        role: "assistant",
        text: "The canonical quote",
      },
    },
  ]);
  await outbox.saveMessageDetails([
    { messageId: "local", text: "Thank you!", stickerId: "thanks" },
  ]);
  assert.equal(outbox.getSnapshot().messageDetails.length, 2);
  assert.equal(
    outbox.getSnapshot().messageDetails.find((item) => item.messageId === "local")?.text,
    "Thank you!",
  );
  assert.equal(
    outbox.getSnapshot().messageDetails.find((item) => item.messageId === "remote")?.replyTo?.text,
    "The canonical quote",
  );
  await outbox.remove("local");
  assert.equal(
    outbox.getSnapshot().messageDetails.some((item) => item.messageId === "local"),
    false,
  );
  assert.equal(
    outbox.getSnapshot().messages.some((item) => (item as { id: string }).id === "local"),
    false,
  );
});

test("old outbox records load with an empty display metadata cache", async () => {
  const disk = storage();
  await disk.write(
    "legacy",
    JSON.stringify({
      version: 1,
      pending: [],
      cursor: 0,
      events: [],
      messages: [],
      draft: { text: "Older draft", attachmentIds: [], annotations: [], revision: 1 },
    }),
  );
  const outbox = new MessageOutbox(disk, "legacy", "chat");
  await outbox.open();
  assert.deepEqual(outbox.getSnapshot().messageDetails, []);
  assert.equal(outbox.getSnapshot().draft.text, "Older draft");
});

test("removing a queued message while flush starts never sends the removed message", async () => {
  const outbox = new MessageOutbox(storage(), "remove-race", "chat");
  await outbox.enqueue({ id: "removed", text: "Do not send" });
  const sent: string[] = [];
  await Promise.all([
    outbox.remove("removed"),
    outbox.flush(async (message) => {
      sent.push(message.id);
    }),
  ]);
  assert.deepEqual(sent, []);
});

test("a stale remove after acceptance keeps the accepted message visible", async () => {
  const outbox = new MessageOutbox(storage(), "remove-after-ack", "chat");
  await outbox.enqueue({ id: "accepted", text: "Keep this" });
  await outbox.flush(async () => {});
  assert.equal(await outbox.remove("accepted"), false);
  assert.equal(outbox.getSnapshot().messages.length, 1);
});

test("sending a quoted sticker clears only its quote and preserves the unfinished text and files", async () => {
  const outbox = new MessageOutbox(storage(), "sticker-draft", "chat");
  const quote = { messageId: "source", role: "assistant" as const, text: "Hello" };
  await outbox.saveDraft("Unfinished text", ["file"], [], quote);
  await outbox.enqueue({
    id: "sticker",
    text: "Hello!",
    stickerId: "hello",
    replyToMessageId: "source",
    displayReplyTo: quote,
    clearReply: true,
  });
  assert.equal(outbox.getSnapshot().draft.replyTo, undefined);
  assert.equal(outbox.getSnapshot().draft.text, "Unfinished text");
  assert.deepEqual(outbox.getSnapshot().draft.attachmentIds, ["file"]);
});

test("accepted replay hydrates clean text and canonical quotes before transcript reconnect", async () => {
  const outbox = new MessageOutbox(storage(), "replay-details", "chat");
  const replyTo = { messageId: "source", role: "assistant" as const, text: "Canonical text" };
  await outbox.applyReplay({
    events: [
      {
        id: "accepted:remote",
        threadId: "chat",
        seq: 1,
        kind: "accepted",
        origin: "user",
        payload: { messageId: "remote", text: "Thanks!", stickerId: "thanks", replyTo },
      },
    ],
    nextCursor: 1,
    snapshotRequired: false,
  });
  assert.deepEqual(outbox.getSnapshot().messageDetails, [
    {
      messageId: "remote",
      text: "Thanks!",
      stickerId: "thanks",
      replyTo,
    },
  ]);
});

test("recent journal checkpoint skips old events, retains offline drafts and does not write on idle polls", async () => {
  const disk = storage();
  let writes = 0;
  const original = disk.update;
  disk.update = (key, change) => {
    writes++;
    return original(key, change);
  };
  const outbox = new MessageOutbox(disk, "checkpoint", "chat");
  await outbox.enqueue({ id: "offline", text: "Keep me" });
  await outbox.saveDraft("Unfinished", ["file"]);
  const events = Array.from({ length: 220 }, (_, i) => ({
    id: `event-${i}`,
    threadId: "chat",
    seq: 10000 + i,
    kind: "agui" as const,
    origin: "live" as const,
    payload: { type: "TEXT_MESSAGE_CONTENT" },
  }));
  await outbox.checkpointReplay({ events, nextCursor: 10219, snapshotRequired: false });
  await outbox.saveMessages(
    Array.from({ length: 300 }, (_, i) => ({
      id: `server-${i}`,
      role: "assistant",
      content: "Saved",
    })),
  );
  assert.equal(outbox.getSnapshot().cursor, 10219);
  assert.equal(outbox.getSnapshot().events.length, 200);
  assert.equal(outbox.getSnapshot().pending[0].id, "offline");
  assert.equal(outbox.getSnapshot().draft.text, "Unfinished");
  assert.equal(outbox.getSnapshot().messages.length, 50);
  assert.ok(outbox.getSnapshot().messages.some((m) => (m as { id: string }).id === "offline"));
  const before = writes;
  for (let i = 0; i < 20; i++) {
    await outbox.applyReplay({ events: [], nextCursor: 10219, snapshotRequired: false });
    outbox.resume();
  }
  assert.equal(writes, before, "empty polls must not rewrite the cache");
  const restored = new MessageOutbox(disk, "checkpoint", "chat");
  await restored.open();
  assert.equal(restored.getSnapshot().pending[0].id, "offline");
  assert.equal(restored.getSnapshot().messages.length, 50);
});
