import assert from "node:assert/strict";
import { test } from "node:test";
import type { Goal } from "../packages/domain/src/agent.ts";
import { fixture, review } from "./proactivity-fixture.ts";

test("accept retry, double tap and lost ACK across restart bind one existing goal and task", async (t) => {
  const f = await fixture(t);
  const goal = await f.server.agent.createGoal("local-user", {
    title: "Learn German",
    milestones: ["Choose a course"],
  });
  const suggestions = await review(f);
  const s = suggestions.find((s) => s.target.kind === "goal" && s.target.goalId === goal.id)!;
  assert.ok(s);
  const body = {
    requestId: s.requestId,
    clientResponseId: "tap-one",
    expectedRevision: s.revision,
    action: "start" as const,
  };
  const results = await Promise.all([
    f.server.agent.proactivity.respond("local-user", s.id, body),
    f.server.agent.proactivity.respond("local-user", s.id, body),
  ]);
  assert.equal(results[0].task?.id, results[1].task?.id);
  assert.equal(results[0].task?.status, "queued");
  await f.restart();
  const replay = await f.server.agent.proactivity.respond("local-user", s.id, body);
  assert.equal(replay.task?.id, results[0].task?.id);
  const double = await f.server.agent.proactivity.respond("local-user", s.id, {
    ...body,
    clientResponseId: "tap-two",
  });
  assert.equal(double.task?.id, replay.task?.id);
  assert.equal((await f.db.list<Goal>("local-user", "goals")).length, 1);
  const current = (await f.db.get<Goal>("local-user", "goals", goal.id))!;
  assert.equal(current.milestones.length, 1);
  assert.equal(current.milestones[0].taskId, replay.task?.id);
  assert.equal(current.milestones[0].done, false);
  await assert.rejects(
    () => f.server.agent.proactivity.respond("local-user", s.id, { ...body, action: "dismiss" }),
    /different|another|conflict/i,
  );
});

test("snooze, user resolution and persistent suppression survive restart without another notification", async (t) => {
  const f = await fixture(t);
  const goal = await f.server.agent.createGoal("local-user", { title: "Plan a holiday" });
  const suggestions = await review(f);
  const s = suggestions.find((s) => s.target.kind === "goal" && s.target.goalId === goal.id)!;
  const until = new Date(Date.now() + 24 * 3600000).toISOString();
  await f.server.agent.proactivity.respond("local-user", s.id, {
    requestId: s.requestId,
    clientResponseId: "snooze-one",
    expectedRevision: s.revision,
    action: "snooze",
    snoozeUntil: until,
  });
  await f.restart();
  f.now += 5 * 3600000;
  await f.server.agent.proactivity.scheduleDue("local-user", f.now);
  await f.server.agent.worker.tick();
  const snoozed = (await f.server.agent.proactivity.list("local-user")).find((x) => x.id === s.id)!;
  assert.equal(snoozed.status, "snoozed");
  assert.equal(snoozed.snoozeUntil, until);
  const mail = (await f.server.agent.proactivity.list("local-user")).find(
    (x) => x.target.kind === "mail",
  )!;
  await f.server.agent.proactivity.respond("local-user", mail.id, {
    requestId: mail.requestId,
    clientResponseId: "dismiss-one",
    expectedRevision: mail.revision,
    action: "dismiss",
  });
  await f.restart();
  f.now += 30 * 3600000;
  await f.server.agent.proactivity.scheduleDue("local-user", f.now);
  await f.server.agent.worker.tick();
  assert.equal(
    (await f.server.agent.proactivity.list("local-user")).find((x) => x.id === mail.id)?.status,
    "suppressed",
  );
  const reopened = (await f.server.agent.proactivity.list("local-user")).find(
    (x) => x.id === s.id,
  )!;
  await f.server.agent.proactivity.respond("local-user", s.id, {
    requestId: reopened.requestId,
    clientResponseId: "resolved-one",
    expectedRevision: reopened.revision,
    action: "resolved",
  });
  assert.equal((await f.db.get<Goal>("local-user", "goals", goal.id))?.status, "completed");
  assert.equal((await f.db.get<Goal>("local-user", "goals", goal.id))?.origin?.kind, "user");
  const count = (await f.db.list("local-user", "notifications")).length;
  await f.server.agent.proactivity.flushPublications();
  await f.server.agent.proactivity.flushPublications();
  assert.equal((await f.db.list("local-user", "notifications")).length, count);
});
