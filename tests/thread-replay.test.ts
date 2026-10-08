import assert from "node:assert/strict";
import { test } from "node:test";
import { AbstractAgent, type BaseEvent, EventType } from "@ag-ui/client";
import { lastValueFrom, of, toArray } from "rxjs";
import { ConversationInbox } from "../apps/server/src/conversation-inbox.ts";
import { createStore } from "../apps/server/src/db.ts";
import { LocalThreads } from "../apps/server/src/threads.ts";

test("reloading an active research reply restores one snapshot and streams only new tokens", async (t) => {
  const db = await createStore();
  const threads = new LocalThreads(db);
  t.after(async () => {
    await threads.close();
    await db.close();
  });
  await threads.ensure("owner", "research");
  const run = {
    id: "research-token",
    threadId: "research",
    runId: "research-run",
    createdAt: new Date().toISOString(),
    status: "running",
    state: {},
    initialState: {},
    messages: [{ id: "question", role: "user" as const, content: "Pesquise cursos de IA" }],
    inputMessages: [{ id: "question", role: "user" as const, content: "Pesquise cursos de IA" }],
    events: [
      { type: EventType.RUN_STARTED, threadId: "research", runId: "research-run" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" },
      ...Array.from({ length: 2000 }, () => ({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "answer",
        delta: "curso ",
      })),
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "search",
        toolCallName: "search_web",
        parentMessageId: "answer",
      },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "search", delta: '{"query":"AI courses"}' },
      { type: EventType.TOOL_CALL_END, toolCallId: "search" },
    ] as BaseEvent[],
  };
  await db.put("owner", "thread-runs", run);
  await db.claimThread("owner", run.threadId, run.id, 60_000);
  const client = new (class extends AbstractAgent {
    run() {
      return of();
    }
    protected connect() {
      return threads.withOwner("owner", () => threads.connect({ threadId: run.threadId }));
    }
  })({ threadId: run.threadId });
  let restored!: () => void;
  const checkpoint = new Promise<void>((resolve) => {
    restored = resolve;
  });
  const received: BaseEvent[] = [];
  client.subscribe({
    onEvent: ({ event }) => {
      received.push(event);
    },
    onMessagesSnapshotEvent: () => {
      restored();
    },
  });
  const connected = client.connectAgent();
  await checkpoint;
  // Give the first replay batch time to establish the open stream boundaries.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(client.messages.find((m) => m.id === "answer")?.content, "curso ".repeat(2000));
  const tail: BaseEvent[] = [
    {
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: "search",
      messageId: "source",
      role: "tool",
      content: '{"sources":["verified"]}',
    },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "answer", delta: "final" },
    { type: EventType.TEXT_MESSAGE_END, messageId: "answer" },
    { type: EventType.RUN_FINISHED, threadId: run.threadId, runId: run.runId },
  ];
  for (const event of tail) await db.appendRecordEvent("owner", run.id, event);
  await db.compareAndSwap(
    "owner",
    "thread-runs",
    run.id,
    { status: "running" },
    { status: "finished" },
  );
  await db.compareAndSwap(
    "owner",
    "threads",
    run.threadId,
    { runToken: run.id },
    { runToken: null, leaseUntil: null },
  );
  await connected;
  assert.equal(
    client.messages.find((m) => m.id === "answer")?.content,
    "curso ".repeat(2000) + "final",
  );
  assert.equal(client.messages.find((m) => m.id === "source")?.content, '{"sources":["verified"]}');
  assert.equal(
    received.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT).length,
    1,
    "old tokens cannot animate again on the phone",
  );
  assert.ok(received.length < 15, `received ${received.length} events instead of a checkpoint`);
});

test("connecting before the first durable start event does not start the same run twice", async (t) => {
  const db = await createStore();
  const threads = new LocalThreads(db);
  t.after(async () => {
    await threads.close();
    await db.close();
  });
  await threads.ensure("owner", "early-connect");
  const run = {
    id: "early-token",
    threadId: "early-connect",
    runId: "early-run",
    createdAt: new Date().toISOString(),
    status: "running",
    events: [] as BaseEvent[],
    messages: [],
    state: {},
  };
  await db.put("owner", "thread-runs", run);
  await db.claimThread("owner", run.threadId, run.id, 60_000);
  const client = new (class extends AbstractAgent {
    run() {
      return of();
    }
    protected connect() {
      return threads.withOwner("owner", () => threads.connect({ threadId: run.threadId }));
    }
  })({ threadId: run.threadId });
  let starts = 0;
  client.subscribe({
    onRunStartedEvent: () => {
      starts++;
      if (starts === 1)
        void (async () => {
          await db.put("owner", "thread-runs", {
            ...run,
            status: "finished",
            events: [
              { type: EventType.RUN_STARTED, threadId: run.threadId, runId: run.runId },
              { type: EventType.RUN_FINISHED, threadId: run.threadId, runId: run.runId },
            ],
          });
          await db.compareAndSwap(
            "owner",
            "threads",
            run.threadId,
            { runToken: run.id },
            { runToken: null, leaseUntil: null },
          );
        })();
    },
  });
  await assert.doesNotReject(client.connectAgent());
  assert.equal(starts, 1);
  assert.equal(client.isRunning, false);
});

