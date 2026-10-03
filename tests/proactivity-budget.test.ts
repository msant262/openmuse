import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./proactivity-fixture.ts";

test("an exhausted review budget publishes partial coverage and leaves the next interval recoverable", async (t) => {
  const f = await fixture(t);
  const cycleId = await f.server.agent.proactivity.scheduleDue("local-user", f.now);
  const cycle = await f.db.get<{ taskId: string }>("local-user", "proactivity-cycles", cycleId!);
  assert.ok(cycle);
  await f.db.compareAndSwap("local-user", "task-budgets", cycle.taskId, {}, { maxSteps: 1 });
  await f.server.agent.worker.tick();
  const result = await f.server.agent.getTask("local-user", cycle.taskId);
  assert.equal(result.status, "succeeded");
  assert.match(result.result ?? "", /partial|budget/i);
  const completed = await f.db.get<{ status: string; coverage: { goals: { complete: boolean } } }>(
    "local-user",
    "proactivity-cycles",
    cycleId!,
  );
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.coverage.goals.complete, false);
  assert.equal(await f.server.agent.proactivity.scheduleDue("local-user", f.now), undefined);
  f.now += 5 * 3600000;
  assert.notEqual(await f.server.agent.proactivity.scheduleDue("local-user", f.now), cycleId);
});
