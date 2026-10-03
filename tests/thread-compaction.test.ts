import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EventType, type Message } from "@ag-ui/core";
import { ConversationInbox, messageContentHash } from "../apps/server/src/conversation-inbox.ts";
import { createStore, Store } from "../apps/server/src/db.ts";
import { ThreadCompaction } from "../apps/server/src/thread-compaction.ts";
import { LocalThreads } from "../apps/server/src/threads.ts";

test("paged HTTP transcripts include first/current running inputs and durable tool pairs without removing checkpoints", async () => {
  const db = await createStore();
  const threads = new LocalThreads(db);
  try {
    for (const previous of [false, true]) {
      const threadId = previous ? "continued" : "first";
      await threads.ensure("owner", threadId);
      const earlier: Message[] = previous
        ? [
            { id: "u1", role: "user", content: "first" },
            { id: "a1", role: "assistant", content: "first reply" },
          ]
        : [];
      if (previous) {
        await db.put("owner", "thread-runs", {
          id: "finished",
          threadId,
          runId: "finished",
          createdAt: "2026-10-02T00:00:00Z",
          status: "finished",
          messages: earlier,
          events: [],
          state: {},
        });
        await new ThreadCompaction(db).migrate("owner", threadId);
      }
      const input: Message[] = [
        ...earlier,
        { id: "u2", role: "user", content: "new accepted input" },
      ];
      await db.compareAndSwap(
        "owner",
        "threads",
        threadId,
        {},
        { runToken: threadId, leaseUntil: "2099-01-01T00:00:00Z" },
      );
      await db.put("owner", "thread-runs", {
        id: threadId,
        threadId,
        runId: threadId,
        createdAt: "2026-10-02T00:01:00Z",
        status: "running",
        messages: input,
        inputMessages: input,
        initialState: { retained: true },
        state: {},
        events: [
          { type: EventType.RUN_STARTED, threadId, runId: threadId },
          { type: EventType.TEXT_MESSAGE_START, messageId: "a2", role: "assistant" },
          {
            type: EventType.TOOL_CALL_START,
            toolCallId: "op",
            toolCallName: "write",
            parentMessageId: "a2",
          },
          { type: EventType.TOOL_CALL_ARGS, toolCallId: "op", delta: "{}" },
          { type: EventType.TOOL_CALL_END, toolCallId: "op" },
          {
            type: EventType.TOOL_CALL_RESULT,
            toolCallId: "op",
            messageId: "receipt",
            content: '{"outcomeUnknown":true,"operationId":"op"}',
            role: "tool",
          },
        ],
      });
      const page = async (query: string) =>
        await (
          await threads.handle(
            new Request(`http://local/api/copilotkit/threads/${threadId}/messages?${query}`),
            "owner",
          )
        )?.json();
      const all = await page("limit=100");
      assert.deepEqual(
        all.messages.map((m: Message) => m.id),
        [...earlier.map((m) => m.id), "u2", "a2", "receipt"],
      );
      assert.equal(all.snapshotRequired, false);
      assert.equal(all.messages.at(-1).content, '{"outcomeUnknown":true,"operationId":"op"}');
      const pages: Message[] = [];
      let cursor: string | undefined;
      do {
        const result = await page(`limit=2${cursor ? `&cursor=${cursor}` : ""}`);
        pages.push(...result.messages);
        cursor = result.nextCursor;
      } while (cursor);
      assert.deepEqual(pages, all.messages);
      assert.equal((await page("limit=1&cursor=missing")).snapshotRequired, true);
      const running = await db.get<{
        inputMessages: Message[];
        initialState: unknown;
        status: string;
      }>("owner", "thread-runs", threadId);
      assert.deepEqual(running?.inputMessages, input);
      assert.deepEqual(running?.initialState, { retained: true });
      assert.equal(running?.status, "running");
    }
  } finally {
    await db.close();
  }
});

