import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hashMessageContent } from "../apps/mobile/src/message-hash.ts";
import { ConversationInbox, messageContentHash } from "../apps/server/src/conversation-inbox.ts";
import { ConversationSocial } from "../apps/server/src/conversation-social.ts";
import { createStore } from "../apps/server/src/db.ts";

test("reactions keep each actor's latest choice and reject changed retries without writes", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  await db.put("owner", "threads", { id: "chat" });
  const social = new ConversationSocial(db, async () => [
    { id: "one", role: "user", content: "Que boa notícia" },
    { id: "two", role: "assistant", content: "Obrigado" },
  ]);
  const first = { requestId: "react-one", messageId: "one", emoji: "❤️" };
  await Promise.all([
    social.react("owner", "chat", "user", first),
    social.react("owner", "chat", "assistant", first),
  ]);
  assert.equal((await social.state("owner", "chat")).reactions.length, 2);
  await social.react("owner", "chat", "user", {
    ...first,
    requestId: "react-two",
    emoji: "🎉",
  });
  assert.equal((await social.react("owner", "chat", "user", first))?.emoji, "🎉");
  await assert.rejects(social.react("owner", "chat", "user", { ...first, emoji: "😂" }), {
    status: 409,
  });
  await assert.rejects(social.react("owner", "chat", "user", { ...first, messageId: "two" }), {
    status: 409,
  });
  assert.equal((await db.list("owner", "message-reactions")).length, 2);
  await assert.rejects(
    social.react("owner", "chat", "assistant", { ...first, messageId: "two" }),
    /user message/,
  );
  await social.react("owner", "chat", "user", { ...first, requestId: "remove", emoji: null });
  assert.deepEqual(
    (await social.state("owner", "chat")).reactions.map((reaction) => reaction.actor),
    ["assistant"],
  );
  assert.equal((await social.react("owner", "chat", "user", first))?.emoji, null);
  await social.react("owner", "chat", "user", {
    ...first,
    requestId: "user-reacts-to-assistant",
    messageId: "two",
    emoji: "👍",
  });
  await assert.rejects(
    social.react("owner", "chat", "user", { ...first, requestId: "invalid", emoji: "invalid" }),
  );
  await assert.rejects(social.react("owner", "chat", "user", { ...first, actor: "assistant" }));
});

test("simultaneous first reactions for the same actor commit without duplicate rows", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  await db.put("owner", "threads", { id: "chat" });
  const social = new ConversationSocial(db, async () => [
    { id: "one", role: "user", content: "Muito bom" },
  ]);
  await Promise.all(
    ["❤️", "🎉", "👍"].map((emoji, index) =>
      social.react("owner", "chat", "assistant", {
        requestId: `simultaneous-${index}`,
        messageId: "one",
        emoji,
      }),
    ),
  );
  assert.equal((await social.state("owner", "chat")).reactions.length, 1);
  assert.equal((await db.list("owner", "mutation-receipts")).length, 3);
});

test("quotes and reactions cannot access accepted messages in missing, deleted, or foreign threads", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const inbox = new ConversationInbox(db);
  const social = new ConversationSocial(db, async () => []);
  await db.put("owner", "threads", { id: "chat" });
  await db.put("owner", "threads", { id: "elsewhere" });
  await db.put("other", "threads", { id: "chat" });
  const input = { threadId: "chat", clientMessageId: "pending", text: "Fonte autenticada" };
  await inbox.acceptMessage("owner", { ...input, contentHash: messageContentHash(input) });
  assert.deepEqual(await social.quote("owner", "chat", "pending"), {
    messageId: "pending",
    role: "user",
    text: input.text,
  });
  for (const [owner, threadId] of [
    ["other", "chat"],
    ["owner", "elsewhere"],
  ]) {
    await assert.rejects(social.quote(owner, threadId, "pending"), { status: 404 });
    await assert.rejects(
      social.react(owner, threadId, "user", {
        requestId: "foreign-reaction",
        messageId: "pending",
        emoji: "❤️",
      }),
      { status: 404 },
    );
    assert.deepEqual(await social.state(owner, threadId), { reactions: [], messages: [] });
  }
  for (const deleted of [true, false]) {
    if (deleted)
      await db.compareAndSwap(
        "owner",
        "threads",
        "chat",
        {},
        { deletedAt: new Date().toISOString() },
      );
    else await db.remove("owner", "threads", "chat");
    await assert.rejects(social.quote("owner", "chat", "pending"), { status: 404 });
    await assert.rejects(social.state("owner", "chat"), { status: 404 });
    await assert.rejects(
      social.react("owner", "chat", "assistant", {
        requestId: `deleted-${deleted}`,
        messageId: "pending",
        emoji: "❤️",
      }),
      { status: 404 },
    );
  }
  assert.deepEqual(await db.list("owner", "message-reactions"), []);
});

