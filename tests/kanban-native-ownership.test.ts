import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { type KanbanScope, KanbanWorkflow } from "../apps/server/src/engine/kanban-workflow.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import type { AgentTask, TaskStatus } from "../packages/domain/src/agent.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

async function assigned(t: TestContext) {
  const f = await taskRuntime(t);
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "enable",
    profile: { toolsets: ["kanban"], board: "pipeline" },
  });
  let time = Date.now();
  const board = new KanbanWorkflow(f.db, "owner", "pipeline", {
    profileExists: () => true,
    now: () => time,
  });
  const card = await board.create(
    { role: "orchestrator", profile: "default" },
    { title: "Research and deliver findings", assignee: "default" },
    "card",
  );
  const native = await f.agent.dispatchKanbanCard(
    "owner",
    "pipeline",
    card.id,
    "default",
    "dispatch",
  );
  const run = (await board.get(card.id)).currentRun;
  assert.ok(run);
  const worker = (leaseId = "actor-one"): KanbanScope => ({
    role: "worker",
    profile: "default",
    taskId: card.id,
    runId: run.id,
    nativeTaskId: native.id,
    nativeLeaseId: leaseId,
  });
  const running = async (leaseId = "actor-one") => {
    await f.db.compareAndSwapTask(
      "owner",
      native.id,
      {},
      {
        status: "running",
        leaseId,
        leaseUntil: new Date(time + 60000).toISOString(),
      },
    );
  };
  return {
    ...f,
    board,
    card,
    native,
    run,
    worker,
    running,
    now: () => time,
    expireCard: () => {
      time = run.expiresAt + 1;
    },
  };
}

test("the native task remains authoritative after the card deadline without a second run", async (t) => {
  const f = await assigned(t);
  assert.equal(f.run.nativeTaskId, f.native.id);
  f.expireCard();
  await f.running();
  const note = await f.board.comment(
    f.worker(),
    f.card.id,
    "Still researching actual sources.",
    "note",
  );
  assert.equal(note.runId, f.run.id);
  await assert.rejects(f.board.claim(f.card.id, "default", "duplicate"), /live|native|ownership/);
  assert.equal((await f.board.runHistory(f.card.id)).values.length, 1);
  assert.equal((await f.db.list("owner", "tasks")).length, 1);
  const shown = await f.board.show(f.card.id);
  assert.equal(shown.native_execution?.taskId, f.native.id);
  assert.equal(shown.native_execution?.claimProtected, true);
});

test("queued, expired running and waiting tasks retain the card while the existing worker resumes them", async (t) => {
  const f = await assigned(t);
  f.expireCard();
  for (const status of [
    "queued",
    "running",
    "waiting_approval",
    "waiting_input",
    "waiting_global_pause",
    "waiting_job",
    "paused",
  ] as TaskStatus[]) {
    await f.db.compareAndSwapTask(
      "owner",
      f.native.id,
      {},
      {
        status,
        leaseId: null,
        leaseUntil: null,
      },
    );
    await assert.rejects(
      f.board.claim(f.card.id, "default", `steal-${status}`),
      /live|native|ownership/,
      status,
    );
  }
  assert.equal((await f.board.runHistory(f.card.id)).values.length, 1);
  await f.running("resumed-actor");
  await f.board.comment(
    f.worker("resumed-actor"),
    f.card.id,
    "Resumed after the user's answer.",
    "resumed",
  );
});

test("a replaced native lease fences old actors even while the card claim has not expired", async (t) => {
  const f = await assigned(t);
  await f.running("replacement");
  await assert.rejects(
    f.board.comment(f.worker(), f.card.id, "Stale note", "stale"),
    /ownership|lease/,
  );
  await assert.rejects(
    f.board.create(f.worker(), { title: "Stale child", assignee: "default" }, "stale-child"),
    /ownership|lease/,
  );
  assert.equal((await f.board.comments(f.card.id)).values.length, 0);
  assert.equal((await f.db.list("owner", "kanban-cards:pipeline")).length, 1);
  await f.board.comment(f.worker("replacement"), f.card.id, "Current actor finding", "current");
});