test("paged HTTP reads recover an expired run after disk restart and retain current receipts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "okami-page-recovery-"));
  let db = await createStore({ dataDir: dir });
  try {
    await new LocalThreads(db).ensure("owner", "expired");
    await db.compareAndSwap(
      "owner",
      "threads",
      "expired",
      {},
      { runToken: "expired-run", leaseUntil: "2020-01-01T00:00:00Z" },
    );
    await db.put("owner", "thread-runs", {
      id: "expired-run",
      runId: "expired-run",
      threadId: "expired",
      createdAt: "2026-10-02T00:00:00Z",
      status: "running",
      messages: [],
      inputMessages: [{ id: "accepted", role: "user", content: "retain accepted input" }],
      initialState: {},
      state: {},
      events: [
        { type: EventType.RUN_STARTED, threadId: "expired", runId: "expired-run" },
        { type: EventType.TEXT_MESSAGE_START, messageId: "partial", role: "assistant" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "partial", delta: "Saved fragment" },
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "op",
          toolCallName: "write",
          parentMessageId: "partial",
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "op", delta: "{}" },
        { type: EventType.TOOL_CALL_END, toolCallId: "op" },
        {
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: "op",
          messageId: "receipt",
          role: "tool",
          content: '{"outcomeUnknown":true,"operationId":"op"}',
        },
      ],
    });
    await db.close();
    db = await createStore({ dataDir: dir });
    const response = await new LocalThreads(db).handle(
      new Request("http://local/api/copilotkit/threads/expired/messages?limit=100"),
      "owner",
    );
    const page = await response?.json();
    assert.deepEqual(
      page.messages.map((m: Message) => m.id),
      ["accepted", "partial", "receipt"],
    );
    assert.equal(page.messages[1].content, "Saved fragment");
    assert.equal(page.messages[2].content, '{"outcomeUnknown":true,"operationId":"op"}');
    assert.equal(
      (await db.get<{ status: string }>("owner", "thread-runs", "expired-run"))?.status,
      "interrupted",
    );
    assert.equal(
      (await db.get<{ runToken: string | null }>("owner", "threads", "expired"))?.runToken,
      null,
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomic migration removes cumulative copies, preserves rich transcript and inbox cursor after disk restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "okami-compaction-"));
  let db = await createStore({ dataDir: dir });
  try {
    const threads = new LocalThreads(db);
    await threads.ensure("owner", "chat");
    const inbox = new ConversationInbox(db);
    const accepted = {
      threadId: "chat",
      clientMessageId: "original",
      text: "I prefer português",
      attachmentIds: [],
    };
    await inbox.acceptMessage("owner", { ...accepted, contentHash: messageContentHash(accepted) });
    const beforeCursor = await inbox.eventsAfter("owner", "chat", 0);
    const messages: Message[] = [];
    for (let i = 0; i < 35; i++) {
      messages.push({ id: `u${i}`, role: "user", content: `Old message ${i} ${"x".repeat(900)}` });
      messages.push({
        id: `a${i}`,
        role: "assistant",
        content: `Reply ${i}`,
        toolCalls: [
          { id: `tool${i}`, type: "function", function: { name: "read", arguments: "{}" } },
        ],
      });
      messages.push({
        id: `r${i}`,
        role: "tool",
        toolCallId: `tool${i}`,
        content: JSON.stringify({ receipt: `effect-${i}`, data: "returned" }),
      });
      await db.put("owner", "thread-runs", {
        id: `run${i}`,
        threadId: "chat",
        runId: `run${i}`,
        createdAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
        status: "finished",
        messages: [...messages],
        inputMessages: [...messages],
        state: { count: i },
        events: [
          { type: EventType.RUN_STARTED, input: { messages: [...messages] }, runId: `run${i}` },
          { type: EventType.CUSTOM, name: "card", value: { artifactId: `artifact${i}` } },
          { type: EventType.RUN_FINISHED, runId: `run${i}` },
        ],
      });
    }
    const before = await db.threadStorageBytes("owner", "chat");
    const compaction = new ThreadCompaction(db);
    await compaction.migrate("owner", "chat");
    const after = await db.threadStorageBytes("owner", "chat");
    t.diagnostic(
      `35 rich turns: raw serialized run/transcript fixture bytes ${before} -> ${after}; not physical storage`,
    );
    assert.ok(after < before / 5, `raw serialized fixture bytes: ${before} -> ${after}`);
    await compaction.resume("owner", "chat");
    assert.equal(await db.threadStorageBytes("owner", "chat"), after);
    assert.deepEqual((await threads.history("owner", "chat")).messages, messages);
    assert.equal(
      (await threads.history("owner", "chat")).events.filter((e) => e.type === EventType.CUSTOM)
        .length,
      35,
    );
    const first = await compaction.messages("owner", "chat", { limit: 7 });
    assert.equal(first.messages.length, 7);
    assert.ok(first.nextCursor);
    assert.equal(
      (await compaction.messages("owner", "chat", { cursor: first.nextCursor, limit: 7 }))
        .messages[0].id,
      messages[7].id,
    );
    assert.equal((await db.searchThreads("owner", "Old message 0", 20, true))[0].messageId, "u0");
    await db.close();
    db = await createStore({ dataDir: dir });
    assert.deepEqual((await new LocalThreads(db).history("owner", "chat")).messages, messages);
    assert.equal(
      (await new ConversationInbox(db).eventsAfter("owner", "chat", beforeCursor.nextCursor)).events
        .length,
      0,
    );
    assert.equal(await db.threadStorageBytes("owner", "chat"), after);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQL failure partway through migration rolls back canonical rows; repaired restart resumes without loss", async () => {
  const dir = await mkdtemp(join(tmpdir(), "okami-compaction-failure-"));
  let db = await createStore({ dataDir: dir });
  try {
    await new LocalThreads(db).ensure("owner", "chat");
    const good = { id: "one", role: "user", content: "Preserve this" };
    const broken = [good, { role: "assistant", content: "legacy corrupt ID" }];
    await db.put("owner", "thread-runs", {
      id: "run",
      threadId: "chat",
      runId: "run",
      createdAt: "2026-10-02T00:00:00Z",
      status: "finished",
      messages: broken,
      events: [],
      state: {},
    });
    await assert.rejects(new ThreadCompaction(db).migrate("owner", "chat"), /null|constraint/i);
    assert.equal(db.persistenceFailed, true);
    assert.deepEqual(
      (await db.threadMessagePage("owner", "chat")).messages,
      [],
      "partial INSERT rolled back",
    );
    assert.deepEqual(
      (await db.get<{ messages: unknown[] }>("owner", "thread-runs", "run"))?.messages,
      broken,
    );
    const repaired = [good, { id: "two", role: "assistant", content: "legacy corrupt ID" }];
    await db.compareAndSwap(
      "owner",
      "thread-runs",
      "run",
      { messages: broken },
      { messages: repaired },
    );
    await db.close();
    db = await createStore({ dataDir: dir });
    await new ThreadCompaction(db).resume("owner", "chat");
    assert.deepEqual((await new LocalThreads(db).history("owner", "chat")).messages, repaired);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("compaction write failure is visible, fails persistence marker and never claims a migration", async () => {
  const db = new Store({
    query: async () => {
      throw new Error("disk full");
    },
    close: async () => {},
  });
  await assert.rejects(new ThreadCompaction(db).migrate("owner", "chat"), /disk full/);
  assert.equal(db.persistenceFailed, true);
});
