import assert from "node:assert/strict";
import { test } from "node:test";
import { bindingHash } from "../apps/server/src/conversation-inbox.ts";
import { analyzeSpending } from "../apps/server/src/engine/finance.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import { eventDraftSchema } from "../packages/domain/src/index.ts";
import { taskInstant } from "../packages/domain/src/task-time.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("impossible calendar dates and ambiguous financial CSV fail before interpretation", () => {
  assert.equal(
    eventDraftSchema.safeParse({
      title: "Invalid",
      start: "2026-02-30T10:00:00+01:00",
      end: "2026-02-30T11:00:00+01:00",
      timeZone: "Europe/Berlin",
    }).success,
    false,
  );
  assert.throws(
    () =>
      analyzeSpending(
        "date,description,amount,amount,category\n2026-10-01,Coffee,3.00,300.00,Food",
      ),
    /ambiguous|duplicate/i,
  );
});

test("an expired mandatory validity preserves the draft and prevents a new calendar dispatch", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? {
          name: "prepare_event",
          arguments: {
            title: "Too late",
            start: "2026-12-01T10:00:00+01:00",
            end: "2026-12-01T11:00:00+01:00",
          },
        }
      : { name: "ask_user", arguments: { question: "May I send later?" } },
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await server.agent.createTask("owner", {
    prompt: "Create the event only before the specified validity",
    timing: { priority: "normal", validUntil: "2000-01-01T00:00:00Z", timezone: "Europe/Berlin" },
  });
  await server.agent.worker.tick();
  const actions = await server.db.list<{ taskId: string }>("owner", "actions");
  assert.equal(actions.filter((action) => action.taskId === task.id).length, 0);
  const saved = await server.agent.getTask("owner", task.id);
  assert.equal(saved.state.validityExpired, true);
  assert.equal(saved.status, "waiting_input");
});

test("timing edits compare the persisted revision before mutating the task", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", { prompt: "Prepare a report" });
  await assert.rejects(
    () =>
      server.agent.timing.update("owner", task.id, {
        expectedRevision: 9,
        requestId: "wrong-revision",
        priority: "high",
      }),
    /changed/i,
  );
  assert.equal((await server.agent.getTask("owner", task.id)).timing?.priority, "normal");
  await assert.rejects(
    () =>
      server.agent.timing.update("owner", task.id, {
        expectedRevision: 0,
        requestId: "invalid-zone",
        timezone: "Mars/Olympus",
      }),
    /IANA|timezone/i,
  );
});

test("Berlin calendar input rejects impossible and repeated wall times", () => {
  assert.equal(taskInstant("2026-10-02 16:00", "Europe/Berlin"), "2026-10-02T14:00:00.000Z");
  assert.throws(() => taskInstant("2026-02-30 10:00", "Europe/Berlin"), /date|invalid/i);
  assert.throws(() => taskInstant("2026-03-29 02:30", "Europe/Berlin"), /exist|clock/i);
  assert.throws(() => taskInstant("2026-10-25 02:30", "Europe/Berlin"), /offset|ambiguous|twice/i);
});

test("a missed target allows work while a validity edited during resource wait fences it", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", {
    prompt: "Prepare a report",
    timing: { priority: "normal", dueAt: "2000-01-01T00:00:00Z", timezone: "Europe/Berlin" },
  });
  const worker = new TaskWorker(server.db, async (owner, running) => {
    const intent = (id: string) => ({
      id,
      taskId: running.id,
      revision: 0,
      bindingHash: bindingHash({ id }),
      executorId: "vps",
      executorEpoch: 1,
      resourceFence: 0,
      status: "queued" as const,
      toolName: "write_file",
      args: { id },
      effect: true,
      runToken: String(running.leaseId),
      resourceLeaseIds: [],
      createdAt: new Date().toISOString(),
    });
    await server.agent.journal.prepare(owner, intent("before-wait"));
    await server.agent.journal.authorizeDispatch(owner, "before-wait", 0, String(running.leaseId));
    await server.agent.journal.recordReceipt(owner, "before-wait", { saved: true });
    await server.agent.journal.prepare(owner, intent("after-wait"));
    await server.agent.timing.update(owner, running.id, {
      expectedRevision: 0,
      requestId: "validity-during-wait",
      validUntil: "2000-01-01T00:00:00Z",
    });
    await assert.rejects(
      () => server.agent.journal.authorizeDispatch(owner, "after-wait", 0, String(running.leaseId)),
      /validity|expired/i,
    );
    return { status: "waiting_input" };
  });
  t.after(() => worker.stop());
  await worker.tick();
  assert.equal((await server.agent.getTask("owner", task.id)).status, "waiting_input");
  assert.equal(
    (await server.agent.journal.operations("owner", task.id)).find((op) => op.id === "after-wait")
      ?.status,
    "rejected_not_dispatched",
  );
});
