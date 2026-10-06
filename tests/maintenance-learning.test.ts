import assert from "node:assert/strict";
import test from "node:test";
import { messageContentHash } from "../apps/server/src/conversation-inbox.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("removed work cannot stop automatic memory review or become new learning evidence", async (t) => {
  await modelFixture(t, (i) =>
    i === 0
      ? {
          name: "learn_memory",
          arguments: {
            text: "User prefers quiet hotels.",
            category: "preference",
            evidence: [{ messageId: "quiet", quote: "Prefiro hotéis tranquilos" }],
          },
        }
      : { name: "finish_learning", arguments: { summary: "Saved the sourced preference." } },
  );
  const f = await taskRuntime(t, {
    mode: "live",
    agentBackend: "model",
    model: "openai/fixture",
    memoryLearningEnabled: true,
    proactivityEnabled: false,
    taskWorkerEnabled: false,
  });
  await f.agent.ensure("owner");
  const removed = await f.agent.createTask("owner", { prompt: "Old completed work" });
  await f.db.put("owner", "tasks", {
    ...removed,
    status: "succeeded",
    completion: { status: "verified", checks: [], remaining: [] },
  });
  await f.agent.removeTask("owner", removed.id);
  await f.agent.playbooks.recordOutcome("owner", removed.id);
  const source = {
    threadId: "chat",
    clientMessageId: "quiet",
    text: "Prefiro hotéis tranquilos, longe de festas.",
    attachmentIds: [],
    annotations: [],
  };
  await f.db.put("owner", "conversation-inbox", {
    ...source,
    id: "chat:quiet",
    messageId: "quiet",
    runId: "quiet-run",
    createdAt: new Date().toISOString(),
    contentHash: messageContentHash(source),
    status: "finished",
  });
  assert.ok(!(await f.db.learningCandidates("owner")).some((s) => s.value.id === removed.id));
  await (f.agent as unknown as { maintain(): Promise<void> }).maintain();
  const scheduled = await f.agent.learning.status("owner");
  assert.ok(scheduled.activeTask);
  await f.agent.worker.tick();
  const memories = await f.agent.memory.recall("owner");
  assert.equal(memories.length, 1);
  assert.equal(memories[0].evidence?.[0].messageId, "quiet");
  assert.match(await f.agent.memory.context("owner", "Where should I stay?"), /quiet hotels/);
});

test("removed work cannot stop the due proactive cycle", async (t) => {
  const f = await taskRuntime(t, {
    mode: "live",
    proactivityEnabled: true,
    taskWorkerEnabled: false,
  });
  await f.agent.ensure("owner");
  const removed = await f.agent.createTask("owner", { prompt: "Removed work" });
  await f.agent.control("owner", removed.id, "cancel");
  await f.agent.removeTask("owner", removed.id);
  await (f.agent as unknown as { maintain(): Promise<void> }).maintain();
  assert.ok((await f.agent.proactivity.status("owner")).activeCycleId);
  assert.equal(
    (await f.db.get<{ deletedAt?: string }>("owner", "tasks", removed.id))?.deletedAt !== undefined,
    true,
  );
});

test("a source removed after scheduling retires its review without inference and lets real learning continue", async (t) => {
  const fixture = await modelFixture(t, () => ({
    name: "finish_learning",
    arguments: { summary: "Only a greeting." },
  }));
  const f = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    memoryLearningEnabled: true,
  });
  const source = await f.agent.createTask("owner", { prompt: "A test query" });
  await f.db.put("owner", "tasks", {
    ...source,
    status: "succeeded",
    completion: { status: "verified", checks: [], remaining: [] },
  });
  const id = await f.agent.learning.scheduleDue("owner");
  assert.ok(id);
  await f.agent.removeTask("owner", source.id);
  await f.agent.worker.tick();
  const review = await f.agent.getTask("owner", id);
  assert.equal(review.status, "succeeded");
  assert.deepEqual(review.state.learningRetiredSources, [{ kind: "tasks", id: source.id }]);
  assert.equal(fixture.requests.length, 0, "removed evidence must not be sent to the model");
  assert.equal(await f.agent.learning.scheduleDue("owner"), undefined);
  assert.equal(await f.agent.learning.settled("owner"), true);
});

test("a historical failed review of removed work recovers without dropping a valid pending correction", async (t) => {
  const f = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    memoryLearningEnabled: true,
  });
  const source = await f.agent.createTask("owner", { prompt: "Developer test" });
  await f.db.put("owner", "tasks", {
    ...source,
    status: "succeeded",
    completion: { status: "verified", checks: [], remaining: [] },
  });
  const id = await f.agent.learning.scheduleDue("owner");
  assert.ok(id);
  const review = await f.agent.getTask("owner", id);
  await f.db.put("owner", "tasks", {
    ...review,
    status: "failed",
    error: "A resposta do chatgpt foi interrompida.",
    state: {
      ...review.state,
      learningFailures: 2,
      learningWriteErrors: [[`procedure:${source.id}`, "Task not found"]],
    },
  });
  await f.agent.removeTask("owner", source.id);
  assert.equal(await f.agent.learning.scheduleDue("owner"), id);
  assert.equal((await f.agent.getTask("owner", id)).status, "queued");
  await f.agent.worker.tick();
  const retired = await f.agent.getTask("owner", id);
  assert.equal(retired.status, "succeeded");
  assert.deepEqual(retired.state.learningWriteErrors, []);
  assert.deepEqual(retired.state.learningRetiredSources, [{ kind: "tasks", id: source.id }]);
  await f.agent.learning.scheduleDue("owner");
  assert.equal(await f.agent.learning.settled("owner"), true);
});

test("removing a source during inference defers learning instead of attempting an impossible procedure write", async (t) => {
  let remove: () => Promise<unknown> = async () => {};
  const fixture = await modelFixture(t, async () => {
    await remove();
    return { name: "finish_learning", arguments: { summary: "No reusable procedure." } };
  });
  const f = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    memoryLearningEnabled: true,
  });
  const source = await f.agent.createTask("owner", { prompt: "Test source" });
  await f.db.put("owner", "tasks", {
    ...source,
    status: "succeeded",
    completion: { status: "verified", checks: [], remaining: [] },
  });
  const id = await f.agent.learning.scheduleDue("owner");
  assert.ok(id);
  remove = () => f.agent.removeTask("owner", source.id);
  await f.agent.worker.tick();
  assert.equal((await f.agent.getTask("owner", id)).status, "scheduled");
  await f.db.compareAndSwapTask(
    "owner",
    id,
    { status: "scheduled" },
    { nextRunAt: new Date(0).toISOString() },
  );
  await f.agent.worker.tick();
  assert.equal((await f.agent.getTask("owner", id)).status, "succeeded");
  assert.equal(fixture.requests.length, 1);
  assert.equal((await f.agent.journal.operations("owner", id)).length, 0);
});
