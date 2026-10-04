import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AbstractAgent, type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import { CopilotKitCore } from "@copilotkit/core";
import { lastValueFrom, Observable, of, type Subscriber, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import { BrowserAssets } from "../apps/server/src/browser-assets.ts";
import type { Config } from "../apps/server/src/config.ts";
import { ConversationInbox, messageContentHash } from "../apps/server/src/conversation-inbox.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import { browserImageMessages } from "../apps/server/src/providers/browser-images.ts";
import { LocalThreads } from "../apps/server/src/threads.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";

const input = (threadId = "rich-thread", runId = "run-1"): RunAgentInput => ({
  threadId,
  runId,
  messages: [{ id: "user-1", role: "user", content: "Make a document" }],
  state: {},
  tools: [],
  context: [],
  forwardedProps: {},
});
const collect = (events: Observable<BaseEvent>) => lastValueFrom(events.pipe(toArray()));
async function eventually(check: () => Promise<boolean>) {
  const until = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("Condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

test("failed initial run write retains accepted identity and durable failure, then healthy restart dispatches once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inbox-pre-run-fault-"));
  let db = await createStore({ dataDir: join(directory, "db") });
  let threads = new LocalThreads(db),
    inbox = new ConversationInbox(db);
  let modelRuns = 0;
  class EffectAgent extends AbstractAgent {
    run(request: RunAgentInput) {
      modelRuns++;
      return new Observable<BaseEvent>((subscriber) => {
        void db
          .insertIfAbsent("owner", "tasks", {
            id: `task:${request.runId}`,
            prompt: "Requested work",
          })
          .then(() => {
            subscriber.next({
              type: EventType.RUN_STARTED,
              threadId: request.threadId,
              runId: request.runId,
            });
            subscriber.next({
              type: EventType.RUN_FINISHED,
              threadId: request.threadId,
              runId: request.runId,
            });
            subscriber.complete();
          })
          .catch((error) => subscriber.error(error));
      });
    }
  }
  try {
    const put = db.put.bind(db);
    let rejectFirstRun = true;
    db.put = (async (owner, kind, value) => {
      if (kind === "thread-runs" && rejectFirstRun) {
        rejectFirstRun = false;
        throw new Error("Confirmed initial write failure");
      }
      return put(owner, kind, value);
    }) as Store["put"];
    threads.configureInbox(inbox, () => new EffectAgent());
    const body = {
      threadId: "chat",
      clientMessageId: "original",
      text: "Start my requested work",
      attachmentIds: [],
    };
    const envelope = { ...body, contentHash: messageContentHash(body) };
    const accepted = await inbox.acceptMessage("owner", envelope);
    await eventually(
      async () =>
        !rejectFirstRun && (await inbox.get("owner", "chat", "original"))?.status !== "dispatching",
    );
    assert.equal((await inbox.get("owner", "chat", "original"))?.status, "accepted");
    assert.equal(modelRuns, 0);
    assert.equal(
      (await db.get<{ runToken: string | null }>("owner", "threads", "chat"))?.runToken,
      null,
    );
    assert.equal((await db.list("owner", "thread-runs")).length, 0);
    const failure = (await inbox.eventsAfter("owner", "chat", 0)).events.find(
      (event) =>
        event.kind === "agui" &&
        (event.payload as { name?: string }).name === "conversation_delivery_error",
    );
    assert.ok(failure, "accepted messages expose a durable visible pre-run failure");
    assert.equal(failure.runId, accepted.runId);
    assert.equal((failure.payload as { value: { retryable: boolean } }).value.retryable, true);
    await threads.close();
    await db.close();
    db = await createStore({ dataDir: join(directory, "db") });
    inbox = new ConversationInbox(db);
    threads = new LocalThreads(db);
    threads.configureInbox(inbox, () => new EffectAgent());
    assert.deepEqual(await inbox.acceptMessage("owner", envelope), {
      ...accepted,
      duplicate: true,
    });
    await threads.initializeInbox();
    await eventually(
      async () => (await inbox.get("owner", "chat", "original"))?.status === "finished",
    );
    assert.equal(modelRuns, 1);
    assert.equal((await db.list("owner", "tasks")).length, 1);
    const runs = await db.list<{ runId: string }>("owner", "thread-runs");
    assert.equal(runs.length, 1);
    assert.equal(runs[0].runId, accepted.runId);
    await inbox.acceptMessage("owner", envelope);
    await threads.drainInbox();
    assert.equal(modelRuns, 1);
  } finally {
    await threads.close().catch(() => {});
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an uncertain initial run write with a persisted run is never automatically dispatched again", async () => {
  const db = await createStore();
  const inbox = new ConversationInbox(db),
    threads = new LocalThreads(db, 60);
  let modelRuns = 0;
  try {
    const put = db.put.bind(db);
    let rejectFirstRun = true;
    db.put = (async (owner, kind, value) => {
      const saved = await put(owner, kind, value);
      if (kind === "thread-runs" && rejectFirstRun) {
        rejectFirstRun = false;
        throw new Error("Run write committed but acknowledgement was lost");
      }
      return saved;
    }) as Store["put"];
    threads.configureInbox(
      inbox,
      () =>
        new (class extends AbstractAgent {
          run(request: RunAgentInput) {
            modelRuns++;
            return of({
              type: EventType.RUN_FINISHED,
              threadId: request.threadId,
              runId: request.runId,
            });
          }
        })(),
    );
    const body = {
      threadId: "chat",
      clientMessageId: "uncertain",
      text: "Requested work",
      attachmentIds: [],
    };
    const envelope = { ...body, contentHash: messageContentHash(body) };
    const accepted = await inbox.acceptMessage("owner", envelope);
    await eventually(
      async () => (await inbox.get("owner", "chat", "uncertain"))?.status === "interrupted",
    );
    const failure = (await inbox.eventsAfter("owner", "chat", 0)).events.find(
      (event) =>
        event.kind === "agui" &&
        (event.payload as { name?: string }).name === "conversation_delivery_error",
    );
    assert.equal((failure?.payload as { value?: { retryable: boolean } })?.value?.retryable, false);
    assert.deepEqual(await inbox.acceptMessage("owner", envelope), {
      ...accepted,
      duplicate: true,
    });
    await threads.drainInbox();
    assert.equal(modelRuns, 0);
    assert.equal((await db.list("owner", "thread-runs")).length, 1);
  } finally {
    await threads.close().catch(() => {});
    await db.close();
  }
});

test("durable inbox admits a second turn during a long reply and stopping/disconnecting chat leaves task actor running", async () => {
  const db = await createStore();
  const inbox = new ConversationInbox(db);
  const threads = new LocalThreads(db);
  let release!: () => void, taskEntered!: () => void;
  const taskGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    taskEntered = resolve;
  });
  let aborted = false;
  const worker = new TaskWorker(db, async (_owner, _task, ctx) => {
    ctx.signal.addEventListener("abort", () => {
      aborted = true;
    });
    taskEntered();
    await taskGate;
    await ctx.guard();
    return { status: "succeeded", result: "Evidence verified" };
  });
  const fixture: AgentTask = {
    id: "actor",
    title: "Long job",
    prompt: "Complete independently",
    kind: "agent",
    status: "queued",
    plan: [],
    evidence: [],
    input: {},
    state: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attempts: 0,
    artifactIds: [],
    leaseId: null,
    leaseUntil: null,
  };
  await db.put("owner", "tasks", fixture);
  const taskRun = worker.tick();
  await entered;
  const executions: string[] = [];
  class ChatAgent extends AbstractAgent {
    run(request: RunAgentInput) {
      const message = request.messages.filter((item) => item.role === "user").at(-1)!;
      executions.push(message.id);
      return new Observable<BaseEvent>((subscriber) => {
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: request.threadId,
          runId: request.runId,
        });
        if (message.id === "first") {
          const timer = setTimeout(() => subscriber.complete(), 5000);
          return () => clearTimeout(timer);
        }
        subscriber.next({
          type: EventType.RUN_FINISHED,
          threadId: request.threadId,
          runId: request.runId,
        });
        subscriber.complete();
      });
    }
  }
  threads.configureInbox(inbox, () => new ChatAgent());
  await threads.initializeInbox();
  try {
    await threads.ensure("owner", "chat");
    const first = {
      threadId: "chat",
      clientMessageId: "first",
      text: "Long reply",
      attachmentIds: [],
    };
    await inbox.acceptMessage("owner", { ...first, contentHash: messageContentHash(first) });
    await eventually(async () => executions.length === 1);
    const viewer = threads
      .withOwner("owner", () => threads.connect({ threadId: "chat" }))
      .subscribe();
    const second = {
      threadId: "chat",
      clientMessageId: "second",
      text: "New question",
      attachmentIds: [],
    };
    const accepted = await inbox.acceptMessage("owner", {
      ...second,
      contentHash: messageContentHash(second),
    });
    assert.ok(accepted.runId);
    assert.equal((await inbox.pending()).length, 2);
    viewer.unsubscribe();
    assert.equal(await threads.withOwner("owner", () => threads.stop({ threadId: "chat" })), true);
    await eventually(
      async () => (await inbox.get("owner", "chat", "second"))?.status === "finished",
    );
    assert.equal(aborted, false);
    assert.equal((await db.get<AgentTask>("owner", "tasks", "actor"))?.status, "running");
    release();
    await taskRun;
    assert.equal((await db.get<AgentTask>("owner", "tasks", "actor"))?.status, "succeeded");
    assert.deepEqual(executions, ["first", "second"]);
  } finally {
    release();
    await taskRun;
    await threads.close();
    await worker.stop();
    await db.close();
  }
});

