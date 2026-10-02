import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AbstractAgent, type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import { defineTool } from "@copilotkit/runtime/v2";
import { lastValueFrom, Observable, toArray } from "rxjs";
import { z } from "zod";
import { ActionLog } from "../apps/server/src/action-log.ts";
import { ActionService } from "../apps/server/src/actions.ts";
import { createApp } from "../apps/server/src/app.ts";
import { createStore, Store } from "../apps/server/src/db.ts";
import { tanstackAgent } from "../apps/server/src/engine/tanstack-agent.ts";
import { LostLeaseError, TaskWorker } from "../apps/server/src/engine/worker.ts";
import { OperationDrain, RequestDrain, shutdownServer } from "../apps/server/src/shutdown.ts";
import { LocalThreads } from "../apps/server/src/threads.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import { modelFixture } from "./helpers/model.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("agent shutdown joins dispatched tool receipts after model observable cancellation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-tool-shutdown-"));
  const db = await createStore();
  const { requests } = await modelFixture(t, (index) =>
    index === 0 ? { name: "held_operation", arguments: {} } : undefined,
  );
  const app = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  });
  const entered = deferred(),
    receipt = deferred();
  const agent = tanstackAgent({
    model: "openai/fixture",
    maxSteps: 3,
    prompt: "Fixture",
    trackTool: (execute) => app.agent.toolOperations.run(execute),
    tools: [
      defineTool({
        name: "held_operation",
        description: "Fixture",
        parameters: z.object({}),
        execute: async () => {
          entered.resolve();
          await receipt.promise;
          await db.put("owner", "fixture-receipts", { id: "operation", status: "done" });
          return { done: true };
        },
      }),
    ],
  });
  const subscription = agent
    .run({
      threadId: "held-tool",
      runId: "held-run",
      state: {},
      messages: [{ id: "user", role: "user", content: "Run the fixture" }],
      tools: [],
      context: [],
      forwardedProps: {},
    })
    .subscribe();
  try {
    await entered.promise;
    agent.abortRun();
    subscription.unsubscribe();
    let closed = false;
    const closing = app.agent.stop().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(closed, false);
    receipt.resolve();
    await closing;
    assert.equal((await db.get("owner", "fixture-receipts", "operation"))?.status, "done");
    assert.equal(requests.length, 1);
    await assert.rejects(
      app.agent.toolOperations.run(async () => "new"),
      /shutting down/,
    );
  } finally {
    receipt.resolve();
    subscription.unsubscribe();
    await app.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP shutdown seals requests, joins disconnected native work and closes DB last", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const requests = new RequestDrain();
  const work = deferred(),
    rest = deferred();
  const order: string[] = [];
  const response = requests.fetch(async () => {
    await rest.promise;
    order.push("receipt");
    return new Response("done");
  }, new Request("http://local.invalid"));
  const closing = shutdownServer(
    server,
    requests,
    async () => {
      await work.promise;
      order.push("worker");
    },
    async () => {
      order.push("database");
    },
  );
  assert.equal(
    (
      await requests.fetch(() => {
        throw Error("must not dispatch");
      }, new Request("http://local.invalid"))
    ).status,
    503,
  );
  work.resolve();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, ["worker"]);
  rest.resolve();
  await Promise.all([closing, response]);
  assert.deepEqual(order, ["worker", "receipt", "database"]);
});

test("unconfirmed work drain never closes the database", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let closed = false;
  await assert.rejects(
    shutdownServer(
      server,
      new RequestDrain(),
      async () => {
        throw Error("unconfirmed");
      },
      async () => {
        closed = true;
      },
    ),
  );
  assert.equal(closed, false);
});

test("failed in-flight tool receipt makes the operation drain fail", async () => {
  const drain = new OperationDrain();
  const receipt = deferred();
  const operation = drain.run(async () => {
    await receipt.promise;
    throw Error("receipt persistence failed");
  });
  const failedOperation = assert.rejects(operation, /receipt persistence failed/);
  const failedClose = assert.rejects(drain.close(), /could not confirm/);
  receipt.resolve();
  await Promise.all([failedOperation, failedClose]);
});

