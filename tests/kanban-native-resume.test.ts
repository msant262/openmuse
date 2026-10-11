import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { KanbanExecution } from "../apps/server/src/engine/kanban-tools.ts";
import { KanbanWorkflow } from "../apps/server/src/engine/kanban-workflow.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

async function blocked(
  t: TestContext,
  seconds?: number,
  reuseSource = false,
  textDelivery = false,
) {
  const url = "https://sources.example/finding";
  const calls = [
    { name: "search_tools", arguments: { query: "kanban" } },
    { name: "web_fetch", arguments: { url } },
    {
      name: "kanban_block",
      arguments: {
        kind: "needs_input",
        reason: "Qual título você escolheu para registrar este resultado?",
      },
    },
    ...(reuseSource ? [{ name: "read_tool_output", arguments: { tool: "web_fetch" } }] : []),
    ...(!textDelivery
      ? [
          {
            name: "finish_task",
            arguments: { summary: "Relatório QA: a fonte confirma o resultado observado." },
          },
        ]
      : []),
  ];
  const provider = await modelFixture(
    t,
    (i) => calls[i],
    textDelivery
      ? {
          text: (i) =>
            i === calls.length
              ? "Relatório QA: a fonte confirma o resultado observado."
              : undefined,
        }
      : {},
  );
  const f = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    computerEnabled: true,
  });
  const observed = { reads: 0, directories: 0 };
  t.mock.method(f.agent.computer, "mkdir", async (_owner: string, path: string) => {
    observed.directories++;
    await mkdir(join(f.directory, "computer", path.slice("/workspace/".length)), {
      recursive: true,
    });
    return { path };
  });
  t.mock.method(f.agent.web, "document", async () => {
    observed.reads++;
    return {
      url,
      contentType: "text/html",
      body: "<main>A fonte confirma o resultado observado.</main>",
    };
  });
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "enable",
    profile: { toolsets: ["kanban"], ...(seconds && { maxRuntimeSeconds: seconds }) },
  });
  const board = new KanbanWorkflow(f.db, "owner", "default", { profileExists: () => true });
  const card = await board.create(
    { role: "orchestrator", profile: "default" },
    {
      title: "Registrar o resultado da fonte",
      body: `Leia ${url} e registre o resultado com o título escolhido.`,
      assignee: "default",
    },
    "card",
  );
  await f.agent.routineTick();
  const first = (await board.get(card.id)).currentRun;
  assert.ok(first?.nativeTaskId);
  await f.agent.worker.tick();
  assert.equal((await f.agent.getTask("owner", first.nativeTaskId)).status, "waiting_input");
  assert.equal((await board.get(card.id)).status, "blocked");
  assert.equal((await board.get(card.id)).currentRun, null);
  const binding = await f.db.get<KanbanExecution>("owner", "kanban-executions", first.nativeTaskId);
  assert.ok(binding?.workspace?.prepared);
  return { ...f, board, card, first, taskId: first.nativeTaskId, binding, provider, observed };
}

test("answering a native blocker resumes the same task and preserves source receipts, workspace and interpreter identity", async (t) => {
  const f = await blocked(t);
  const source = (await f.agent.journal.operations("owner", f.taskId)).find(
    (op) => op.toolName === "web_fetch",
  );
  assert.ok(source);
  await f.agent.answer("owner", f.taskId, "Relatório QA");
  assert.equal((await f.agent.getTask("owner", f.taskId)).status, "queued");
  await f.agent.worker.tick();
  const completed = await f.agent.getTask("owner", f.taskId);
  assert.equal(
    completed.status,
    "succeeded",
    JSON.stringify({ error: completed.error, question: completed.question }),
  );
  assert.equal((await f.board.get(f.card.id)).status, "done");
  assert.equal((await f.db.list("owner", "tasks")).length, 1);
  const runs = (await f.board.runHistory(f.card.id)).values;
  assert.equal(runs.length, 2);
  assert.ok(runs.some((run) => run.id !== f.first.id));
  const resumed = await f.db.get<KanbanExecution>("owner", "kanban-executions", f.taskId);
  assert.notEqual(resumed?.runId, f.first.id);
  assert.equal(resumed?.continuationRunId, f.first.id);
  assert.deepEqual(resumed?.workspace, f.binding.workspace);
  assert.deepEqual(
    (await f.agent.journal.operations("owner", f.taskId)).find((op) => op.id === source.id),
    source,
  );
  assert.deepEqual(f.observed, { reads: 1, directories: 1 });
  assert.equal(f.provider.requests.length, 4);
  assert.match(f.provider.requests[3].body, /Relatório QA/);
  await f.agent.worker.tick();
  assert.equal(f.provider.requests.length, 4, "a completed task is not dispatched again");
});