test("server startup drains accepted messages without a phone and historical errors cannot poison the next turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inbox-runtime-restart-"));
  let db = await createStore({ dataDir: join(dir, "db") });
  let threads: LocalThreads | undefined;
  try {
    const body = {
      threadId: "chat",
      clientMessageId: "queued",
      text: "Offline message",
      attachmentIds: [],
    };
    await new ConversationInbox(db).acceptMessage("owner", {
      ...body,
      contentHash: messageContentHash(body),
    });
    await db.close();
    db = await createStore({ dataDir: join(dir, "db") });
    const inbox = new ConversationInbox(db);
    threads = new LocalThreads(db);
    let executions = 0;
    threads.configureInbox(inbox, () => {
      executions++;
      return new (class extends AbstractAgent {
        run(request: RunAgentInput) {
          return of(
            ...([
              { type: EventType.RUN_STARTED, threadId: request.threadId, runId: request.runId },
              { type: EventType.RUN_ERROR, message: "Historical failure" },
            ] as BaseEvent[]),
          );
        }
      })();
    });
    await threads.initializeInbox();
    await eventually(
      async () => (await inbox.get("owner", "chat", "queued"))?.status === "interrupted",
    );
    await inbox.acceptMessage("owner", { ...body, contentHash: messageContentHash(body) });
    assert.equal(executions, 1);
    const replay = await collect(
      threads.withOwner("owner", () => threads!.connect({ threadId: "chat" })),
    );
    assert.equal(
      replay.some((event) => event.type === EventType.RUN_ERROR),
      false,
    );
    assert.ok(
      replay.some(
        (event) =>
          event.type === EventType.CUSTOM &&
          "name" in event &&
          event.name === "historical_run_error",
      ),
    );
    const journal = await inbox.eventsAfter("owner", "chat", 0);
    assert.ok(
      journal.events.some(
        (event) =>
          event.kind === "agui" && (event.payload as BaseEvent).type === EventType.RUN_ERROR,
      ),
    );
  } finally {
    await threads?.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy run retries preserve the accepted quote and sticker binding without duplicate dispatch", async () => {
  const db = await createStore();
  const inbox = new ConversationInbox(db);
  const threads = new LocalThreads(db);
  try {
    await threads.ensure("owner", "chat");
    inbox.resolveQuote = async () => ({
      messageId: "source",
      role: "assistant",
      text: "Original message",
    });
    const body = {
      threadId: "chat",
      clientMessageId: "quoted-retry",
      text: "Agreed",
      attachmentIds: [],
      replyToMessageId: "source",
      stickerId: "agreed",
    };
    const accepted = await inbox.acceptMessage("owner", {
      ...body,
      contentHash: messageContentHash(body),
    });
    let dispatches = 0;
    threads.configureInbox(inbox, () => {
      dispatches++;
      return new RichAgent();
    });
    const request = {
      ...input("chat", accepted.runId),
      messages: [{ id: body.clientMessageId, role: "user" as const, content: body.text }],
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const events = await collect(
        threads.withOwner("owner", () =>
          threads.run({ threadId: "chat", input: request, agent: new RichAgent() }),
        ),
      );
      assert.equal(
        events.some((event) => event.type === EventType.RUN_ERROR),
        false,
      );
      assert.ok(events.some((event) => event.type === EventType.RUN_FINISHED));
    }
    assert.equal(dispatches, 1);
    const saved = await inbox.get("owner", "chat", body.clientMessageId);
    assert.equal(saved?.contentHash, messageContentHash(body));
    assert.equal(saved?.runId, accepted.runId);
    const history = await threads.history("owner", "chat");
    assert.match(String(history.messages[0]?.content), /Companion sticker: agreed/);
    assert.match(String(history.messages[0]?.content), /Original message/);
  } finally {
    await threads.close();
    await db.close();
  }
});

