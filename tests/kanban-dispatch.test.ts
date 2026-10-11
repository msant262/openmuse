import assert from "node:assert/strict";
import test from "node:test";
import { KanbanWorkflow } from "../apps/server/src/engine/kanban-workflow.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("host dispatch creates the native binding and ordinary worker delivery without manually stamping identity", async (t) => {
  const url = "https://sources.example/finding";
  const fixture = await modelFixture(
    t,
    (index) =>
      [
        { name: "web_fetch", arguments: { url } },
        { name: "finish_task", arguments: { summary: "The observed finding is recorded." } },
      ][index],
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async () => ({
    url,
    contentType: "text/html",
    body: "<main>The observed source supports the finding.</main>",
  }));
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "enable",
    profile: { toolsets: ["kanban"], board: "pipeline" },
  });
  const kb = new KanbanWorkflow(f.db, "owner", "pipeline", { profileExists: () => true });
  const card = await kb.create(
    { role: "orchestrator", profile: "default" },
    {
      title: "Record findings",
      body: `Read ${url} and record the observed finding.`,
      assignee: "default",
    },
    "card",
  );
  const native = await f.agent.dispatchKanbanCard(
    "owner",
    "pipeline",
    card.id,
    "default",
    "dispatch",
  );
  const binding = await f.db.get<{ runId: string; cardId: string }>(
    "owner",
    "kanban-executions",
    native.id,
  );
  assert.equal(binding?.cardId, card.id);
  assert.equal(binding?.runId, (await kb.get(card.id)).currentRun?.id);
  assert.equal(native.status, "queued");
  await f.agent.worker.tick();
  const completed = await f.agent.getTask("owner", native.id);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.completion?.status, "verified");
  assert.equal((await kb.get(card.id)).status, "done");
  const replay = await f.agent.dispatchKanbanCard(
    "owner",
    "pipeline",
    card.id,
    "default",
    "dispatch",
  );
  assert.equal(replay.id, native.id);
  assert.equal(replay.status, "succeeded");
  assert.equal((await f.db.list("owner", "tasks")).length, 1);
  assert.equal((await kb.runHistory(card.id)).values.length, 1);
  assert.ok(fixture.requests[0].body.includes("Recorded workflow data follows"));
  assert.ok(
    (await f.agent.journal.operations("owner", native.id)).some(
      (op) => op.toolName === "finish_task" && op.status === "succeeded",
    ),
  );
});

test("a different owner cannot dispatch or discover another owner's card", async (t) => {
  const f = await taskRuntime(t);
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "enable",
    profile: { toolsets: ["kanban"] },
  });
  const kb = new KanbanWorkflow(f.db, "owner", "default", { profileExists: () => true });
  const card = await kb.create(
    { role: "orchestrator", profile: "default" },
    { title: "Private work", assignee: "default" },
    "card",
  );
  await assert.rejects(
    f.agent.dispatchKanbanCard("another-owner", "default", card.id, "default", "dispatch"),
    /not found/,
  );
  assert.deepEqual(await kb.get(card.id), card);
  assert.deepEqual(await f.db.list("another-owner", "tasks"), []);
  assert.deepEqual(await f.db.list("another-owner", "kanban-executions"), []);
});

test("claim preparation failure cannot leave a claimed card, task or binding", async (t) => {
  const f = await taskRuntime(t);
  let prepared = false;
  const kb = new KanbanWorkflow(f.db, "owner", "pipeline", {
    profileExists: () => true,
    beforeClaim: async () => {
      prepared = true;
      throw new Error("workspace preparation failed");
    },
  });
  const card = await kb.create(
    { role: "orchestrator", profile: "default" },
    { title: "Work", assignee: "default" },
    "card",
  );
  await assert.rejects(kb.claim(card.id, "default", "dispatch"), /workspace preparation failed/);
  assert.equal(prepared, true);
  assert.deepEqual(await kb.get(card.id), card);
  assert.deepEqual(await f.db.list("owner", "tasks"), []);
  assert.deepEqual(await f.db.list("owner", "kanban-executions"), []);
});

