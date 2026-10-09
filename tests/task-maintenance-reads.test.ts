import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("maintenance publishes historical outcomes once and does not hydrate unchanged task history again", async (t) => {
  const f = await taskRuntime(t, {
    mode: "live",
    taskWorkerEnabled: false,
    memoryLearningEnabled: false,
    proactivityEnabled: false,
  });
  const task = await f.agent.createTask("owner", { prompt: "Finished historical task" });
  await f.db.put("owner", "tasks", {
    ...task,
    status: "failed",
    result: "An actual old failure",
    state: { ...task.state, providerCheckpoint: { messages: "old history".repeat(100_000) } },
  });
  const maintain = () => (f.agent as unknown as { maintain(): Promise<void> }).maintain();
  await maintain();
  assert.equal((await f.db.list("owner", "notifications")).length, 1);
  let taskScans = 0;
  let taskReads = 0;
  const scan = f.db.scan.bind(f.db);
  const get = f.db.get.bind(f.db);
  t.mock.method(f.db, "scan", async (kind: string) => {
    if (kind === "tasks") taskScans++;
    return scan(kind);
  });
  t.mock.method(f.db, "get", async (owner: string, kind: string, id: string) => {
    if (kind === "tasks") taskReads++;
    return get(owner, kind, id);
  });
  await maintain();
  assert.equal(taskScans, 0, "unchanged history must be filtered inside the database");
  assert.equal(taskReads, 0, "unchanged outcomes must not be reloaded and republished");
  assert.equal((await f.db.list("owner", "notifications")).length, 1);
  await f.db.compareAndSwapTask(
    "owner",
    task.id,
    { status: "failed" },
    {
      status: "scheduled",
      state: { notice: { title: "Scheduled again", body: "Changed outcome", key: "changed" } },
    },
  );
  await maintain();
  assert.ok(
    (await f.db.list<{ body: string }>("owner", "notifications")).some(
      (n) => n.body === "Changed outcome",
    ),
  );
});

test("maintenance recovery ignores historical payloads but keeps hidden native cleanup and provider interruptions", async (t) => {
  const f = await taskRuntime(t, { taskWorkerEnabled: false });
  const old = await f.agent.createTask("owner", { prompt: "Old work" });
  const provider = await f.agent.createTask("owner", { prompt: "Interrupted provider" });
  const native = await f.agent.createTask("owner", { prompt: "Native cleanup" });
  await f.db.put("owner", "tasks", { ...old, status: "succeeded" });
  await f.db.put("owner", "tasks", {
    ...provider,
    status: "waiting_provider",
    nextRunAt: null,
    state: {
      ...provider.state,
      providerCheckpoint: { code: "MODEL_PROVIDER_INTERRUPTED", accepted: true },
    },
  });
  await f.db.put("owner", "tasks", {
    ...native,
    status: "paused",
    historyHiddenAt: new Date().toISOString(),
    state: { ...native.state, nativeCleanupPending: true },
  });
  const recovered: string[] = [];
  const operationReads: string[] = [];
  const recover = f.agent.recoverInterruptedProvider.bind(f.agent);
  t.mock.method(f.agent, "recoverInterruptedProvider", async (owner: string, task: AgentTask) => {
    recovered.push(task.id);
    return recover(owner, task);
  });
  const operations = f.agent.journal.operations.bind(f.agent.journal);
  t.mock.method(f.agent.journal, "operations", async (owner: string, id: string) => {
    operationReads.push(id);
    return operations(owner, id);
  });
  await (f.agent as unknown as { maintain(): Promise<void> }).maintain();
  assert.deepEqual(recovered, [provider.id]);
  assert.ok(
    operationReads.includes(native.id),
    "hidden native effects retain cleanup reconciliation",
  );
  assert.ok((await f.agent.getTask("owner", provider.id)).nextRunAt);
  assert.equal((await f.agent.getTask("owner", native.id)).state.nativeCleanupPending, true);
});

test("workspace snapshots omit execution history while preserving detail, hidden occupancy and owner isolation", async (t) => {
  const f = await taskRuntime(t);
  const visible = await f.agent.createTask("owner", { prompt: "Visible work" });
  const hidden = await f.agent.createTask("owner", { prompt: "Hidden active work" });
  await f.db.put("owner", "tasks", {
    ...visible,
    state: {
      ...visible.state,
      providerCheckpoint: { messages: "PRIVATE_EXECUTION_HISTORY".repeat(5000) },
      conversationContext: "PRIVATE_CONVERSATION_CONTEXT",
    },
  });
  await f.db.put("owner", "tasks", {
    ...hidden,
    status: "running",
    historyHiddenAt: new Date().toISOString(),
  });
  for (const [id, status] of [
    ["active", "running"],
    ["uncertain", "timed_out"],
  ])
    await f.db.put("owner", "computer-commands", {
      id,
      status,
      stdout: "LARGE_OLD_COMMAND_OUTPUT".repeat(10000),
    });
  await f.db.put("other-owner", "computer-commands", { id: "foreign", status: "running" });
  const snapshot = await f.agent.snapshot("owner");
  assert.deepEqual(
    snapshot.tasks.map((task) => task.id),
    [visible.id],
  );
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /PRIVATE_EXECUTION_HISTORY|PRIVATE_CONVERSATION_CONTEXT|LARGE_OLD_COMMAND_OUTPUT/,
  );
  assert.equal(snapshot.runtimeStatus.activeTasks, 1);
  assert.equal(snapshot.runtimeStatus.activeOperations, 1);
  assert.equal(snapshot.runtimeStatus.uncertainOperations, 1);
  assert.match(
    JSON.stringify((await f.agent.detail("owner", visible.id)).task.state),
    /PRIVATE_EXECUTION_HISTORY/,
  );
});