test("private reasoning is excluded from durable events and transcript checkpoints", async () => {
  const db = await createStore();
  const threads = new LocalThreads(db);
  try {
    const agent = new (class extends AbstractAgent {
      run(request: RunAgentInput) {
        return of(
          ...([
            { type: EventType.RUN_STARTED, threadId: request.threadId, runId: request.runId },
            { type: EventType.REASONING_START, messageId: "private" },
            { type: EventType.REASONING_MESSAGE_START, messageId: "private", role: "reasoning" },
            {
              type: EventType.REASONING_MESSAGE_CONTENT,
              messageId: "private",
              delta: "PRIVATE_REASONING_SENTINEL",
            },
            { type: EventType.REASONING_MESSAGE_END, messageId: "private" },
            { type: EventType.REASONING_END, messageId: "private" },
            { type: EventType.TEXT_MESSAGE_START, messageId: "public", role: "assistant" },
            {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: "public",
              delta: "Your result is ready",
            },
            { type: EventType.TEXT_MESSAGE_END, messageId: "public" },
            { type: EventType.RUN_FINISHED, threadId: request.threadId, runId: request.runId },
          ] as BaseEvent[]),
        );
      }
    })();
    await collect(
      threads.withOwner("owner", () =>
        threads.run({ threadId: "chat", input: input("chat"), agent }),
      ),
    );
    assert.equal(
      JSON.stringify(await threads.history("owner", "chat")).includes("PRIVATE_REASONING_SENTINEL"),
      false,
    );
    assert.equal(
      JSON.stringify(await db.threadSnapshot("owner", "chat")).includes(
        "PRIVATE_REASONING_SENTINEL",
      ),
      false,
    );
    assert.equal(
      JSON.stringify(await new ConversationInbox(db).eventsAfter("owner", "chat", 0)).includes(
        "PRIVATE_REASONING_SENTINEL",
      ),
      false,
    );
  } finally {
    await threads.close();
    await db.close();
  }
});
class RichAgent extends AbstractAgent {
  run(request: RunAgentInput) {
    return of<BaseEvent[]>(
      ...([
        { type: EventType.RUN_STARTED, threadId: request.threadId, runId: request.runId },
        { type: EventType.TEXT_MESSAGE_START, messageId: "assistant-1", role: "assistant" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "assistant-1", delta: "Prepared it" },
        { type: EventType.TEXT_MESSAGE_END, messageId: "assistant-1" },
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "call-1",
          toolCallName: "delegate_task",
          parentMessageId: "assistant-1",
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "call-1", delta: '{"kind":"document"}' },
        { type: EventType.TOOL_CALL_END, toolCallId: "call-1" },
        {
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: "call-1",
          messageId: "tool-1",
          content: '{"id":"task-1","fileId":"file-1"}',
          role: "tool",
        },
        { type: EventType.STATE_SNAPSHOT, snapshot: { document: "file-1" } },
        { type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/ready", value: true }] },
        { type: EventType.CUSTOM, name: "choices", value: { panelId: "panel-1" } },
        { type: EventType.RUN_FINISHED, threadId: request.threadId, runId: request.runId },
      ] as BaseEvent[]),
    );
  }
}