test("failed tool receipt settled before shutdown remains unconfirmed", async () => {
  const drain = new OperationDrain();
  await assert.rejects(
    drain.run(async () => {
      throw Error("receipt persistence failed");
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(drain.close(), /could not confirm/);
});

test("tool drain detects a swallowed audit write failure before shutdown", async (t) => {
  const errors: { context: { phase: string }; error: string }[] = [];
  t.mock.method(console, "error", (entry: (typeof errors)[number]) => errors.push(entry));
  const db = new Store({
    query: async (sql) => {
      if (sql.startsWith("INSERT INTO records")) throw Error("receipt persistence failed");
      return { rows: [] };
    },
    close: async () => {},
  });
  const drain = new OperationDrain(() => db.persistenceFailed);
  const log = new ActionLog(db);
  await assert.rejects(
    drain.run(() =>
      log.run(
        "owner",
        {
          tool: "fixture",
          target: "fixture",
          summary: "fixture",
        },
        async () => {
          throw Error("provider rejected the request");
        },
      ),
    ),
    /provider rejected/,
  );
  await assert.rejects(drain.close(), /could not confirm/);
  assert.deepEqual(
    errors.map((entry) => entry.context.phase),
    ["external action audit completion"],
  );
  assert.equal(errors[0].error, "Error");
});

test("fully recorded ordinary tool error does not prevent clean shutdown", async () => {
  const writes: string[] = [];
  const db = new Store({
    query: async (sql) => {
      writes.push(sql);
      return { rows: [] };
    },
    close: async () => {},
  });
  const drain = new OperationDrain(() => db.persistenceFailed);
  const receipt = deferred(),
    entered = deferred();
  const operation = drain.run(() =>
    new ActionLog(db).run(
      "owner",
      {
        tool: "fixture",
        target: "fixture",
        summary: "fixture",
      },
      async () => {
        entered.resolve();
        await receipt.promise;
        throw Error("provider rejected the request");
      },
    ),
  );
  const failed = assert.rejects(operation, /provider rejected/);
  await entered.promise;
  const closing = drain.close();
  receipt.resolve();
  await Promise.all([failed, closing]);
  assert(writes.some((sql) => sql.startsWith("INSERT INTO records")));
  assert(writes.filter((sql) => sql.startsWith("INSERT INTO external_action_log")).length === 2);
});

async function workerTask(db: Store) {
  const now = new Date().toISOString();
  return db.put("owner", "tasks", {
    id: "shutdown-task",
    title: "Fixture",
    prompt: "Fixture",
    kind: "agent",
    status: "queued",
    plan: [],
    evidence: [],
    input: {},
    state: {},
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    artifactIds: [],
    leaseId: null,
    leaseUntil: null,
  } satisfies AgentTask);
}

test("timer-owned aborted task with failed final receipt rejects HTTP shutdown", async (t) => {
  const errors: { context: { phase: string }; error: string }[] = [];
  t.mock.method(console, "error", (entry: (typeof errors)[number]) => errors.push(entry));
  const db = await createStore();
  await workerTask(db);
  const compare = db.compareAndSwap.bind(db);
  const compareTask = db.compareAndSwapTask.bind(db);
  let attempted = false,
    closed = false;
  db.compareAndSwap = async (owner, kind, id, expected, patch) => {
    if (kind === "tasks" && patch.status === "queued") {
      attempted = true;
      throw Error("final task receipt failed");
    }
    return compare(owner, kind, id, expected, patch);
  };
  db.compareAndSwapTask = async (owner, id, expected, patch) => {
    if (patch.status === "queued") {
      attempted = true;
      throw Error("final task receipt failed");
    }
    return compareTask(owner, id, expected, patch);
  };
  const entered = deferred();
  const worker = new TaskWorker(
    db,
    async (_owner, _task, context) => {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(new LostLeaseError()), {
          once: true,
        });
      });
      return {};
    },
    { pollMs: 10000 },
  );
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    worker.start();
    await entered.promise;
    await assert.rejects(
      shutdownServer(
        server,
        new RequestDrain(),
        () => worker.stop(),
        async () => {
          closed = true;
        },
      ),
      /could not confirm/,
    );
    assert(attempted);
    assert.equal(closed, false);
    await assert.rejects(worker.stop(), /could not confirm/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      errors.map((entry) => entry.context.phase),
      ["initial task worker tick"],
    );
    assert.equal(errors[0].error, "Error");
  } finally {
    await worker.stop().catch(() => {});
    server.closeAllConnections();
    server.close();
    await db.close();
  }
});

test("task application failure with durable final state permits clean worker stop", async () => {
  const db = await createStore();
  await workerTask(db);
  const worker = new TaskWorker(db, async () => {
    throw Error("known task failure");
  });
  try {
    await worker.tick();
    await worker.stop();
    assert.equal((await db.get("owner", "tasks", "shutdown-task"))?.status, "failed");
    assert((await db.list("owner", "runs")).every((run) => run.status === "failed"));
  } finally {
    await worker.stop();
    await db.close();
  }
});

