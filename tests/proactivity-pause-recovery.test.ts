import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, message } from "./proactivity-fixture.ts";

test("a paused review preserves its cursor but refreshes mail evidence after restart", async (t) => {
  const f = await fixture(t);
  const original = f.server.workspace.proactivityThread.bind(f.server.workspace);
  let reached!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  t.mock.method(
    f.server.workspace,
    "proactivityThread",
    async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      reached();
      await gate;
      return result;
    },
  );
  const cycleId = await f.server.agent.proactivity.scheduleDue("local-user", f.now);
  const cycle = await f.db.get<{ taskId: string }>("local-user", "proactivity-cycles", cycleId!);
  const tick = f.server.agent.worker.tick();
  await started;
  await f.server.agent.setRuntimePause("local-user", { paused: true, expectedRevision: 0 });
  release();
  await tick;
  assert.equal(
    (await f.server.agent.getTask("local-user", cycle!.taskId)).status,
    "waiting_global_pause",
  );
  assert.ok(
    (await f.db.get<{ cursor?: string }>("local-user", "proactivity-cycles", cycleId!))?.cursor,
  );
  assert.equal((await f.server.agent.proactivity.list("local-user")).length, 0);
  f.source.messages.push(message("while-paused", "Already replied while the VPS was paused", true));
  await f.restart();
  assert.equal(await f.server.agent.proactivity.scheduleDue("local-user", f.now), undefined);
  await f.server.agent.setRuntimePause("local-user", { paused: false, expectedRevision: 1 });
  assert.equal(await f.server.agent.proactivity.scheduleDue("local-user", f.now), cycleId);
  await f.server.agent.worker.tick();
  assert.equal((await f.server.agent.getTask("local-user", cycle!.taskId)).status, "succeeded");
  assert.equal(
    (await f.server.agent.proactivity.list("local-user")).filter((s) => s.target.kind === "mail")
      .length,
    0,
  );
  assert.equal((await f.db.list("local-user", "tasks")).length, 1);
});