test("long streaming histories persist events without repeated snapshots and renew their lease through replay", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "openmuse-streaming-history-"));
  let db = await createStore({ dataDir: join(dir, "postgres") });
  const leaseMs = 3000;
  let threads = new LocalThreads(db, leaseMs);
  const oldMessages: RunAgentInput["messages"] = Array.from({ length: 96 }, (_, i) => ({
    id: `history-${i}`,
    role: i % 2 ? "assistant" : "user",
    content: `Earlier message ${i}: ${"history ".repeat(512)}`,
  }));
  let emit!: Subscriber<BaseEvent>;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  class StreamingAgent extends AbstractAgent {
    run(request: RunAgentInput) {
      return new Observable<BaseEvent>((subscriber) => {
        emit = subscriber;
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: request.threadId,
          runId: request.runId,
        });
        entered();
      });
    }
  }
  try {
    await threads.ensure("owner", "long-chat");
    await db.put("owner", "thread-runs", {
      id: "history",
      threadId: "long-chat",
      runId: "history",
      createdAt: "2020-01-01T00:00:00.000Z",
      status: "finished",
      events: [],
      messages: oldMessages,
      state: { earlier: true },
    });
    const compareAndSwap = db.compareAndSwap.bind(db);
    let snapshots = 0;
    db.compareAndSwap = (async (owner, kind, id, expected, patch) => {
      if (kind === "thread-runs" && ("messages" in patch || "state" in patch)) snapshots++;
      return compareAndSwap(owner, kind, id, expected, patch);
    }) as Store["compareAndSwap"];
    const renew = db.renewThread.bind(db);
    const renewals: boolean[] = [];
    db.renewThread = async (...args) => {
      const renewed = await renew(...args);
      renewals.push(renewed);
      return renewed;
    };
    let committed = 0;
    const append = db.appendRecordEvent.bind(db);
    db.appendRecordEvent = async (...args) => {
      await append(...args);
      committed++;
    };
    const agent = new StreamingAgent();
    const finished = collect(
      threads.withOwner("owner", () =>
        threads.run({ threadId: "long-chat", input: input("long-chat"), agent }),
      ),
    );
    await started;
    const lease = await db.get<{ leaseUntil: string }>("owner", "threads", "long-chat");
    assert.ok(lease);
    assert.deepEqual(agent.messages.slice(0, oldMessages.length), oldMessages);
    const deltas = Array.from({ length: 128 }, (_, i) => `chunk-${i} `);
    const args = `{"prompt":"${deltas.join("")}"}`;
    const events: BaseEvent[] = [
      { type: EventType.TEXT_MESSAGE_START, messageId: "streamed", role: "assistant" },
      ...deltas.map((delta) => ({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "streamed",
        delta,
      })),
      { type: EventType.TEXT_MESSAGE_END, messageId: "streamed" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "streamed-tool",
        toolCallName: "delegate_task",
        parentMessageId: "streamed",
      },
      ...['{"prompt":"', ...deltas, '"}'].map((delta) => ({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "streamed-tool",
        delta,
      })),
      { type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/streamed", value: true }] },
    ];
    for (const event of events) emit.next(event);
    await eventually(async () => committed === events.length + 1);
    assert.equal(snapshots, 0, "token and state events must not rewrite the full transcript");
    const live = await new LocalThreads(db).history("owner", "long-chat");
    assert.deepEqual(live.messages.slice(0, oldMessages.length), oldMessages);
    const streamed = live.messages.find((message) => message.id === "streamed");
    assert.ok(streamed?.role === "assistant");
    assert.equal(streamed.content, deltas.join(""));
    assert.equal(streamed.toolCalls?.[0]?.function.arguments, args);
    assert.deepEqual(live.state, { earlier: true, streamed: true });

    // Cross the original SQL expiry while the tool call is still open. The tail
    // below can only commit if the real database lease heartbeat kept renewing.
    await eventually(async () => Date.now() > Date.parse(lease.leaseUntil) && renewals.length >= 2);
    assert.ok(renewals.every(Boolean), "every heartbeat must retain the lease");
    emit.next({ type: EventType.TOOL_CALL_END, toolCallId: "streamed-tool" });
    emit.next({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: "streamed-tool",
      messageId: "streamed-result",
      role: "tool",
      content: '{"taskId":"independent-task"}',
    });
    emit.next({ type: EventType.RUN_FINISHED, threadId: "long-chat", runId: "run-1" });
    emit.complete();
    const delivered = await finished;
    assert.equal(delivered.at(-1)?.type, EventType.RUN_FINISHED);
    assert.equal(
      delivered.some((event) => event.type === EventType.RUN_ERROR),
      false,
    );
    assert.equal(snapshots, 1, "only the completed run stores a full transcript snapshot");
    const saved = await threads.history("owner", "long-chat");
    assert.equal(saved.messages.at(-1)?.content, '{"taskId":"independent-task"}');
    assert.equal(await db.threadLeaseActive("owner", "long-chat"), false);
    const journal = await new ConversationInbox(db).eventsAfter("owner", "long-chat", 0);
    assert.equal(journal.events.length, delivered.length);
    await threads.close();
    await db.close();
    db = await createStore({ dataDir: join(dir, "postgres") });
    threads = new LocalThreads(db);
    assert.deepEqual(await threads.history("owner", "long-chat"), saved);
    const replay = await collect(
      threads.withOwner("owner", () => threads.connect({ threadId: "long-chat" })),
    );
    const reader = new (class extends AbstractAgent {
      run() {
        return of(...replay);
      }
    })();
    await reader.runAgent(input("long-chat", "replay"));
    assert.deepEqual(reader.messages, saved.messages);
    assert.deepEqual(reader.state, saved.state);
    t.diagnostic(
      `${Buffer.byteLength(JSON.stringify(oldMessages))} history bytes; ${committed} durable events; ${snapshots} final snapshot; ${renewals.length} successful renewals`,
    );
  } finally {
    await threads.close().catch(() => {});
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Store runner durably replays rich messages, state and custom events after a database restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openmuse-local-replay-"));
  let db = await createStore({ dataDir: join(dir, "postgres") });
  try {
    let threads = new LocalThreads(db);
    const events = await collect(
      threads.withOwner("wife", () =>
        threads.run({ threadId: "rich-thread", input: input(), agent: new RichAgent() }),
      ),
    );
    assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
    const saved = await threads.history("wife", "rich-thread");
    assert.deepEqual(saved.state, { document: "file-1", ready: true });
    assert.equal(
      saved.messages.find((message) => message.role === "tool")?.content,
      '{"id":"task-1","fileId":"file-1"}',
    );
    await db.close();
    db = await createStore({ dataDir: join(dir, "postgres") });
    threads = new LocalThreads(db);
    assert.deepEqual(await threads.history("wife", "rich-thread"), saved);
    const replay = await collect(
      threads.withOwner("wife", () => threads.connect({ threadId: "rich-thread" })),
    );
    assert.ok(
      replay.some(
        (event) => event.type === EventType.CUSTOM && "name" in event && event.name === "choices",
      ),
    );
    class ReplayAgent extends AbstractAgent {
      run() {
        return of(...replay);
      }
    }
    const reader = new ReplayAgent();
    reader.setMessages([]);
    await reader.runAgent(input());
    assert.deepEqual(reader.messages, saved.messages);
    assert.deepEqual(reader.state, saved.state);
    await assert.rejects(() => threads.history("stranger", "rich-thread"), /not found/);
    assert.throws(
      () => threads.run({ threadId: "rich-thread", input: input(), agent: new RichAgent() }),
      /Sign in/,
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("simultaneous runner instances claim only one run; stopping retains partial text and permits the next turn", async () => {
  const db = await createStore();
  // This verifies mutual exclusion/stop/reuse, not lease expiration. Keep the
  // normal lease so parallel PGlite load cannot expire it between fixture events.
  const a = new LocalThreads(db),
    b = new LocalThreads(db);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  class SlowAgent extends AbstractAgent {
    run(request: RunAgentInput) {
      return new Observable<BaseEvent>((subscriber) => {
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: request.threadId,
          runId: request.runId,
        });
        subscriber.next({
          type: EventType.TEXT_MESSAGE_START,
          messageId: "partial",
          role: "assistant",
        });
        subscriber.next({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "partial",
          delta: "Partial draft",
        });
        entered();
        const timer = setTimeout(() => subscriber.complete(), 5000);
        return () => clearTimeout(timer);
      });
    }
  }
  try {
    const first = collect(
      a.withOwner("wife", () =>
        a.run({ threadId: "rich-thread", input: input(), agent: new SlowAgent() }),
      ),
    );
    await started;
    const conflict = await collect(
      b.withOwner("wife", () =>
        b.run({
          threadId: "rich-thread",
          input: input("rich-thread", "run-2"),
          agent: new RichAgent(),
        }),
      ),
    );
    assert.ok(
      conflict.some(
        (event) =>
          event.type === EventType.RUN_ERROR && "code" in event && event.code === "THREAD_BUSY",
      ),
    );
    assert.equal(
      await b.withOwner("wife", () => b.stop({ threadId: "rich-thread", runId: "stale-run" })),
      false,
    );
    assert.equal(
      await b.withOwner("wife", () => b.stop({ threadId: "rich-thread", runId: "run-1" })),
      true,
    );
    const interrupted = await first;
    assert.ok(interrupted.some((event) => event.type === EventType.TEXT_MESSAGE_END));
    assert.equal(
      (await a.history("wife", "rich-thread")).messages.find((message) => message.id === "partial")
        ?.content,
      "Partial draft",
    );
    assert.equal(await a.withOwner("wife", () => a.isRunning({ threadId: "rich-thread" })), false);
    const next = await collect(
      a.withOwner("wife", () =>
        a.run({
          threadId: "rich-thread",
          input: input("rich-thread", "run-3"),
          agent: new RichAgent(),
        }),
      ),
    );
    assert.equal(next.at(-1)?.type, EventType.RUN_FINISHED);
    assert.ok(
      (await a.history("wife", "rich-thread")).messages.some((message) => message.id === "partial"),
    );
  } finally {
    await db.close();
  }
});

test("stopping an open tool call preserves the same receipt in replay, history and next-turn context", async () => {
  const db = await createStore();
  const threads = new LocalThreads(db);
  let committed!: () => void;
  const argsCommitted = new Promise<void>((resolve) => {
    committed = resolve;
  });
  class OpenToolAgent extends AbstractAgent {
    run(request: RunAgentInput) {
      return new Observable<BaseEvent>((subscriber) => {
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: request.threadId,
          runId: request.runId,
        });
        subscriber.next({
          type: EventType.TOOL_CALL_START,
          toolCallId: "open-call",
          toolCallName: "delegate_task",
          parentMessageId: "assistant-tool",
        });
        subscriber.next({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "open-call",
          delta: '{"kind":"document"}',
        });
      });
    }
  }
  try {
    const stream = threads.withOwner("wife", () =>
      threads.run({ threadId: "open-tool", input: input("open-tool"), agent: new OpenToolAgent() }),
    );
    const watcher = stream.subscribe((event) => {
      if (event.type === EventType.TOOL_CALL_ARGS) committed();
    });
    const finished = collect(stream);
    await argsCommitted;
    assert.equal(
      await threads.withOwner("wife", () => threads.stop({ threadId: "open-tool" })),
      true,
    );
    await finished;
    watcher.unsubscribe();
    const history = await threads.history("wife", "open-tool");
    const receipt = history.messages.find(
      (message) => message.role === "tool" && message.toolCallId === "open-call",
    );
    assert.ok(receipt);
    assert.equal(JSON.parse(receipt.content as string).status, "stopped");
    const events = await collect(
      threads.withOwner("wife", () => threads.connect({ threadId: "open-tool" })),
    );
    class ReplayAgent extends AbstractAgent {
      run() {
        return of(...events);
      }
    }
    const replay = new ReplayAgent();
    replay.threadId = "open-tool";
    await replay.runAgent({ runId: "replay" });
    assert.deepEqual(replay.messages, history.messages);
    assert.deepEqual(replay.state, history.state);
    let nextMessages: RunAgentInput["messages"] = [];
    class NextAgent extends AbstractAgent {
      run(request: RunAgentInput) {
        nextMessages = request.messages;
        return of<BaseEvent[]>(
          { type: EventType.RUN_STARTED, threadId: request.threadId, runId: request.runId },
          { type: EventType.RUN_FINISHED, threadId: request.threadId, runId: request.runId },
        );
      }
    }
    await collect(
      threads.withOwner("wife", () =>
        threads.run({
          threadId: "open-tool",
          agent: new NextAgent(),
          input: {
            ...input("open-tool", "next-run"),
            messages: [{ id: "new-user", role: "user", content: "Continue" }],
          },
        }),
      ),
    );
    assert.deepEqual(
      nextMessages.find((message) => message.id === receipt.id),
      receipt,
    );
  } finally {
    await db.close();
  }
});