for (const laterSuccess of [false, true]) {
  test(`real AG-UI client reconnects a historical failure${laterSuccess ? " followed by success" : " alone"} without an active run`, async (t) => {
    const db = await createStore();
    const threads = new LocalThreads(db);
    t.after(async () => {
      await threads.close();
      await db.close();
    });
    await threads.ensure("owner", "history");
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "history", runId: "failed" },
      { type: EventType.STATE_SNAPSHOT, snapshot: { failedAttempt: true } },
      { type: EventType.RUN_ERROR, message: "Historical failure", code: "OLD_FAILURE" },
    ];
    await db.put("owner", "thread-runs", {
      id: "failed-token",
      threadId: "history",
      runId: "failed",
      createdAt: "2026-10-01T10:00:00Z",
      status: "interrupted",
      events,
      messages: [],
      state: { failedAttempt: true },
    });
    if (laterSuccess)
      await db.put("owner", "thread-runs", {
        id: "success-token",
        threadId: "history",
        runId: "success",
        createdAt: "2026-10-01T11:00:00Z",
        status: "finished",
        events: [
          { type: EventType.RUN_STARTED, threadId: "history", runId: "success" },
          { type: EventType.STATE_SNAPSHOT, snapshot: { succeeded: true } },
          { type: EventType.RUN_FINISHED, threadId: "history", runId: "success" },
        ],
        messages: [],
        state: { succeeded: true },
      });
    const replay = await lastValueFrom(
      threads.withOwner("owner", () => threads.connect({ threadId: "history" })).pipe(toArray()),
    );
    const client = new (class extends AbstractAgent {
      run() {
        return of(...replay);
      }
      protected connect() {
        return of(...replay);
      }
    })({ threadId: "history" });
    await assert.doesNotReject(
      client.connectAgent(),
      "the actual AG-UI verifier must accept the compacted replay",
    );
    assert.equal(client.isRunning, false);
    assert.equal(replay.at(-1)?.type, EventType.RUN_FINISHED);
    assert.deepEqual(
      replay
        .filter((event) => event.type === EventType.RUN_FINISHED)
        .map((event) => (event as BaseEvent & { runId: string }).runId),
      laterSuccess ? ["failed", "success"] : ["failed"],
    );
    assert.ok(
      replay.some(
        (event) =>
          event.type === EventType.CUSTOM &&
          "name" in event &&
          event.name === "historical_run_error",
      ),
    );
    assert.deepEqual(
      (await db.get("owner", "thread-runs", "failed-token"))?.events,
      events,
      "historical diagnostics do not rewrite original failure evidence",
    );
    assert.deepEqual(client.state, laterSuccess ? { succeeded: true } : { failedAttempt: true });
  });
}

test("a current accepted run failure still reaches the real AG-UI client's error subscriber", async (t) => {
  const db = await createStore();
  const threads = new LocalThreads(db);
  t.after(async () => {
    await threads.close();
    await db.close();
  });
  const producer = new (class extends AbstractAgent {
    run(input: import("@ag-ui/client").RunAgentInput) {
      return of(
        ...([
          { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
          { type: EventType.RUN_ERROR, message: "Current failure", code: "CURRENT_FAILURE" },
        ] as BaseEvent[]),
      );
    }
  })();
  threads.configureInbox(new ConversationInbox(db), () => producer);
  const client = new (class extends AbstractAgent {
    run(input: import("@ag-ui/client").RunAgentInput) {
      return threads.withOwner("owner", () =>
        threads.run({ threadId: input.threadId, agent: producer, input }),
      );
    }
  })({
    threadId: "current-thread",
    initialMessages: [{ id: "current-message", role: "user", content: "Reply to this" }],
  });
  const errors: { message: string; code?: string }[] = [];
  client.subscribe({
    onRunErrorEvent: ({ event }) => {
      errors.push(event);
    },
  });
  await client.runAgent().catch((error: Error) => assert.match(error.message, /Current failure/));
  assert.deepEqual(
    errors.map(({ message, code }) => ({ message, code })),
    [{ message: "Current failure", code: "CURRENT_FAILURE" }],
  );
  assert.equal(client.isRunning, false);
});
