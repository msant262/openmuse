import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { ResourceLeases } from "../apps/server/src/engine/resource-leases.ts";
import { WorkAdmission } from "../apps/server/src/engine/work-admission.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";

function task(id: string): AgentTask {
  const now = new Date().toISOString();
  return {
    id,
    title: id,
    prompt: `Run ${id}`,
    kind: "agent",
    status: "queued",
    plan: [],
    evidence: [],
    input: {},
    state: {},
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    leaseId: null,
    leaseUntil: null,
    artifactIds: [],
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2_000;
  while (!(await predicate()) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

test("task worker admits four durable slots while earlier tasks remain in flight", async () => {
  const db = await createStore();
  const starts: string[] = [];
  const gates = new Map<string, { resolve: () => void; promise: Promise<void> }>();
  for (let i = 0; i < 5; i++) {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    gates.set(`task-${i}`, { resolve, promise });
    await db.put("owner", "tasks", task(`task-${i}`));
  }
  const execute = async (_owner: string, value: AgentTask) => {
    starts.push(value.id);
    await gates.get(value.id)?.promise;
    return { status: "succeeded" as const };
  };
  const firstWorker = new TaskWorker(db, execute);
  const secondWorker = new TaskWorker(db, execute);
  const firstTick = firstWorker.tick();
  let replacementTick: Promise<void> | undefined;
  try {
    await waitFor(() => starts.length >= 4);
    assert.equal(starts.length, 4, "the fourth work slot should be admitted");
    await secondWorker.tick();
    assert.equal(starts.length, 4, "a second worker must not exceed the global four slots");

    gates.get("task-0")?.resolve();
    await waitFor(
      async () => (await db.get<AgentTask>("owner", "tasks", "task-0"))?.status === "succeeded",
    );
    replacementTick = secondWorker.tick();
    await waitFor(() => starts.length === 5);
    assert.equal(starts.length, 5, "a freed slot should admit queued work while three tasks run");
  } finally {
    for (const gate of gates.values()) gate.resolve();
    await Promise.allSettled([firstTick, ...(replacementTick ? [replacementTick] : [])]);
    await Promise.all([firstWorker.stop(), secondWorker.stop()]);
    await db.close();
  }
});

test("held waiting_job slots survive worker restart and release only after receipt completion", async () => {
  const db = await createStore();
  let physicalDone = false;
  const starts: string[] = [];
  for (let i = 0; i < 5; i++) {
    const value = task(`job-${i}`);
    if (i === 4) value.status = "queued";
    await db.put("owner", "tasks", value);
  }
  const execute = async (_owner: string, value: AgentTask) => {
    starts.push(value.id);
    return value.id === "job-0" && physicalDone
      ? { status: "succeeded" as const }
      : { status: "waiting_job" as const };
  };
  const firstWorker = new TaskWorker(db, execute, { jobPollMs: 0 });
  const firstTick = firstWorker.tick();
  try {
    await firstTick;
    assert.equal(starts.length, 4);
    for (let i = 0; i < 4; i++)
      assert.equal((await db.get<AgentTask>("owner", "tasks", `job-${i}`))?.status, "waiting_job");
  } finally {
    await firstWorker.stop();
  }

  const restartedWorker = new TaskWorker(db, execute, { jobPollMs: 0 });
  try {
    await restartedWorker.tick();
    assert.equal(starts.length, 8, "restart polls all four persisted jobs");
    assert.equal(starts.includes("job-4"), false, "four held slots still occupy the global cap");

    physicalDone = true;
    await restartedWorker.tick();
    assert.equal((await db.get<AgentTask>("owner", "tasks", "job-0"))?.status, "succeeded");
    await restartedWorker.tick();
    assert.equal(starts.includes("job-4"), true, "terminal receipt releases its durable slot");
  } finally {
    await restartedWorker.stop();
    await db.close();
  }
});

test("scheduler checkpoints preserve concurrent revision and mailbox cursors", async () => {
  const db = await createStore();
  const value = task("checkpoint-merge");
  value.state = { desiredRevision: 1, mailboxSeq: 2 };
  await db.put("owner", "tasks", value);
  const worker = new TaskWorker(db, async (_owner, running, context) => {
    await db.compareAndSwap(
      "owner",
      "tasks",
      running.id,
      { status: "running", leaseId: running.leaseId },
      { state: { ...running.state, desiredRevision: 7, mailboxSeq: 11 } },
    );
    await context.checkpoint({ state: { modelCheckpoint: "safe" } });
    return { status: "succeeded" };
  });
  try {
    await worker.tick();
    const saved = await db.get<AgentTask>("owner", "tasks", value.id);
    assert.equal(saved?.state.desiredRevision, 7);
    assert.equal(saved?.state.mailboxSeq, 11);
    assert.equal(saved?.state.modelCheckpoint, "safe");
  } finally {
    await worker.stop();
    await db.close();
  }
});

test("retiring worker releases only its fenced resource lease after takeover", async () => {
  const db = await createStore();
  await db.put("owner", "tasks", task("resource-takeover"));
  const oldEntered = deferred();
  const oldFinish = deferred();
  const newEntered = deferred();
  const newFinish = deferred();
  let now = Date.now();
  const firstResources = new ResourceLeases(db, { now: () => now });
  const secondResources = new ResourceLeases(db, { now: () => now });
  let oldFence = 0;
  let newFence = 0;
  let newGuard!: () => Promise<void>;
  const request = [{ key: "browser-profile:host:personal", units: 1, mode: "exclusive" as const }];
  const first = new TaskWorker(
    db,
    async (_owner, _value, context) => {
      oldFence = (await context.acquireResources(request))[0].fence;
      oldEntered.resolve();
      await oldFinish.promise;
      await context.guard();
      return { status: "succeeded" };
    },
    {
      now: () => now,
      leaseMs: 60_000,
      resourceLeases: firstResources,
      workAdmission: new WorkAdmission(db, { now: () => now }),
    },
  );
  const second = new TaskWorker(
    db,
    async (_owner, _value, context) => {
      newFence = (await context.acquireResources(request))[0].fence;
      newGuard = context.guard;
      newEntered.resolve();
      await newFinish.promise;
      return { status: "succeeded" };
    },
    {
      now: () => now,
      leaseMs: 60_000,
      resourceLeases: secondResources,
      workAdmission: new WorkAdmission(db, { now: () => now }),
    },
  );
  const firstTick = first.tick();
  try {
    await oldEntered.promise;
    now += 60_001;
    const secondTick = second.tick();
    await newEntered.promise;
    assert.equal(oldFence, 1);
    assert.equal(newFence, 2);

    oldFinish.resolve();
    await firstTick;
    await newGuard();
    assert.equal(
      (await secondResources.listForTask("resource-takeover")).length,
      1,
      "the replacement worker's fenced lease remains present",
    );
    assert.equal(await secondResources.acquire("owner", "competitor", request), null);
    newFinish.resolve();
    await secondTick;
    assert.equal(
      (await db.get<AgentTask>("owner", "tasks", "resource-takeover"))?.status,
      "succeeded",
    );
  } finally {
    oldFinish.resolve();
    newFinish.resolve();
    await Promise.allSettled([firstTick]);
    await Promise.all([first.stop(), second.stop()]);
    await db.close();
  }
});

test("worker shutdown reports durable release failure after clearing its active controller", async () => {
  const db = await createStore();
  await db.put("owner", "tasks", task("release-failure"));
  db.releaseWorkAdmission = async () => {
    throw new Error("injected admission release failure");
  };
  const worker = new TaskWorker(db, async () => ({ status: "succeeded" }));
  try {
    await assert.rejects(worker.tick(), /injected admission release failure/);
    assert.equal((worker as unknown as { active: Map<string, AbortController> }).active.size, 0);
    await assert.rejects(
      Promise.race([
        worker.stop(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("shutdown hung")), 500),
        ),
      ]),
      /could not confirm durable completion/,
    );
  } finally {
    await db.close();
  }
});

test("a restarted worker renews an owned held slot during a long receipt poll", async () => {
  const db = await createStore();
  const value = task("held-heartbeat");
  await db.put("owner", "tasks", value);
  let executions = 0;
  let resumed!: () => void;
  const started = new Promise<void>((resolve) => (resumed = resolve));
  const worker = new TaskWorker(
    db,
    async () => {
      executions++;
      if (executions === 2) {
        resumed();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { status: "waiting_job" };
    },
    { jobPollMs: 0, leaseMs: 30 },
  );
  try {
    await worker.tick();
    await worker.stop();

    const restarted = new TaskWorker(
      db,
      async () => {
        executions++;
        resumed();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { status: "waiting_job" };
      },
      { jobPollMs: 0, leaseMs: 30 },
    );
    const tick = restarted.tick();
    try {
      await started;
      await tick;
      assert.equal(executions, 2);
      assert.equal((await db.get<AgentTask>("owner", "tasks", value.id))?.status, "waiting_job");
      assert.equal((await db.list("__runtime__", "work-admissions")).length, 1);
    } finally {
      await restarted.stop();
    }
  } finally {
    await worker.stop().catch(() => {});
    await db.close();
  }
});