test("active reconnect drains the durable tail when completion follows its captured event snapshot", async (t) => {
  const db = await createStore();
  const threads = new LocalThreads(db);
  let finish!: () => void;
  let committed!: () => void;
  const partialCommitted = new Promise<void>((resolve) => {
    committed = resolve;
  });
  class ControlledAgent extends AbstractAgent {
    run(request: RunAgentInput) {
      return new Observable<BaseEvent>((subscriber) => {
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: request.threadId,
          runId: request.runId,
        });
        subscriber.next({
          type: EventType.TEXT_MESSAGE_START,
          messageId: "controlled",
          role: "assistant",
        });
        subscriber.next({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "controlled",
          delta: "Partial",
        });
        finish = () => {
          subscriber.next({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "controlled",
            delta: " final",
          });
          subscriber.next({ type: EventType.TEXT_MESSAGE_END, messageId: "controlled" });
          subscriber.next({
            type: EventType.RUN_FINISHED,
            threadId: request.threadId,
            runId: request.runId,
          });
          subscriber.complete();
        };
      });
    }
  }
  try {
    const stream = threads.withOwner("wife", () =>
      threads.run({ threadId: "tail", input: input("tail"), agent: new ControlledAgent() }),
    );
    const watcher = stream.subscribe((event) => {
      if (event.type === EventType.TEXT_MESSAGE_CONTENT) committed();
    });
    const finished = collect(stream);
    await partialCommitted;
    const original: Store["threadSnapshot"] = db.threadSnapshot.bind(db);
    let snapshotReads = 0;
    let captured!: () => void;
    let release!: () => void;
    const snapshotCaptured = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const releaseSnapshot = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.mock.method(db, "threadSnapshot", async <T>(owner: string, id: string) => {
      const snapshot = await original<T>(owner, id);
      // First read checks recovery; the second is the snapshot connect will emit.
      if (++snapshotReads === 2) {
        captured();
        await releaseSnapshot;
      }
      return snapshot;
    });
    const reconnect = collect(
      threads.withOwner("wife", () => threads.connect({ threadId: "tail" })),
    );
    await snapshotCaptured;
    finish();
    await finished; // Final events and snapshot commit; the SQL lease is released.
    release();
    const events = await reconnect;
    watcher.unsubscribe();
    assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
    assert.equal(
      events
        .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((event) => ("delta" in event ? event.delta : ""))
        .join(""),
      "Partial final",
    );
    assert.equal(events.filter((event) => event.type === EventType.TEXT_MESSAGE_END).length, 1);
    const history = await threads.history("wife", "tail");
    class ReplayAgent extends AbstractAgent {
      run() {
        return of(...events);
      }
    }
    const replay = new ReplayAgent();
    replay.threadId = "tail";
    await replay.runAgent({ runId: "replay" });
    assert.deepEqual(replay.messages, history.messages);
  } finally {
    await db.close();
  }
});

