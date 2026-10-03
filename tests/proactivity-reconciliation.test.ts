import assert from "node:assert/strict";
import { test } from "node:test";
import { bindingHash } from "../apps/server/src/conversation-inbox.ts";
import { fixture, message, review } from "./proactivity-fixture.ts";

test("a changed source allows existing physical cleanup to reconcile before blocking new work", async (t) => {
  const f = await fixture(t);
  const s = (await review(f)).find((s) => s.target.kind === "mail");
  assert.ok(s);
  const accepted = await f.server.agent.proactivity.respond("local-user", s.id, {
    requestId: s.requestId,
    clientResponseId: "reconcile-first",
    expectedRevision: s.revision,
    action: "start",
  });
  assert.ok(accepted.task);
  const task = accepted.task;
  await f.db.compareAndSwap(
    "local-user",
    "tasks",
    task.id,
    {},
    { state: { ...task.state, nativeCleanupPending: true } },
  );
  await f.db.put("local-user", "task-operations", {
    id: "existing-physical-receipt",
    taskId: task.id,
    revision: 0,
    bindingHash: bindingHash({ fixture: "cleanup" }),
    executorId: "fixture",
    executorEpoch: 1,
    resourceFence: 0,
    status: "succeeded",
    toolName: "computer_command",
    args: {},
    effect: true,
    runToken: "original-run",
    resourceLeaseIds: [],
    createdAt: new Date().toISOString(),
    nativeEnvelope: { fixture: true },
    receipt: { data: { cleanupConfirmed: true } },
  });
  f.source.messages.push(message("reconciled-reply", "Already answered", true));
  await f.server.agent.worker.tick();
  const current = await f.server.agent.getTask("local-user", task.id);
  assert.equal(current.state.nativeCleanupPending, false);
  assert.equal(current.status, "waiting_input");
  assert.match(current.question ?? "", /answered|changed/);
  assert.equal(f.source.writes, 0);
});