test("worker shutdown joins a heartbeat write already dispatched before task abort", async () => {
  const db = await createStore();
  await workerTask(db);
  const compare = db.compareAndSwap.bind(db);
  const compareTask = db.compareAndSwapTask.bind(db);
  const renewalEntered = deferred(),
    receipt = deferred(),
    entered = deferred();
  db.compareAndSwap = async (owner, kind, id, expected, patch) => {
    if (kind === "tasks" && Object.keys(patch).length === 1 && "leaseUntil" in patch) {
      renewalEntered.resolve();
      await receipt.promise;
    }
    return compare(owner, kind, id, expected, patch);
  };
  db.compareAndSwapTask = async (owner, id, expected, patch) => {
    if (Object.keys(patch).length === 1 && "leaseUntil" in patch) {
      renewalEntered.resolve();
      await receipt.promise;
    }
    return compareTask(owner, id, expected, patch);
  };
  const worker = new TaskWorker(
    db,
    async (_owner, _task, context) => {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(new LostLeaseError()), {
          once: true,
        });
      });
      return {};
    },
    { leaseMs: 30, pollMs: 10000 },
  );
  try {
    worker.start();
    await entered.promise;
    await renewalEntered.promise;
    let closed = false;
    const closing = worker.stop().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(closed, false);
    receipt.resolve();
    await closing;
    assert.equal((await db.get("owner", "tasks", "shutdown-task"))?.status, "queued");
  } finally {
    receipt.resolve();
    await worker.stop();
    await db.close();
  }
});

test("native action close waits through held success receipt and rejects new dispatch", async () => {
  const db = await createStore();
  const receipt = deferred(),
    entered = deferred();
  const put = db.put.bind(db);
  db.put = async (owner, kind, value) => {
    if (kind === "actions" && "status" in value && value.status === "succeeded") {
      entered.resolve();
      await receipt.promise;
    }
    return put(owner, kind, value);
  };
  const actions = new ActionService(db, {
    connected: async () => true,
    execute: async () => "sent",
  });
  try {
    const proposal = await actions.propose("owner", {
      kind: "email.send",
      data: { to: ["a@example.com"], subject: "fixture", body: "fixture", attachmentIds: [] },
    });
    const deciding = actions.decide("owner", proposal.id, proposal.hash, "approve");
    await entered.promise;
    let closed = false;
    const close = actions.close().then(() => {
      closed = true;
    });
    await assert.rejects(
      actions.decide("owner", proposal.id, proposal.hash, "approve"),
      /shutting down/,
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(closed, false);
    receipt.resolve();
    await Promise.all([close, deciding]);
    assert.equal((await db.get("owner", "actions", proposal.id))?.status, "succeeded");
    assert((await db.actionLog("owner")).entries.some((entry) => entry.result === "succeeded"));
  } finally {
    receipt.resolve();
    await actions.close();
    await db.close();
  }
});

test("local reply shutdown joins its partial durable stream and releases lease before restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-shutdown-"));
  let db = await createStore({ dataDir: join(directory, "postgres") });
  const streamed = deferred();
  class Continuous extends AbstractAgent {
    run(input: RunAgentInput) {
      return new Observable<BaseEvent>((subscriber) => {
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        });
        subscriber.next({
          type: EventType.TEXT_MESSAGE_START,
          messageId: "partial",
          role: "assistant",
        });
        subscriber.next({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "partial",
          delta: "Partial work",
        });
      });
    }
  }
  try {
    const threads = new LocalThreads(db);
    const input: RunAgentInput = {
      threadId: "shutdown-thread",
      runId: "shutdown-run",
      state: {},
      messages: [{ id: "user", role: "user", content: "Continue" }],
      tools: [],
      context: [],
      forwardedProps: {},
    };
    const events = threads.withOwner("owner", () =>
      threads.run({ threadId: input.threadId, input, agent: new Continuous() }),
    );
    const completed = lastValueFrom(events.pipe(toArray()));
    events.subscribe((event) => {
      if (event.type === EventType.TEXT_MESSAGE_CONTENT) streamed.resolve();
    });
    await streamed.promise;
    await threads.close();
    const saved = await threads.history("owner", input.threadId);
    assert(saved.messages.some((message) => message.content === "Partial work"));
    assert.equal(await db.threadLeaseActive("owner", input.threadId), false);
    assert((await completed).some((event) => event.type === EventType.RUN_FINISHED));
    await db.close();
    db = await createStore({ dataDir: join(directory, "postgres") });
    assert.deepEqual(await new LocalThreads(db).history("owner", input.threadId), saved);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("unconfirmed native action persistence makes shutdown fail rather than authorize backup", async () => {
  const db = await createStore();
  const actions = new ActionService(db, {
    connected: async () => true,
    execute: async () => "sent",
  });
  try {
    const proposal = await actions.propose("owner", {
      kind: "email.send",
      data: { to: ["a@example.com"], subject: "fixture", body: "fixture", attachmentIds: [] },
    });
    const put = db.put.bind(db);
    db.put = async (owner, kind, value) => {
      if (kind === "actions" && "status" in value && value.status === "succeeded")
        throw Error("disk failure");
      return put(owner, kind, value);
    };
    await assert.rejects(
      actions.decide("owner", proposal.id, proposal.hash, "approve"),
      /disk failure/,
    );
    await assert.rejects(actions.close(), /could not confirm/);
  } finally {
    await db.close();
  }
});