test("disk restart recovers legacy orphan runs and both sides of the atomic recovery fault boundary", async (t) => {
  for (const boundary of [
    "legacy-cleared-lease",
    "before-recovery-write",
    "after-recovery-write",
  ] as const) {
    const dir = await mkdtemp(join(tmpdir(), `openmuse-recovery-${boundary}-`));
    let db = await createStore({ dataDir: join(dir, "postgres") });
    try {
      const threads = new LocalThreads(db);
      await threads.ensure("wife", "crashed");
      await db.compareAndSwap(
        "wife",
        "threads",
        "crashed",
        {},
        { runToken: "old-token", leaseUntil: "2020-01-01T00:00:00.000Z" },
      );
      await db.put("wife", "thread-runs", {
        id: "old-token",
        threadId: "crashed",
        runId: "old-run",
        createdAt: "2020-01-01T00:00:00.000Z",
        status: "running",
        messages: [],
        state: {},
        inputMessages: [],
        initialState: {},
        events: [
          { type: EventType.RUN_STARTED, threadId: "crashed", runId: "old-run" },
          { type: EventType.TEXT_MESSAGE_START, messageId: "partial", role: "assistant" },
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "partial", delta: "Crash draft" },
          {
            type: EventType.TOOL_CALL_START,
            toolCallId: "open-call",
            toolCallName: "delegate_task",
            parentMessageId: "partial",
          },
          { type: EventType.TOOL_CALL_ARGS, toolCallId: "open-call", delta: "{}" },
        ],
      });
      if (boundary === "legacy-cleared-lease") {
        assert.equal(await db.expireThreadLease("wife", "crashed", "old-token"), true);
      } else {
        const original = db.recoverThreadRun.bind(db);
        t.mock.method(
          db,
          "recoverThreadRun",
          async (...args: Parameters<Store["recoverThreadRun"]>) => {
            if (boundary === "after-recovery-write") await original(...args);
            throw new Error("Simulated process failure at recovery write");
          },
        );
        await assert.rejects(() => threads.history("wife", "crashed"), /Simulated process failure/);
        const thread = await db.get<{ runToken: string | null }>("wife", "threads", "crashed");
        const run = await db.get<{ status: string }>("wife", "thread-runs", "old-token");
        assert.equal(run?.status, boundary === "after-recovery-write" ? "interrupted" : "running");
        assert.equal(thread?.runToken, boundary === "after-recovery-write" ? null : "old-token");
      }
      await db.close();
      db = await createStore({ dataDir: join(dir, "postgres") });
      const fresh = new LocalThreads(db);
      const history = await fresh.history("wife", "crashed");
      assert.equal(
        (await db.get<{ status: string }>("wife", "thread-runs", "old-token"))?.status,
        "interrupted",
        boundary,
      );
      assert.ok(
        history.events.some((event) => event.type === EventType.RUN_ERROR),
        boundary,
      );
      assert.ok(
        history.events.some((event) => event.type === EventType.TEXT_MESSAGE_END),
        boundary,
      );
      assert.ok(
        history.events.some((event) => event.type === EventType.TOOL_CALL_END),
        boundary,
      );
      assert.ok(
        history.messages.some(
          (message) => message.role === "tool" && message.toolCallId === "open-call",
        ),
        boundary,
      );
      assert.equal(
        history.messages.find((message) => message.id === "partial")?.content,
        "Crash draft",
        boundary,
      );
      assert.equal(
        await fresh.withOwner("wife", () => fresh.isRunning({ threadId: "crashed" })),
        false,
        boundary,
      );
      const events = await collect(
        fresh.withOwner("wife", () => fresh.connect({ threadId: "crashed" })),
      );
      class ReplayAgent extends AbstractAgent {
        run() {
          return of(...events);
        }
      }
      const replay = new ReplayAgent();
      replay.threadId = "crashed";
      await replay.runAgent({ runId: "replay" });
      assert.deepEqual(replay.messages, history.messages, boundary);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("expired run leases recover partial receipts and cannot permanently lock a conversation", async () => {
  const db = await createStore();
  const threads = new LocalThreads(db);
  try {
    await threads.ensure("wife", "interrupted");
    await db.compareAndSwap(
      "wife",
      "threads",
      "interrupted",
      {},
      { runToken: "crashed", leaseUntil: "2020-01-01T00:00:00.000Z" },
    );
    await db.put("wife", "thread-runs", {
      id: "crashed",
      threadId: "interrupted",
      runId: "run-crashed",
      status: "running",
      createdAt: "2020-01-01T00:00:00.000Z",
      messages: [],
      state: {},
      events: [
        { type: EventType.RUN_STARTED, threadId: "interrupted", runId: "run-crashed" },
        { type: EventType.TEXT_MESSAGE_START, messageId: "partial", role: "assistant" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "partial", delta: "Saved fragment" },
        {
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: "done",
          messageId: "receipt",
          content: '{"id":"task-done"}',
          role: "tool",
        },
      ],
    });
    const recovered = await threads.history("wife", "interrupted");
    assert.ok(recovered.events.some((event) => event.type === EventType.RUN_ERROR));
    assert.ok(recovered.events.some((event) => event.type === EventType.TOOL_CALL_RESULT));
    assert.equal(
      recovered.messages.find((message) => message.id === "partial")?.content,
      "Saved fragment",
    );
    await assert.rejects(
      () =>
        db.appendRecordEvent("wife", "crashed", {
          type: EventType.CUSTOM,
          name: "late",
          value: {},
        }),
      /lease expired/,
    );
    assert.equal(
      await threads.withOwner("wife", () => threads.isRunning({ threadId: "interrupted" })),
      false,
    );
    const replay = await collect(
      threads.withOwner("wife", () => threads.connect({ threadId: "interrupted" })),
    );
    assert.ok(replay.some((event) => event.type === EventType.TEXT_MESSAGE_END));
    assert.equal(
      (
        await collect(
          threads.withOwner("wife", () =>
            threads.run({
              threadId: "interrupted",
              input: input("interrupted"),
              agent: new RichAgent(),
            }),
          ),
        )
      ).at(-1)?.type,
      EventType.RUN_FINISHED,
    );
  } finally {
    await db.close();
  }
});

test("unkeyed real runtime uses only local storage, authenticated thread APIs and mobile SSE replay", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "openmuse-local-api-"));
  const db = await createStore();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: dir,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  };
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (request: RequestInfo | URL) => {
    calls.push(String(request));
    throw new Error("Network must not be used in local mode");
  });
  try {
    const { app, threads } = await createApp(db, config);
    assert.ok(threads instanceof LocalThreads);
    const session = await (
      await app.request("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).json();
    const headers = {
      Authorization: `Bearer ${session.token}`,
      "Content-Type": "application/json",
    };
    const main = await (await app.request("/api/main-thread", { headers })).json();
    assert.equal((await app.request("/api/copilotkit/threads?agentId=default")).status, 401);
    const runtimeInfo = await (await app.request("/api/copilotkit/info", { headers })).json();
    assert.deepEqual(runtimeInfo.threadEndpoints, {
      list: true,
      inspect: true,
      mutations: true,
      realtimeMetadata: false,
    });
    assert.equal(runtimeInfo.telemetryDisabled, true);
    assert.equal(runtimeInfo.intelligence, undefined);
    for (let index = 0; index < 3; index++) {
      const response = await app.request("/api/copilotkit/agent/default/run", {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...input(`side-${index}`),
          messages: [{ id: `user-${index}`, role: "user", content: "hello" }],
        }),
      });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /RUN_FINISHED/);
    }
    const page = await (
      await app.request("/api/copilotkit/threads?agentId=default&limit=2&userId=forged", {
        headers,
      })
    ).json();
    assert.equal(page.threads.length, 2);
    assert.ok(page.nextCursor);
    const rest = await (
      await app.request(
        `/api/copilotkit/threads?agentId=default&limit=2&cursor=${page.nextCursor}`,
        { headers },
      )
    ).json();
    assert.equal(rest.threads.length, 2);
    assert.equal(rest.nextCursor, null);
    assert.equal(
      (
        await app.request("/api/copilotkit/threads/side-0", {
          method: "PATCH",
          headers,
          body: JSON.stringify({ agentId: "default", name: "Family plans", userId: "forged" }),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await app.request("/api/copilotkit/threads/side-0/archive", {
          method: "POST",
          headers,
          body: '{"agentId":"default"}',
        })
      ).status,
      200,
    );
    assert.equal(
      (await (await app.request("/api/copilotkit/threads?agentId=default", { headers })).json())
        .threads.length,
      3,
    );
    assert.equal(
      (
        await app.request("/api/copilotkit/threads/side-0", {
          method: "PATCH",
          headers,
          body: '{"agentId":"default","archived":false}',
        })
      ).status,
      200,
    );
    const replay = await app.request("/api/copilotkit/agent/default/connect", {
      method: "POST",
      headers,
      body: JSON.stringify(input("side-0")),
    });
    assert.match(await replay.text(), /What would you like/);
    assert.equal(
      (
        await app.request(`/api/copilotkit/threads/${main.threadId}/archive`, {
          method: "POST",
          headers,
          body: '{"agentId":"default"}',
        })
      ).status,
      409,
    );
    // A second verified owner cannot read/rename/connect/stop another owner's thread.
    await db.put("system", "sessions", {
      id: createHash("sha256").update("other-token").digest("hex"),
      owner: "stranger",
      expiresAt: Date.now() + 60000,
    });
    const other = { ...headers, Authorization: "Bearer other-token" };
    assert.equal(
      (await app.request("/api/copilotkit/threads/side-0/messages", { headers: other })).status,
      404,
    );
    assert.equal(
      (
        await (
          await app.request("/api/copilotkit/threads?agentId=default", { headers: other })
        ).json()
      ).threads.length,
      0,
    );
    const privateReplay = await app.request("/api/copilotkit/agent/default/connect", {
      method: "POST",
      headers: other,
      body: JSON.stringify(input("side-0")),
    });
    assert.doesNotMatch(await privateReplay.text(), /What would you like/);
    const snapshot = await (await app.request("/api/workspace", { headers })).json();
    assert.equal(snapshot.runtime.threadStorage, "local");
    assert.deepEqual(calls, []);
    // The same remote Core client underlying the mobile hooks chooses local SSE replay.
    t.mock.method(globalThis, "fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(request, init);
      assert.equal(
        new URL(req.url).origin,
        config.publicUrl,
        "Client must stay on the self-hosted API",
      );
      return app.fetch(req);
    });
    // Core intentionally skips remote discovery during Node SSR.
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    t.after(() => {
      delete (globalThis as { window?: unknown }).window;
    });
    const core = new CopilotKitCore({
      runtimeUrl: `${config.publicUrl}/api/copilotkit`,
      headers,
      deferInitialConnection: true,
    });
    const ready = new Promise<void>((resolve) => {
      const subscription = core.subscribe({
        onAgentsChanged: ({ agents }): void => {
          if (agents.default) {
            subscription.unsubscribe();
            resolve();
          }
        },
      });
    });
    core.connect();
    await ready;
    const remote = core.getAgent("default");
    assert.ok(remote);
    remote.threadId = "side-0";
    await core.connectAgent({ agent: remote });
    assert.ok(
      remote.messages.some(
        (message) =>
          message.role === "assistant" &&
          typeof message.content === "string" &&
          message.content.includes("What would you like"),
      ),
    );
    const errors: string[] = [];
    const errorSubscription = core.subscribe({
      onError: ({ error }) => {
        errors.push(error.message);
      },
    });
    for (let turn = 0; turn < 2; turn++) {
      remote.addMessage({ id: `queued-${turn}`, role: "user", content: "hello" });
      await core.runAgent({ agent: remote });
      assert.equal(
        await threads.withOwner(
          "local-user",
          (): Promise<boolean> => threads.isRunning({ threadId: "side-0" }),
        ),
        false,
      );
    }
    errorSubscription.unsubscribe();
    assert.deepEqual(errors, [], "Sequential mobile sends must not race the durable thread lease");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("substantial screenshot assets remain references across 30 cumulative turns, reconnect and restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "openmuse-screenshot-scaling-"));
  let db = await createStore({ dataDir: join(dir, "postgres") });
  try {
    let threads = new LocalThreads(db);
    let assets = new BrowserAssets(db, dir);
    const bytes = Buffer.alloc(768 * 1024, 0x5a);
    bytes[0] = 0xff;
    bytes[1] = 0xd8;
    bytes[2] = 0xff;
    let latest = "";
    let at20 = 0;
    for (let turn = 0; turn < 30; turn++) {
      bytes[100] = turn;
      const asset = await assets.save("wife", bytes);
      latest = asset.id;
      const receipt = {
        browserScreenshot: true,
        screenshotId: asset.id,
        sessionId: "00000000-0000-4000-8000-000000000001",
        title: "Browser",
        url: "https://example.com/",
        mimeType: "image/jpeg",
        width: 1280,
        height: 800,
      };
      const agent = new (class extends AbstractAgent {
        run(request: RunAgentInput) {
          return of(
            ...([
              { type: EventType.RUN_STARTED, threadId: request.threadId, runId: request.runId },
              {
                type: EventType.TOOL_CALL_START,
                toolCallId: `call-${turn}`,
                toolCallName: "browser_screenshot",
                parentMessageId: `assistant-${turn}`,
              },
              { type: EventType.TOOL_CALL_ARGS, toolCallId: `call-${turn}`, delta: "{}" },
              { type: EventType.TOOL_CALL_END, toolCallId: `call-${turn}` },
              {
                type: EventType.TOOL_CALL_RESULT,
                toolCallId: `call-${turn}`,
                messageId: `tool-${turn}`,
                role: "tool",
                content: JSON.stringify(receipt),
              },
              { type: EventType.RUN_FINISHED, threadId: request.threadId, runId: request.runId },
            ] as BaseEvent[]),
          );
        }
      })();
      const request = input("screenshot-thread", `run-${turn}`);
      request.messages = [{ id: `user-${turn}`, role: "user", content: "Show the browser." }];
      await collect(
        threads.withOwner("wife", () =>
          threads.run({ threadId: request.threadId, input: request, agent }),
        ),
      );
      if (turn === 19)
        at20 = Buffer.byteLength(
          JSON.stringify(await db.threadSnapshot("wife", "screenshot-thread")),
        );
    }
    const payload = JSON.stringify(await db.threadSnapshot("wife", "screenshot-thread"));
    assert.ok(at20 < 1_000_000, String(at20));
    assert.ok(Buffer.byteLength(payload) < 1_500_000, String(Buffer.byteLength(payload)));
    assert.ok(
      !payload.includes(bytes.toString("base64")),
      "run messages/inputMessages/RUN_STARTED never inline screenshot bytes",
    );
    const folder = join(
      dir,
      "browser-screenshots",
      createHash("sha256").update("wife").digest("hex"),
    );
    const stored = await readdir(folder);
    assert.equal(stored.length, 30, "one asset file per distinct screenshot");
    assert.equal((await stat(join(folder, `${latest}.jpg`))).size, bytes.length);
    await assets.save("wife", bytes);
    assert.equal((await readdir(folder)).length, 30, "repeated captures deduplicate bytes");
    await assert.rejects(assets.image("stranger", latest), { status: 404 });
    await db.close();
    db = await createStore({ dataDir: join(dir, "postgres") });
    threads = new LocalThreads(db);
    assets = new BrowserAssets(db, dir);
    const replay = await collect(
      threads.withOwner("wife", () => threads.connect({ threadId: "screenshot-thread" })),
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(replay)) < 1_500_000,
      "reconnect events stay independent of image byte size",
    );
    const history = await threads.history("wife", "screenshot-thread");
    const messages = history.messages
      .filter((message) => message.role === "tool")
      .map((message) => ({
        role: "tool" as const,
        toolCallId: "toolCallId" in message ? message.toolCallId : undefined,
        content: String(message.content),
      }));
    let reads = 0;
    const model = await browserImageMessages(messages, async (id) => {
      reads++;
      assert.equal(id, latest);
      return assets.image("wife", id);
    });
    assert.equal(reads, 1, "only latest screenshot bytes are hydrated at model dispatch");
    const visual = model.find((message) => message.role === "user");
    assert.ok(visual && Array.isArray(visual.content));
    const image = visual.content.find((part) => part.type === "image");
    assert.ok(image && image.type === "image" && image.source.type === "data");
    assert.equal(Buffer.from(image.source.value, "base64").length, bytes.length);
    await assert.rejects(assets.image("stranger", latest), { status: 404 });
    t.diagnostic(
      `20-turn snapshot ${at20} bytes; 30-turn snapshot ${Buffer.byteLength(payload)} bytes; reconnect ${Buffer.byteLength(JSON.stringify(replay))} bytes; each source image ${bytes.length} bytes`,
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("1,000 settled turns project cumulative inputs once, preserve chronological users/state and owner scope", async (t) => {
  const db = await createStore();
  try {
    const threads = new LocalThreads(db);
    await threads.ensure("wife", "scale");
    const messages: import("@ag-ui/core").Message[] = [];
    let rawJsonBytes = 0;
    for (let i = 0; i < 1000; i++) {
      messages.push({ id: `u${i}`, role: "user", content: `History turn ${i}: ${"x".repeat(64)}` });
      const record = {
        id: `run-${i.toString().padStart(4, "0")}`,
        threadId: "scale",
        runId: `r${i}`,
        status: "finished",
        createdAt: new Date(1000 + i).toISOString(),
        messages: [...messages],
        inputMessages: [...messages],
        state: { ready: true },
        events: [
          {
            type: EventType.RUN_STARTED,
            runId: `r${i}`,
            threadId: "scale",
            input: { ...input("scale", `r${i}`), messages: [...messages] },
          },
          { type: EventType.RUN_FINISHED, runId: `r${i}`, threadId: "scale" },
        ],
      };
      rawJsonBytes += Buffer.byteLength(JSON.stringify(record));
      await db.put("wife", "thread-runs", record);
    }
    const snapshot = await db.threadSnapshot("wife", "scale");
    t.diagnostic(
      `1,000 turns: projected SQL snapshot ${Buffer.byteLength(JSON.stringify(snapshot))} bytes; cumulative raw fixture JSON ${rawJsonBytes} bytes (not physical DB size)`,
    );
    assert.ok(
      JSON.stringify(snapshot).length < 1000000,
      "SQL must not return every cumulative history/input",
    );
    const events = await collect(
      threads.withOwner("wife", () => threads.connect({ threadId: "scale" })),
    );
    class Replay extends AbstractAgent {
      run() {
        return of(...events);
      }
    }
    const reader = new Replay();
    await reader.runAgent(input("scale"));
    assert.deepEqual(reader.messages, messages);
    assert.deepEqual(reader.state, { ready: true });
    assert.equal((await db.searchThreads("wife", "History turn 0:", 20, false)).length, 1);
    assert.equal((await db.searchThreads("wife", "History turn 999:", 20, false)).length, 1);
    assert.deepEqual((await db.threadSnapshot("other", "scale")).runs, []);
  } finally {
    await db.close();
  }
});

test("background post queues behind active lease then atomically publishes once and is searchable by owner", async () => {
  const db = await createStore();
  try {
    const threads = new LocalThreads(db);
    await threads.ensure("wife", "main");
    await db.claimThread("wife", "main", "chat-active", 60000);
    assert.equal(
      await threads.appendBackground("wife", "main", "routine-result", "Your agenda is ready"),
      false,
    );
    await db.compareAndSwap(
      "wife",
      "threads",
      "main",
      { runToken: "chat-active" },
      { runToken: null, leaseUntil: null },
    );
    assert.equal(
      await threads.appendBackground("wife", "main", "routine-result", "Your agenda is ready"),
      true,
    );
    assert.equal(
      await threads.appendBackground("wife", "main", "routine-result", "Your agenda is ready"),
      true,
    );
    assert.equal((await threads.history("wife", "main")).messages.length, 1);
    const journal = await new ConversationInbox(db).eventsAfter("wife", "main", 0);
    assert.ok(journal.events.length > 0);
    assert.ok(journal.events.every((event) => event.origin === "task"));
    assert.equal(
      journal.events.filter(
        (event) =>
          event.kind === "agui" &&
          (event.payload as { type: string }).type === EventType.RUN_FINISHED,
      ).length,
      1,
    );
    assert.equal((await db.searchThreads("wife", "agenda", 20, false)).length, 1);
    assert.deepEqual(await db.searchThreads("other", "agenda", 20, false), []);
  } finally {
    await db.close();
  }
});