test("concurrent host dispatch of the same operation queues exactly one native run", async (t) => {
  const f = await taskRuntime(t);
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "enable",
    profile: { toolsets: ["kanban"] },
  });
  const kb = new KanbanWorkflow(f.db, "owner", "default", { profileExists: () => true });
  const card = await kb.create(
    { role: "orchestrator", profile: "default" },
    { title: "Work", assignee: "default" },
    "card",
  );
  const tasks = await Promise.all(
    [0, 1].map(() =>
      f.agent.dispatchKanbanCard("owner", "default", card.id, "default", "dispatch"),
    ),
  );
  assert.equal(tasks[0].id, tasks[1].id);
  assert.equal((await f.db.list("owner", "tasks")).length, 1);
  assert.equal((await f.db.list("owner", "kanban-executions")).length, 1);
  assert.equal((await kb.runHistory(card.id)).values.length, 1);
});

test("profile revocation during preparation fences the entire native dispatch transaction", async (t) => {
  const f = await taskRuntime(t);
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "enable",
    profile: { toolsets: ["kanban"] },
  });
  const kb = new KanbanWorkflow(f.db, "owner", "default", { profileExists: () => true });
  const card = await kb.create(
    { role: "orchestrator", profile: "default" },
    { title: "Work", assignee: "default" },
    "card",
  );
  const prepare = f.agent.taskRecord.bind(f.agent);
  t.mock.method(f.agent, "taskRecord", async (...args: Parameters<typeof prepare>) => {
    const task = await prepare(...args);
    await f.agent.executionProfiles.set("owner", "default", {
      expectedRevision: 1,
      requestId: "disable",
      profile: { disabledToolsets: ["kanban"] },
    });
    return task;
  });
  await assert.rejects(
    f.agent.dispatchKanbanCard("owner", "default", card.id, "default", "dispatch"),
    /Concurrent board change/,
  );
  assert.deepEqual(await kb.get(card.id), card);
  assert.deepEqual(await f.db.list("owner", "tasks"), []);
  assert.deepEqual(await f.db.list("owner", "kanban-executions"), []);
});

test("host dispatch cannot silently downgrade a declared goal or PR contract to a local task", async (t) => {
  const f = await taskRuntime(t);
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "enable",
    profile: { toolsets: ["kanban"] },
  });
  const kb = new KanbanWorkflow(f.db, "owner", "default", { profileExists: () => true });
  for (const input of [
    { goalMode: true },
    { completionContract: "OWNER/REPO" },
    { model: "mimo-v2.5-pro" },
  ]) {
    const card = await kb.create(
      { role: "orchestrator", profile: "default" },
      { title: "Work", assignee: "default", ...input },
      JSON.stringify(input),
    );
    await assert.rejects(
      f.agent.dispatchKanbanCard("owner", "default", card.id, "default", card.id),
      /requires.*dispatcher/i,
    );
    assert.deepEqual(await kb.get(card.id), card);
  }
  assert.deepEqual(await f.db.list("owner", "tasks"), []);
  assert.deepEqual(await f.db.list("owner", "kanban-executions"), []);
});

test("pause arriving after task preparation still prevents the card and native queue claim", async (t) => {
  const f = await taskRuntime(t);
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "enable",
    profile: { toolsets: ["kanban"] },
  });
  const kb = new KanbanWorkflow(f.db, "owner", "default", { profileExists: () => true });
  const card = await kb.create(
    { role: "orchestrator", profile: "default" },
    { title: "Work", assignee: "default" },
    "card",
  );
  const prepare = f.agent.taskRecord.bind(f.agent);
  t.mock.method(f.agent, "taskRecord", async (...args: Parameters<typeof prepare>) => {
    const task = await prepare(...args);
    await f.agent.runtimePause.set("owner", { paused: true, expectedRevision: 0 });
    return task;
  });
  await assert.rejects(
    f.agent.dispatchKanbanCard("owner", "default", card.id, "default", "dispatch"),
    /globally paused/,
  );
  assert.deepEqual(await kb.get(card.id), card);
  assert.deepEqual(await f.db.list("owner", "tasks"), []);
  assert.deepEqual(await f.db.list("owner", "kanban-executions"), []);
});
