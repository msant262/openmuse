import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { ProactivitySuggestion } from "../packages/domain/src/proactivity.ts";
import type { InteractionRequest } from "../packages/domain/src/runtime.ts";
import { fixture, review } from "./proactivity-fixture.ts";

test("Continue reuses a supported goalId-only plan and preserves its progress, budget and stable link after restart", async (t) => {
  const f = await fixture(t);
  const goal = await f.server.agent.createGoal("local-user", { title: "Plan my holiday" });
  const original = await f.server.agent.createTask("local-user", {
    kind: "plan",
    prompt: "Plan my holiday",
    goalId: goal.id,
  });
  await f.db.compareAndSwap(
    "local-user",
    "tasks",
    original.id,
    {},
    { state: { ...original.state, savedProgress: "existing itinerary" } },
  );
  await f.db.put("local-user", "task-budgets", {
    id: original.id,
    revision: 0,
    maxSteps: 96,
    usedSteps: 7,
    maxMilliseconds: 21600000,
    usedMilliseconds: 3000,
  });
  await f.server.agent.control("local-user", original.id, "pause");
  const s = (await review(f)).find((s) => s.target.kind === "goal" && s.target.goalId === goal.id)!;
  assert.equal(s.target.kind === "goal" && s.target.taskId, original.id);
  const body = {
    requestId: s.requestId,
    clientResponseId: "existing-goal-plan",
    expectedRevision: s.revision,
    action: "continue" as const,
  };
  const result = await f.server.agent.proactivity.respond("local-user", s.id, body);
  assert.equal(result.task?.id, original.id);
  assert.equal(result.task?.state.savedProgress, "existing itinerary");
  const linkedGoal = await f.server.agent.getGoal("local-user", goal.id);
  assert.equal(linkedGoal.milestones.length, 1);
  assert.equal(linkedGoal.milestones[0].taskId, original.id);
  assert.ok(linkedGoal.milestones[0].id);
  await f.restart();
  const retry = await f.server.agent.proactivity.respond("local-user", s.id, body);
  assert.equal(retry.task?.id, original.id);
  assert.equal(
    (await f.db.list<AgentTask>("local-user", "tasks")).filter((task) => task.goalId === goal.id)
      .length,
    1,
  );
  assert.equal(
    (await f.db.get<{ usedSteps: number }>("local-user", "task-budgets", original.id))?.usedSteps,
    7,
  );
  await f.server.agent.proactivity.revalidateTask("local-user", retry.task!);
});

test("an older planning card without a task ID resolves the one existing legacy goal plan on acceptance", async (t) => {
  const f = await fixture(t);
  const goal = await f.server.agent.createGoal("local-user", { title: "Plan the move" });
  const s = (await review(f)).find((s) => s.target.kind === "goal")!;
  const legacy = await f.server.agent.taskRecord(
    "local-user",
    { kind: "plan", prompt: "Existing moving plan", goalId: goal.id },
    "legacy-plan",
    true,
  );
  await f.db.insertIfAbsent("local-user", "tasks", legacy);
  assert.equal(s.target.kind === "goal" && s.target.taskId, undefined);
  const result = await f.server.agent.proactivity.respond("local-user", s.id, {
    requestId: s.requestId,
    clientResponseId: "legacy-goal-plan",
    expectedRevision: s.revision,
    action: "continue",
  });
  assert.equal(result.task?.id, legacy.id);
  assert.equal(
    (await f.server.agent.getGoal("local-user", goal.id)).milestones[0].taskId,
    legacy.id,
  );
  assert.equal(
    (await f.db.list<AgentTask>("local-user", "tasks")).filter((task) => task.goalId === goal.id)
      .length,
    1,
  );
});

test("ambiguous goalId-only plans are neither selected arbitrarily nor duplicated by an older card", async (t) => {
  const f = await fixture(t);
  const goal = await f.server.agent.createGoal("local-user", { title: "Plan conference" });
  const first = await f.server.agent.createTask(
    "local-user",
    { kind: "plan", prompt: "Conference plan", goalId: goal.id },
    "conference-first",
    true,
  );
  const s = (await review(f)).find((s) => s.target.kind === "goal")!;
  const second = await f.server.agent.taskRecord(
    "local-user",
    { kind: "plan", prompt: "Another old conference plan", goalId: goal.id },
    "conference-second",
    true,
  );
  await f.db.insertIfAbsent("local-user", "tasks", second);
  // Simulate a pre-M11 card that predates explicit task links.
  const oldTarget = {
    kind: "goal" as const,
    goalId: goal.id,
    revision: (await f.server.agent.getGoal("local-user", goal.id)).revision!,
  };
  await f.db.compareAndSwap<ProactivitySuggestion>(
    "local-user",
    "proactivity-suggestions",
    s.id,
    {},
    { target: oldTarget },
  );
  const request = await f.db.get<InteractionRequest>(
    "local-user",
    "interaction-requests",
    s.requestId,
  );
  await f.db.compareAndSwap(
    "local-user",
    "interaction-requests",
    s.requestId,
    {},
    { suggestion: { ...request!.suggestion, target: oldTarget } },
  );
  const result = await f.server.agent.proactivity.respond("local-user", s.id, {
    requestId: s.requestId,
    clientResponseId: "ambiguous-goal-plan",
    expectedRevision: s.revision,
    action: "continue",
  });
  assert.equal(result.suggestion.status, "obsolete");
  assert.equal(result.task, undefined);
  assert.match(result.message ?? "", /multiple|ambiguous|existing/i);
  assert.deepEqual(
    (await f.db.list<AgentTask>("local-user", "tasks"))
      .filter((task) => task.goalId === goal.id)
      .map((task) => task.id)
      .sort(),
    [first.id, second.id].sort(),
  );
  f.now += 5 * 3600000;
  const next = await review(f, f.now);
  assert.equal(
    next.some(
      (card) =>
        card.target.kind === "goal" && card.target.goalId === goal.id && card.status === "pending",
    ),
    false,
  );
});

test("concurrent goalId-only task creation invalidates a prepared acceptance instead of inserting another plan", async (t) => {
  const f = await fixture(t);
  const goal = await f.server.agent.createGoal("local-user", { title: "Plan a course" });
  const s = (await review(f)).find((s) => s.target.kind === "goal")!;
  const mutate = f.db.durableMutation.bind(f.db);
  let reached!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(f.db, "durableMutation", async (...args: Parameters<typeof mutate>) => {
    if (args[1] === "proactivity-answer:concurrent-goal-plan") {
      reached();
      await barrier;
    }
    return mutate(...args);
  });
  const accepting = f.server.agent.proactivity.respond("local-user", s.id, {
    requestId: s.requestId,
    clientResponseId: "concurrent-goal-plan",
    expectedRevision: s.revision,
    action: "start",
  });
  await started;
  const existing = await f.server.agent.createTask(
    "local-user",
    { kind: "plan", prompt: "Explicitly created course plan", goalId: goal.id },
    "concurrent-existing-plan",
    true,
  );
  release();
  await assert.rejects(accepting, /changed|revision/i);
  assert.deepEqual(
    (await f.db.list<AgentTask>("local-user", "tasks"))
      .filter((task) => task.goalId === goal.id)
      .map((task) => task.id),
    [existing.id],
  );
});
