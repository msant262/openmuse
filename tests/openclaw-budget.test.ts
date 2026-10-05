import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import type { TaskBudget } from "../packages/domain/src/runtime.ts";

test("automatic task accounting continues past 96 steps and six accumulated hours", async () => {
  const db = await createStore();
  try {
    for (let step = 0; step < 110; step++)
      assert.ok(await db.consumeTaskBudget("owner", "research", 300000));
    const budget = await db.get<TaskBudget>("owner", "task-budgets", "research");
    assert.equal(budget?.maxSteps, null);
    assert.equal(budget?.maxMilliseconds, null);
    assert.equal(budget?.usedSteps, 110);
    assert.equal(budget?.usedMilliseconds, 33000000);
  } finally {
    await db.close();
  }
});

test("restart removes only legacy automatic limits and preserves explicit budget revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "okami-budget-migration-"));
  let db = await createStore({ dataDir: directory });
  try {
    for (const [id, revision] of [
      ["automatic", 0],
      ["explicit", 1],
    ] as const)
      await db.put("owner", "task-budgets", {
        id,
        revision,
        maxSteps: 96,
        usedSteps: 95,
        maxMilliseconds: 21600000,
        usedMilliseconds: 20000000,
      });
    await db.close();
    db = await createStore({ dataDir: directory });
    const automatic = await db.get<TaskBudget>("owner", "task-budgets", "automatic");
    const explicit = await db.get<TaskBudget>("owner", "task-budgets", "explicit");
    assert.equal(automatic?.maxSteps, null);
    assert.equal(automatic?.maxMilliseconds, null);
    assert.equal(automatic?.usedSteps, 95);
    assert.equal(explicit?.maxSteps, 96);
    assert.equal(explicit?.maxMilliseconds, 21600000);
    assert.ok(await db.consumeTaskBudget("owner", "automatic", 0));
    assert.ok(await db.consumeTaskBudget("owner", "automatic", 0));
    assert.ok(await db.consumeTaskBudget("owner", "explicit", 0));
    assert.equal(await db.consumeTaskBudget("owner", "explicit", 0), null);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
