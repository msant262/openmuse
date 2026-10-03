import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./proactivity-fixture.ts";

test("live routine CRUD requires a timezone at creation and preserves timezone and cadence on a title edit", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    () =>
      f.server.agent.routines.create("local-user", {
        title: "Agenda",
        prompt: "Read my calendar",
        cron: "0 8 * * 1-5",
      }),
    /timezone/i,
  );
  const routine = await f.server.agent.routines.create(
    "local-user",
    { title: "Agenda", prompt: "Read my calendar", cron: "0 8 * * 1-5", timezone: "Europe/Berlin" },
    "weekday-agenda",
  );
  const edited = await f.server.agent.routines.update("local-user", routine.id, {
    title: "Daily agenda",
    expectedRevision: routine.revision,
  });
  assert.equal(edited.timezone, "Europe/Berlin");
  assert.equal(edited.nextRunAt, routine.nextRunAt);
  await assert.rejects(
    () =>
      f.server.agent.routines.update("local-user", routine.id, {
        enabled: false,
        expectedRevision: routine.revision,
      }),
    /changed|revision/,
  );
});

test("a completed human milestone cannot be delegated again or overwritten with a duplicate stage", async (t) => {
  const f = await fixture(t);
  const goal = await f.server.agent.createGoal("local-user", {
    title: "Learn German",
    milestones: ["Choose a course", "Attend a class"],
  });
  const done = await f.server.agent.updateGoal("local-user", goal.id, {
    expectedRevision: goal.revision,
    milestone: { id: goal.milestones[0].id, done: true },
  });
  assert.equal(done.milestones[0].origin?.kind, "user");
  await assert.rejects(
    () =>
      f.server.agent.createTask("local-user", {
        prompt: "Choose a course",
        goalId: goal.id,
        milestoneId: goal.milestones[0].id,
      }),
    /completed|done/i,
  );
  const task = await f.server.agent.createTask("local-user", {
    prompt: "Attend a class",
    goalId: goal.id,
    milestoneId: goal.milestones[1].id,
  });
  const again = await f.server.agent.createTask("local-user", {
    prompt: "Attend a class",
    goalId: goal.id,
    milestoneId: goal.milestones[1].id,
  });
  assert.equal(task.id, again.id);
  assert.equal((await f.server.agent.getGoal("local-user", goal.id)).milestones.length, 2);
  await assert.rejects(
    () =>
      f.server.agent.updateGoal("local-user", goal.id, {
        expectedRevision: goal.revision,
        milestone: { id: goal.milestones[0].id, done: false },
      }),
    /changed|revision/i,
  );
});
