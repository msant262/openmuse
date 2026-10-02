import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";

function queued(
  id: string,
  now: number,
  priority: "low" | "normal" | "high",
  dueAt?: string,
): AgentTask {
  const timestamp = new Date(now).toISOString();
  return {
    id,
    title: id,
    prompt: id,
    kind: "agent",
    status: "queued",
    timing: { priority, dueAt },
    plan: [],
    evidence: [],
    input: {},
    state: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    attempts: 0,
    leaseId: null,
    leaseUntil: null,
    artifactIds: [],
  };
}

test("priority, due time and aging order the next claim without interrupting running work", async () => {
  const db = await createStore();
  const now = Date.parse("2026-10-02T10:00:00.000Z");
  const dueSoon = new Date(now + 30 * 60_000).toISOString();
  const dueLater = new Date(now + 60 * 60_000).toISOString();
  const agedLow = queued("aged-low", now - 15 * 60_000, "low", dueLater);
  agedLow.updatedAt = new Date(now).toISOString();
  await db.put("owner", "tasks", agedLow);
  await db.put("owner", "tasks", queued("high-later", now, "high", dueLater));
  await db.put("owner", "tasks", queued("high-soon", now, "high", dueSoon));
  await db.put("owner", "tasks", queued("normal", now, "normal", dueSoon));

  const starts: string[] = [];
  const worker = new TaskWorker(
    db,
    async (_owner, task) => {
      starts.push(task.id);
      return { status: "succeeded" };
    },
    { now: () => now },
  );
  try {
    await worker.tick();
    assert.deepEqual(starts, ["aged-low", "high-soon", "high-later", "normal"]);
  } finally {
    await worker.stop();
    await db.close();
  }
});
