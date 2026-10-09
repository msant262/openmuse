import assert from "node:assert/strict";
import { test } from "node:test";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const sourceId = "13791504c54d95401dc017968422dd4ebdb13ed77909b94bc1ce1d7587744a0b";
const incorrectId = sourceId.slice(0, -4) + "0a4b";
const method = {
  requestId: "source-reference",
  sourceTaskId: "task_1",
  title: "Read and compare verified sources",
  steps: ["Read the current source and report its observed facts."],
  verification: ["Keep each fact linked to the source actually read."],
  requiredTools: ["web_fetch"],
};
async function verifiedSource(f: Awaited<ReturnType<typeof taskRuntime>>) {
  const task = await f.agent.taskRecord(
    "owner",
    { title: "Read a source", prompt: "Read this source" },
    sourceId,
  );
  await f.db.put("owner", "tasks", {
    ...task,
    status: "succeeded",
    completion: { status: "verified", checks: [], remaining: [] },
  });
  await f.db.put("owner", "task-operations", {
    id: "source-read",
    taskId: sourceId,
    toolName: "web_fetch",
    status: "succeeded",
    receipt: { text: "Observed facts" },
  });
}

test("learning uses short review-local references while storing exact verified provenance", async (t) => {
  const fixture = await modelFixture(t, (i) =>
    i === 0
      ? { name: "learn_procedure", arguments: method }
      : { name: "finish_learning", arguments: { summary: "Saved a reusable method." } },
  );
  const f = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    memoryLearningEnabled: true,
  });
  await verifiedSource(f);
  const reviewId = await f.agent.learning.scheduleDue("owner");
  await f.agent.worker.tick();
  const review = await f.agent.getTask("owner", reviewId!);
  assert.equal(review.status, "succeeded", review.error ?? review.question);
  const saved = (await f.agent.playbooks.catalog("owner", {})).entries[0];
  assert.ok(saved);
  const procedure = await f.agent.playbooks.read("owner", { id: saved.id });
  assert.equal(procedure.sourceTaskId, sourceId);
  assert.deepEqual(procedure.sourceOperationIds, ["source-read"]);
  assert.ok(fixture.requests[0].body.includes("task_1"));
  assert.ok(
    !fixture.requests[0].body.includes(sourceId),
    "long storage IDs are not a copying exercise for the model",
  );
});

test("the corrected reference policy repairs only a proven historical identifier rejection once", async (t) => {
  await modelFixture(t, (i) =>
    i === 0
      ? { name: "learn_procedure", arguments: method }
      : {
          name: "finish_learning",
          arguments: { summary: "Saved the method after reference repair." },
        },
  );
  const f = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    memoryLearningEnabled: true,
  });
  await verifiedSource(f);
  const id = (await f.agent.learning.scheduleDue("owner"))!;
  const original = await f.agent.getTask("owner", id);
  await f.db.put("owner", "tasks", {
    ...original,
    input: { ...original.input, learningReferenceVersion: 0 },
    status: "failed",
    error: "The task's accumulated budget is exhausted.",
    state: {
      ...original.state,
      learningFailures: 3,
      learningWriteErrors: [[`procedure:${incorrectId}`, "Read the current procedure and retry"]],
    },
  });
  await f.db.put("owner", "task-budgets", {
    id,
    revision: 0,
    maxSteps: 24,
    usedSteps: 24,
    maxMilliseconds: 300000,
    usedMilliseconds: 114340,
  });
  await f.db.put("owner", "task-operations", {
    id: "bad-reference",
    taskId: id,
    toolName: "learn_procedure",
    status: "rejected_not_dispatched",
    args: { ...method, sourceTaskId: incorrectId },
    receipt: { error: "Procedure must come from a verified review source", dispatched: false },
  });
  assert.equal(await f.agent.learning.scheduleDue("owner"), id);
  assert.equal((await f.agent.getTask("owner", id)).status, "queued");
  await f.agent.worker.tick();
  assert.equal((await f.agent.getTask("owner", id)).status, "succeeded");
  const budget = await f.db.get<{ usedSteps: number; maxSteps: number }>(
    "owner",
    "task-budgets",
    id,
  );
  assert.ok(budget!.usedSteps > 24, "past usage is retained rather than reset");
  assert.equal(budget!.maxSteps, 48);
  assert.equal(
    (await f.agent.journal.operations("owner", id)).find((o) => o.id === "bad-reference")?.status,
    "rejected_not_dispatched",
  );
});

test("short message references preserve the authenticated quote and original evidence ID", async (t) => {
  const messageId = "4f7fb3a2-dc2e-4d05-b8df-a41090193bf5";
  await modelFixture(t, (i) =>
    i === 0
      ? {
          name: "learn_memory",
          arguments: {
            text: "User prefers quiet hotels.",
            category: "preference",
            evidence: [{ messageId: "message_1", quote: "Prefiro hotéis tranquilos" }],
          },
        }
      : { name: "finish_learning", arguments: { summary: "Saved a sourced preference." } },
  );
  const f = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    memoryLearningEnabled: true,
  });
  await f.db.put("owner", "conversation-inbox", {
    id: `chat:${messageId}`,
    threadId: "chat",
    messageId,
    createdAt: new Date().toISOString(),
    text: "Prefiro hotéis tranquilos.",
    status: "finished",
  });
  const id = await f.agent.learning.scheduleDue("owner");
  await f.agent.worker.tick();
  assert.equal((await f.agent.getTask("owner", id!)).status, "succeeded");
  assert.equal((await f.agent.memory.recall("owner"))[0].evidence?.[0].messageId, messageId);
});

for (const reason of ["new-policy", "real-correction", "uncertain", "cancelled"] as const) {
  test(`reference recovery does not restart ${reason} work or forgive real failed writes`, async (t) => {
    const f = await taskRuntime(t, {
      agentBackend: "model",
      model: "openai/fixture",
      memoryLearningEnabled: true,
    });
    await verifiedSource(f);
    const id = (await f.agent.learning.scheduleDue("owner"))!;
    const original = await f.agent.getTask("owner", id);
    await f.db.put("owner", "tasks", {
      ...original,
      input: { ...original.input, learningReferenceVersion: reason === "new-policy" ? 1 : 0 },
      status: reason === "cancelled" ? "cancelled" : "failed",
      error: "Budget exhausted",
      state: {
        ...original.state,
        learningWriteErrors:
          reason === "real-correction"
            ? [["memory:plan:source", "Memory changed"]]
            : [[`procedure:${incorrectId}`, "Wrong source"]],
      },
    });
    await f.db.put("owner", "task-budgets", {
      id,
      revision: 0,
      maxSteps: 24,
      usedSteps: 24,
      maxMilliseconds: 300000,
      usedMilliseconds: 100000,
    });
    await f.db.put("owner", "task-operations", {
      id: "bad-reference",
      taskId: id,
      toolName: "learn_procedure",
      status: reason === "uncertain" ? "outcome_unknown" : "rejected_not_dispatched",
      args: { ...method, sourceTaskId: incorrectId },
      receipt: { error: "Procedure must come from a verified review source", dispatched: false },
    });
    await f.agent.learning.scheduleDue("owner");
    assert.equal(
      (await f.agent.getTask("owner", id)).status,
      reason === "cancelled" ? "cancelled" : "failed",
    );
    assert.equal((await f.db.get<{ maxSteps: number }>("owner", "task-budgets", id))?.maxSteps, 24);
    if (reason !== "cancelled")
      assert.equal((await f.agent.learning.status("owner")).lastError, "Budget exhausted");
  });
}
