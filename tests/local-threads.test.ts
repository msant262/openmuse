import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AbstractAgent, type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import { CopilotKitCore } from "@copilotkit/core";
import { lastValueFrom, Observable, of, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { LocalThreads } from "../apps/server/src/threads.ts";

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
  const a = new LocalThreads(db, 150),
    b = new LocalThreads(db, 150);
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
