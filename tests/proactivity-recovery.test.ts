import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./proactivity-fixture.ts";

test("a cancelled review does not permanently strand the heartbeat after restart", async (t) => {
  const f = await fixture(t);
  const first = await f.server.agent.proactivity.scheduleDue("local-user", f.now);
  const cycle = await f.db.get<{ taskId: string }>("local-user", "proactivity-cycles", first!);
  await f.server.agent.control("local-user", cycle!.taskId, "cancel");
  await f.restart();
  f.now += 5 * 3600000;
  const next = await f.server.agent.proactivity.scheduleDue("local-user", f.now);
  assert.ok(next);
  assert.notEqual(next, first);
  assert.equal(
    (await f.db.get<{ status: string }>("local-user", "proactivity-cycles", first!))?.status,
    "completed",
  );
  assert.equal((await f.db.list("local-user", "tasks")).length, 2);
  assert.equal(await f.server.agent.proactivity.scheduleDue("local-user", f.now), next);
});