for (const changed of ["lease", "binding", "expiry"] as const) {
  test(`the final transaction rejects a ${changed} change after ownership was read`, async (t) => {
    const f = await assigned(t);
    await f.running();
    const mutation = f.db.durableMutation.bind(f.db);
    let intercepted = false;
    t.mock.method(f.db, "durableMutation", async (...args: Parameters<typeof mutation>) => {
      if (!intercepted && args[1] === "kanban:pipeline:note") {
        intercepted = true;
        if (changed === "binding") {
          const binding = await f.db.get<Record<string, unknown>>(
            "owner",
            "kanban-executions",
            f.native.id,
          );
          await f.db.put("owner", "kanban-executions", {
            ...binding,
            id: f.native.id,
            runId: "another-run",
          });
        } else {
          await f.db.compareAndSwapTask(
            "owner",
            f.native.id,
            {},
            changed === "lease"
              ? { leaseId: "replacement" }
              : { leaseUntil: new Date(Date.now() - 1000).toISOString() },
          );
        }
      }
      return mutation(...args);
    });
    const before = await f.board.get(f.card.id);
    await assert.rejects(
      f.board.comment(f.worker(), f.card.id, "Uncommitted finding", "note"),
      /Concurrent|ownership|lease/,
    );
    assert.equal(intercepted, true);
    assert.deepEqual(await f.board.get(f.card.id), before);
    assert.equal((await f.board.comments(f.card.id)).values.length, 0);
    assert.equal(await f.db.get("owner", "mutation-receipts", "kanban:pipeline:note"), null);
  });
}

test("handoff acknowledgment survives a native actor restart without repeating the completion", async (t) => {
  const f = await assigned(t);
  await f.running();
  const input = { summary: "Verified findings delivered." };
  const completed = await f.board.complete(f.worker(), input, "finish");
  await f.running("resumed-actor");
  assert.deepEqual(await f.board.complete(f.worker("resumed-actor"), input, "finish"), completed);
  const saved = await f.board.handoffAcknowledgment(f.worker("resumed-actor"), "finish");
  assert.deepEqual(saved?.card, completed);
  assert.equal((await f.db.list("owner", `kanban-events:pipeline:${f.card.id}`)).length, 3);
});

test("missing native records and uncertain effects cannot be reclaimed as an expired standalone card", async (t) => {
  const f = await assigned(t);
  f.expireCard();
  await f.db.compareAndSwapTask(
    "owner",
    f.native.id,
    {},
    { status: "failed", leaseId: null, leaseUntil: null },
  );
  await f.db.put("owner", "task-operations", {
    id: "uncertain-send",
    taskId: f.native.id,
    status: "outcome_unknown",
    effect: true,
  });
  await assert.rejects(
    f.board.claim(f.card.id, "default", "uncertain-reclaim"),
    /live|native|reconcil|ownership/,
  );
  await f.db.remove("owner", "kanban-executions", f.native.id);
  await assert.rejects(
    f.board.claim(f.card.id, "default", "missing-binding"),
    /binding|native|ownership/,
  );
  await assert.rejects(
    f.board.comment(f.worker(), f.card.id, "Borrowed identity", "missing-note"),
    /binding|native|ownership/,
  );
  assert.equal((await f.board.runHistory(f.card.id)).values.length, 1);
});

test("only an observed settled terminal task permits a new card run", async (t) => {
  const f = await assigned(t);
  f.expireCard();
  await f.db.compareAndSwapTask(
    "owner",
    f.native.id,
    {},
    { status: "cancelled", leaseId: null, leaseUntil: null },
  );
  assert.equal((await f.board.show(f.card.id)).native_execution?.claimProtected, false);
  const run = await f.board.claim(f.card.id, "default", "settled-reclaim");
  assert.notEqual(run.runId, f.run.id);
  assert.equal((await f.board.runHistory(f.card.id)).values.length, 2);
  const old = await f.db.get<AgentTask>("owner", "tasks", f.native.id);
  assert.equal(old?.status, "cancelled");
  assert.equal((await f.board.show(f.card.id)).native_execution, null);
});

