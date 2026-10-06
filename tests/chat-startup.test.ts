import assert from "node:assert/strict";
import { test } from "node:test";
import { AbstractAgent, type BaseEvent, EventType } from "@ag-ui/client";
import { lastValueFrom, of, toArray } from "rxjs";
import { createStore } from "../apps/server/src/db.ts";
import { LocalThreads } from "../apps/server/src/threads.ts";
import { CHAT_HISTORY_PAGE_SIZE } from "../packages/domain/src/conversation-window.ts";

test("cold reconnect starts at the latest page without replaying old text, and older pages remain available", async () => {
  const db = await createStore();
  const threads = new LocalThreads(db);
  try {
    await threads.ensure("owner", "long");
    const messages = Array.from({ length: 230 }, (_, i) => ({
      id: `m-${i}`,
      role: "user" as const,
      content: `Message ${i}`,
    }));
    for (let i = 0; i < 4; i++)
      await db.put("owner", "thread-runs", {
        id: `r-${i}`,
        threadId: "long",
        runId: `r-${i}`,
        createdAt: new Date(1000 + i).toISOString(),
        status: "finished",
        messages: messages.slice(0, i === 3 ? 230 : (i + 1) * 50),
        state: { saved: true },
        events: [
          { type: EventType.RUN_STARTED, threadId: "long", runId: `r-${i}` },
          { type: EventType.TEXT_MESSAGE_START, messageId: `old-${i}`, role: "assistant" },
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId: `old-${i}`, delta: "old animation" },
          { type: EventType.TEXT_MESSAGE_END, messageId: `old-${i}` },
          { type: EventType.RUN_FINISHED, threadId: "long", runId: `r-${i}` },
        ],
      });
    const events = await lastValueFrom(
      threads.withOwner("owner", () => threads.connect({ threadId: "long" })).pipe(toArray()),
    );
    assert.equal(
      events.some((e) => e.type === EventType.TEXT_MESSAGE_CONTENT),
      false,
      "settled text must appear immediately, without replay animation",
    );
    const reader = new (class extends AbstractAgent {
      run() {
        return of(...events);
      }
    })({ threadId: "long" });
    await reader.runAgent({ runId: "read" });
    assert.deepEqual(reader.messages, messages.slice(-CHAT_HISTORY_PAGE_SIZE));
    assert.deepEqual(reader.state, { saved: true });
    assert.ok(events.length < 10);
    let cursor: string | undefined;
    let all: typeof messages = [];
    do {
      const response = await threads.handle(
        new Request(
          `http://local/api/copilotkit/threads/long/messages?direction=backward&limit=50${cursor ? `&cursor=${cursor}` : ""}`,
        ),
        "owner",
      );
      const page = await response!.json();
      all = [...page.messages, ...all];
      cursor = page.previousCursor;
    } while (cursor);
    assert.deepEqual(all, messages);
    assert.deepEqual((await threads.history("owner", "long")).messages, messages);
    assert.deepEqual((await db.threadDisplaySnapshot("other", "long", 50)).run, undefined);
  } finally {
    await threads.close();
    await db.close();
  }
});

test("journal startup checkpoint reads only the tail and summary polls exclude old text and tool payloads", async () => {
  const db = await createStore();
  try {
    for (let i = 0; i < 240; i++)
      await db.appendConversationEvent("owner", {
        id: `event-${i}`,
        threadId: "journal",
        kind: "agui",
        origin: "live",
        runId: "run",
        payload: {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "message",
          delta: "x".repeat(10000),
        },
      });
    const { ConversationInbox } = await import("../apps/server/src/conversation-inbox.ts");
    const inbox = new ConversationInbox(db);
    const checkpoint = await inbox.eventsAfter("owner", "journal", 0, {
      latest: true,
      summary: true,
    });
    assert.equal(checkpoint.events.length, 200);
    assert.equal(checkpoint.events[0].seq, 41);
    assert.equal(checkpoint.nextCursor, 240);
    assert.ok(JSON.stringify(checkpoint).length < 60000);
    assert.deepEqual(checkpoint.events[0].payload, { type: EventType.TEXT_MESSAGE_CONTENT });
    assert.deepEqual(
      (await inbox.eventsAfter("owner", "journal", checkpoint.nextCursor, { summary: true }))
        .events,
      [],
    );
    const raw = await inbox.eventsAfter("owner", "journal", 0);
    assert.equal(
      (raw.events[0].payload as { delta: string }).delta.length,
      10000,
      "server evidence remains intact",
    );
    assert.deepEqual(
      (await inbox.eventsAfter("other", "journal", 0, { latest: true, summary: true })).events,
      [],
    );
  } finally {
    await db.close();
  }
});