test("reaction commits are fenced when the thread is deleted after source validation", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  await db.put("owner", "threads", { id: "chat" });
  const social = new ConversationSocial(db, async () => [
    { id: "one", role: "user", content: "Hello" },
  ]);
  const mutate = db.durableMutation.bind(db);
  t.mock.method(db, "durableMutation", async (...args: Parameters<typeof db.durableMutation>) => {
    await db.compareAndSwap(
      "owner",
      "threads",
      "chat",
      {},
      { deletedAt: new Date().toISOString() },
    );
    return mutate(...args);
  });
  await assert.rejects(
    social.react("owner", "chat", "user", { requestId: "race", messageId: "one", emoji: "❤️" }),
    { status: 404 },
  );
  assert.deepEqual(await db.list("owner", "message-reactions"), []);
  assert.deepEqual(await db.list("owner", "mutation-receipts"), []);
});

test("canonical quotes and stickers survive restart, preserve old hashes, and bind retries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-social-"));
  let db = await createStore({ dataDir: join(directory, "db") });
  try {
    await db.put("owner", "threads", { id: "chat" });
    let inbox = new ConversationInbox(db);
    let social = new ConversationSocial(db, async () => [
      { id: "source", role: "assistant", content: "Texto original verificado" },
      { id: "internal", role: "tool", content: "Internal result" },
    ]);
    inbox.resolveQuote = (...args) => social.quote(...args);
    const original = { threadId: "chat", clientMessageId: "old", text: "oi", attachmentIds: [] };
    assert.equal(messageContentHash(original), hashMessageContent(original));
    await inbox.acceptMessage("owner", { ...original, contentHash: messageContentHash(original) });
    const value = {
      threadId: "chat",
      clientMessageId: "new",
      text: "Combinado",
      replyToMessageId: "source",
      stickerId: "agreed",
    };
    const envelope = { ...value, contentHash: hashMessageContent(value) };
    const accepted = await inbox.acceptMessage("owner", envelope);
    assert.equal((await inbox.acceptMessage("owner", envelope)).runId, accepted.runId);
    const saved = await inbox.get("owner", "chat", "new");
    assert.equal(saved?.replyTo?.text, "Texto original verificado");
    assert.equal(saved?.stickerId, "agreed");
    const changed = { ...value, replyToMessageId: "old" };
    await assert.rejects(
      inbox.acceptMessage("owner", { ...changed, contentHash: messageContentHash(changed) }),
      /different content/,
    );
    await assert.rejects(
      inbox.acceptMessage("owner", {
        ...envelope,
        clientMessageId: "bad",
        stickerId: "untrusted-url",
      }),
    );
    await assert.rejects(
      inbox.acceptMessage("owner", {
        ...envelope,
        clientMessageId: "forged",
        replyTo: { messageId: "source", role: "assistant", text: "Forged quote" },
      }),
    );
    await assert.rejects(social.quote("owner", "chat", "internal"), { status: 404 });
    const reaction = { requestId: "first", messageId: "old", emoji: "❤️" };
    await social.react("owner", "chat", "assistant", reaction);
    await social.react("owner", "chat", "assistant", {
      ...reaction,
      requestId: "latest",
      emoji: "🎉",
    });
    await db.close();
    db = await createStore({ dataDir: join(directory, "db") });
    inbox = new ConversationInbox(db);
    social = new ConversationSocial(db, async () => []);
    inbox.resolveQuote = (...args) => social.quote(...args);
    assert.equal((await inbox.acceptMessage("owner", envelope)).runId, accepted.runId);
    assert.equal((await social.react("owner", "chat", "assistant", reaction))?.emoji, "🎉");
    const state = await social.state("owner", "chat");
    assert.equal(state.reactions.length, 1);
    assert.deepEqual(state.messages, [
      {
        messageId: "new",
        text: "Combinado",
        replyTo: { messageId: "source", role: "assistant", text: "Texto original verificado" },
        stickerId: "agreed",
      },
    ]);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
