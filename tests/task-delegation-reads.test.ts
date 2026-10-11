import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

async function historicalWork(f: Awaited<ReturnType<typeof taskRuntime>>) {
  const seed = await f.agent.createTask("owner", { prompt: "Historical work" }, undefined, true);
  await f.db.put("owner", "tasks", { ...seed, status: "failed" });
  for (let i = 0; i < 64; i++)
    await f.db.put("owner", "tasks", {
      ...seed,
      id: `unrelated-${i}`,
      status: "failed",
      originThreadId: "unrelated-conversation",
      state: { providerCheckpoint: { messages: "UNRELATED_EXECUTION_HISTORY".repeat(5000) } },
    });
  return seed;
}

function observeTaskScans(t: TestContext, f: Awaited<ReturnType<typeof taskRuntime>>) {
  const list = f.db.list.bind(f.db);
  const reads = { bytes: 0, scans: 0 };
  t.mock.method(f.db, "list", async (owner: string, kind: string) => {
    const values = await list(owner, kind);
    if (kind === "tasks") {
      reads.scans++;
      reads.bytes += Buffer.byteLength(JSON.stringify(values));
    }
    return values;
  });
  return reads;
}

test("delegation inherits the latest six useful results without hydrating unrelated execution history", async (t) => {
  const f = await taskRuntime(t, { taskWorkerEnabled: false });
  const seed = await historicalWork(f);
  for (let i = 0; i < 8; i++)
    await f.db.put("owner", "tasks", {
      ...seed,
      id: `related-${i}`,
      originThreadId: "current-conversation",
      prompt: `Earlier request ${i}`,
      result: `Actual earlier result ${i}`,
      status: "succeeded",
      createdAt: new Date(Date.UTC(2026, 9, 10, 0, i)).toISOString(),
      state: { providerCheckpoint: { messages: "OLD_MODEL_HISTORY".repeat(5000) } },
    });
  await f.db.put("owner", "tasks", {
    ...seed,
    id: "latest-without-result",
    originThreadId: "current-conversation",
    createdAt: "2026-10-11T00:00:00.000Z",
  });
  const reads = observeTaskScans(t, f);
  const task = await f.agent.createTask(
    "owner",
    {
      prompt: "Retrieve the earlier work",
      originThreadId: "current-conversation",
      originMessageId: "latest-message",
    },
    "delegation-with-history",
    true,
    undefined,
    "Retrieve the earlier work",
    [{ id: "latest-message", role: "user", content: "Retrieve the earlier work" }],
  );
  const context = task.state.conversationContext as {
    priorResults: { taskId: string; result: string }[];
  };
  assert.deepEqual(
    context.priorResults.map((r) => r.taskId),
    ["related-2", "related-3", "related-4", "related-5", "related-6", "related-7"],
  );
  assert.equal(context.priorResults[5].result, "Actual earlier result 7");
  assert.doesNotMatch(JSON.stringify(context), /UNRELATED_EXECUTION_HISTORY|OLD_MODEL_HISTORY/);
  assert.equal(reads.bytes, 0, "delegation must not transfer the owner's entire task records");
});