test("the actual task worker owns a long card through its native actor lease", async (t) => {
  const f = await assigned(t);
  let executions = 0;
  const worker = new TaskWorker(
    f.db,
    async (_owner, task, context) => {
      executions++;
      assert.ok(task.leaseId);
      const scope = f.worker(task.leaseId);
      f.expireCard();
      await context.guard();
      await f.board.comment(
        scope,
        f.card.id,
        "Long-running source verification.",
        "actual-worker-note",
      );
      await assert.rejects(f.board.claim(f.card.id, "default", "second-worker"), /live|ownership/);
      await f.board.complete(
        scope,
        { summary: "Observed source verification complete." },
        "actual-worker-finish",
      );
      return { status: "succeeded", result: "Observed source verification complete." };
    },
    {
      now: f.now,
      leaseMs: 300000,
      workAdmission: f.agent.workAdmission,
      resourceLeases: f.agent.resourceLeases,
      runtimePause: f.agent.runtimePause,
    },
  );
  try {
    await worker.tick();
  } finally {
    await worker.stop();
  }
  assert.equal(executions, 1);
  assert.equal((await f.agent.getTask("owner", f.native.id)).status, "succeeded");
  assert.equal((await f.board.get(f.card.id)).status, "done");
  assert.equal((await f.board.runHistory(f.card.id)).values.length, 1);
});

test("a deduplicated follow-up acknowledgment still requires the current native actor at commit", async (t) => {
  const f = await assigned(t);
  await f.running();
  const input = { title: "Reusable follow-up", assignee: "default", idempotencyKey: "automation" };
  const child = await f.board.create(f.worker(), input, "child");
  const mutation = f.db.durableMutation.bind(f.db);
  t.mock.method(f.db, "durableMutation", async (...args: Parameters<typeof mutation>) => {
    if (args[1] === "kanban:pipeline:reuse")
      await f.db.compareAndSwapTask("owner", f.native.id, {}, { leaseId: "replacement" });
    return mutation(...args);
  });
  await assert.rejects(
    f.board.create(f.worker(), input, "reuse"),
    /ownership|acknowledgment|Concurrent/,
  );
  assert.deepEqual(await f.board.get(child.id), child);
  assert.equal(await f.db.get("owner", "mutation-receipts", "kanban:pipeline:reuse"), null);
});

for (const changed of ["resumed", "uncertain-effect", "global-pause"] as const) {
  test(`a ${changed} arriving at commit prevents fresh claim or board writes atomically`, async (t) => {
    const f = await assigned(t);
    f.expireCard();
    if (changed === "global-pause") await f.running();
    else
      await f.db.compareAndSwapTask(
        "owner",
        f.native.id,
        {},
        { status: "cancelled", leaseId: null, leaseUntil: null },
      );
    const mutation = f.db.durableMutation.bind(f.db);
    const receipt = `kanban:pipeline:${changed}`;
    t.mock.method(f.db, "durableMutation", async (...args: Parameters<typeof mutation>) => {
      if (args[1] === receipt) {
        if (changed === "resumed")
          await f.db.compareAndSwapTask("owner", f.native.id, {}, { status: "queued" });
        if (changed === "uncertain-effect")
          await f.db.put("owner", "task-operations", {
            id: "uncertain",
            taskId: f.native.id,
            effect: true,
            status: "outcome_unknown",
          });
        if (changed === "global-pause")
          await f.agent.runtimePause.set("owner", { paused: true, expectedRevision: 0 });
      }
      return mutation(...args);
    });
    const before = await f.board.get(f.card.id);
    const action =
      changed === "global-pause"
        ? f.board.comment(f.worker(), f.card.id, "A later pause forbids this fresh note.", changed)
        : f.agent.dispatchKanbanCard("owner", "pipeline", f.card.id, "default", changed);
    await assert.rejects(action, /Concurrent|globally paused|ownership/);
    assert.deepEqual(await f.board.get(f.card.id), before);
    assert.equal((await f.db.list("owner", "tasks")).length, 1);
    assert.equal(await f.db.get("owner", "mutation-receipts", receipt), null);
  });
}