test("human resumption renews only the ended canonical runtime and applies accepted directions before inference", async (t) => {
  const f = await blocked(t, 900, true);
  assert.ok(f.binding.configuration?.runtime);
  await f.db.put("owner", "kanban-executions", {
    ...f.binding,
    configuration: {
      ...f.binding.configuration,
      runtime: { ...f.binding.configuration.runtime, deadlineAt: Date.now() - 1 },
    },
  });
  await f.agent.answer("owner", f.taskId, "Relatório QA");
  await f.agent.mailbox.enqueue("owner", f.taskId, {
    clientMessageId: "direction",
    text: "Use o título Relatório QA e responda em português.",
    expectedRevision: 0,
  });
  const queued = await f.agent.getTask("owner", f.taskId);
  assert.notEqual(queued.state.desiredRevision, queued.state.appliedRevision);
  await f.agent.worker.tick();
  const completed = await f.agent.getTask("owner", f.taskId);
  assert.equal(
    completed.status,
    "succeeded",
    JSON.stringify({
      error: completed.error,
      completion: completed.completion,
      operations: (await f.agent.journal.operations("owner", f.taskId)).map((op) => ({
        name: op.toolName,
        revision: op.revision,
        status: op.status,
        receipt: op.receipt,
      })),
    }),
  );
  assert.equal(completed.state.desiredRevision, 1);
  assert.equal(completed.state.appliedRevision, 1);
  assert.match(f.provider.requests[3].body, /responda em português/);
  assert.equal(f.provider.requests.length, 5);
  const binding = await f.db.get<KanbanExecution>("owner", "kanban-executions", f.taskId);
  assert.equal(binding?.configuration?.runtime?.maxMilliseconds, 900_000);
  assert.ok((binding?.configuration?.runtime?.deadlineAt ?? 0) > Date.now());
  assert.deepEqual(f.observed, { reads: 1, directories: 1 });
});

test("a completed text response uses the same journaled native handoff as an explicit finish tool", async (t) => {
  const f = await blocked(t, undefined, false, true);
  await f.agent.answer("owner", f.taskId, "Relatório QA");
  await f.agent.worker.tick();
  const completed = await f.agent.getTask("owner", f.taskId);
  assert.equal(completed.status, "succeeded", completed.error ?? "");
  assert.equal((await f.board.get(f.card.id)).status, "done");
  assert.deepEqual(f.observed, { reads: 1, directories: 1 });
  const handoff = (await f.agent.journal.operations("owner", f.taskId)).filter(
    (op) => op.toolName === "finish_task",
  );
  assert.equal(handoff.length, 1);
  assert.equal(handoff[0].status, "succeeded");
  assert.equal(f.provider.requests.length, 4);
});

test("a stop answer cancels without another inference, workspace or canonical run", async (t) => {
  const f = await blocked(t);
  await f.agent.answer("owner", f.taskId, "pode parar");
  await f.agent.worker.tick();
  assert.equal((await f.agent.getTask("owner", f.taskId)).status, "cancelled");
  assert.equal((await f.board.runHistory(f.card.id)).values.length, 1);
  assert.deepEqual(f.observed, { reads: 1, directories: 1 });
  assert.equal(f.provider.requests.length, 3);
});

for (const race of ["pause", "lease", "profile", "binding", "uncertainty"] as const) {
  test(`native resumption atomically rejects a late ${race} change before another inference`, async (t) => {
    const f = await blocked(t);
    await f.agent.answer("owner", f.taskId, "Relatório QA");
    const before = await f.board.get(f.card.id);
    const mutate = f.db.durableMutation.bind(f.db);
    let intercepted = false;
    t.mock.method(f.db, "durableMutation", async (...args: Parameters<typeof mutate>) => {
      if (!intercepted && args[1].startsWith("kanban:default:resume:")) {
        intercepted = true;
        if (race === "pause") {
          await f.agent.runtimePause.set("owner", { paused: true, expectedRevision: 0 });
        } else if (race === "lease") {
          await f.db.compareAndSwapTask(
            "owner",
            f.taskId,
            {},
            { leaseId: "replacement", leaseUntil: new Date(Date.now() + 60_000).toISOString() },
          );
        } else if (race === "profile") {
          await f.agent.executionProfiles.set("owner", "default", {
            expectedRevision: 1,
            requestId: "disable",
            profile: { disabledToolsets: ["kanban"] },
          });
        } else if (race === "binding") {
          await f.db.put("owner", "kanban-executions", { ...f.binding, runId: "foreign-run" });
        } else {
          await f.db.put("owner", "task-operations", {
            id: "late-effect",
            taskId: f.taskId,
            effect: true,
            status: "outcome_unknown",
            receipt: { data: { cleanupConfirmed: true } },
          });
        }
      }
      return mutate(...args);
    });
    await f.agent.worker.tick();
    assert.ok(intercepted);
    assert.deepEqual(await f.board.get(f.card.id), before);
    assert.equal((await f.board.runHistory(f.card.id)).values.length, 1);
    assert.equal(f.provider.requests.length, 3);
    assert.deepEqual(f.observed, { reads: 1, directories: 1 });
    const native = await f.agent.getTask("owner", f.taskId);
    if (race === "pause") {
      assert.equal(native.status, "waiting_global_pause");
      await f.agent.runtimePause.set("owner", { paused: false, expectedRevision: 1 });
      await f.agent.worker.tick();
      assert.equal((await f.agent.getTask("owner", f.taskId)).status, "succeeded");
      assert.equal((await f.board.get(f.card.id)).status, "done");
      assert.equal((await f.board.runHistory(f.card.id)).values.length, 2);
      assert.deepEqual(f.observed, { reads: 1, directories: 1 });
      assert.equal(f.provider.requests.length, 4);
    }
    if (race === "lease") assert.equal(native.leaseId, "replacement");
    if (race === "uncertainty") {
      const operation = await f.db.get<{ status: string }>(
        "owner",
        "task-operations",
        "late-effect",
      );
      assert.equal(operation?.status, "outcome_unknown");
    }
  });
}