test("more than four child tasks can queue while actual running work stays admitted to four slots", async (t) => {
  const f = await taskRuntime(t, { taskWorkerEnabled: false });
  const parent = await f.agent.createTask(
    "owner",
    { prompt: "Combine five independent results" },
    undefined,
    true,
  );
  const children: AgentTask[] = [];
  for (let i = 0; i < 5; i++)
    children.push(
      await f.agent.createChildTask(
        "owner",
        parent,
        { prompt: `Calculate part ${i}` },
        `child-${i}`,
      ),
    );
  assert.equal(new Set(children.map((c) => c.id)).size, 5);
  assert.ok(children.every((c) => c.state.rootTaskId === parent.id && c.status === "queued"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fourStarted!: () => void;
  const admitted = new Promise<void>((resolve) => {
    fourStarted = resolve;
  });
  const running: string[] = [];
  const worker = new TaskWorker(f.db, async (_owner, task) => {
    running.push(task.id);
    if (running.length === 4) fourStarted();
    await gate;
    return { status: "succeeded", result: `Actual result for ${task.id}` };
  });
  t.after(async () => {
    release();
    await worker.stop();
  });
  const tick = worker.tick();
  await admitted;
  assert.equal(running.length, 4);
  const states = await Promise.all(children.map((c) => f.agent.getTask("owner", c.id)));
  assert.equal(states.filter((c) => c.status === "running").length, 4);
  assert.equal(
    states.filter((c) => c.status === "queued" || c.status === "waiting_resource").length,
    1,
  );
  release();
  await tick;
  await worker.tick();
  assert.equal(
    running.length,
    5,
    "the fifth queued child is admitted after the first workers release their slots",
  );
});

test("settled children wake only their own parent without full-history scans", async (t) => {
  const f = await taskRuntime(t, {
    taskWorkerEnabled: false,
    proactivityEnabled: false,
    memoryLearningEnabled: false,
  });
  await historicalWork(f);
  const parent = await f.agent.createTask(
    "owner",
    { prompt: "Collect the parts" },
    undefined,
    true,
  );
  const child = await f.agent.createChildTask(
    "owner",
    parent,
    { prompt: "Part one" },
    "wake-child",
  );
  const sibling = await f.agent.createChildTask(
    "owner",
    parent,
    { prompt: "Part two" },
    "wake-sibling",
  );
  await f.db.put("owner", "tasks", { ...parent, status: "waiting_children" });
  await f.db.put("owner", "tasks", { ...sibling, status: "cancelled" });
  await f.db.put("another-owner", "tasks", { ...sibling, id: "foreign-child", status: "queued" });
  const completed = { ...child, status: "succeeded" as const, result: "Observed part one" };
  await f.db.put("owner", "tasks", completed);
  const reads = observeTaskScans(t, f);
  await (
    f.agent as unknown as { publishOutcome(owner: string, task: AgentTask): Promise<void> }
  ).publishOutcome("owner", completed);
  const resumed = await f.agent.getTask("owner", parent.id);
  assert.equal(resumed.status, "queued");
  assert.deepEqual(
    (resumed.state.childrenResults as { id: string }[]).map((c) => c.id).sort(),
    [child.id, sibling.id].sort(),
  );
  assert.equal((await f.agent.getTask("another-owner", "foreign-child")).status, "queued");
  assert.equal(reads.bytes, 0, "child settlement must not reload unrelated historical tasks");
});

test("cancelling a conversation contains its nested children without touching other owners or tasks", async (t) => {
  const f = await taskRuntime(t, { taskWorkerEnabled: false });
  const unrelated = await historicalWork(f);
  const parent = await f.agent.createTask(
    "owner",
    { prompt: "Current conversation work", originThreadId: "cancel-this" },
    undefined,
    true,
  );
  const child = await f.agent.createChildTask(
    "owner",
    parent,
    { prompt: "Nested part" },
    "cancel-child",
  );
  const grandchild = await f.agent.createChildTask(
    "owner",
    child,
    { prompt: "Nested descendant" },
    "cancel-grandchild",
  );
  await f.db.put("another-owner", "tasks", {
    ...grandchild,
    id: "foreign-descendant",
    status: "queued",
  });
  const reads = observeTaskScans(t, f);
  await f.agent.cancelThreadTasks("owner", "cancel-this");
  for (const task of [parent, child, grandchild])
    assert.equal((await f.agent.getTask("owner", task.id)).status, "cancelled");
  assert.equal((await f.agent.getTask("another-owner", "foreign-descendant")).status, "queued");
  assert.equal((await f.agent.getTask("owner", unrelated.id)).status, "failed");
  assert.equal(
    reads.bytes,
    0,
    "cancellation must select the owned conversation graph in the database",
  );
});

test("retiring finished work preserves unfinished descendants and uses scoped child selection", async (t) => {
  const f = await taskRuntime(t, { taskWorkerEnabled: false });
  const parent = await f.agent.createTask("owner", { prompt: "An ended parent" }, undefined, true);
  const child = await f.agent.createChildTask(
    "owner",
    parent,
    { prompt: "An unfinished descendant" },
    "unfinished-removal-child",
  );
  await f.db.put("owner", "tasks", { ...parent, status: "cancelled" });
  await f.db.put("another-owner", "tasks", { ...child, id: "foreign-retired", status: "failed" });
  const reads = observeTaskScans(t, f);
  assert.deepEqual((await f.agent.clearFinishedTasks("owner")).removed, []);
  assert.equal((await f.agent.getTask("owner", parent.id)).deletedAt, undefined);
  assert.equal((await f.agent.getTask("owner", child.id)).status, "queued");
  await f.db.put("owner", "tasks", { ...child, status: "cancelled" });
  await f.agent.clearFinishedTasks("owner");
  assert.ok((await f.db.get<AgentTask>("owner", "tasks", parent.id))?.deletedAt);
  assert.ok((await f.db.get<AgentTask>("owner", "tasks", child.id))?.deletedAt);
  await assert.rejects(() => f.agent.getTask("owner", parent.id), /Task not found/);
  assert.equal((await f.agent.getTask("another-owner", "foreign-retired")).deletedAt, undefined);
  assert.equal(reads.bytes, 0);
});
