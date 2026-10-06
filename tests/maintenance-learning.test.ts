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
