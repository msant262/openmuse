import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";
import { GoogleClient } from "../packages/integrations/src/google.ts";
import { fixture, message, review } from "./proactivity-fixture.ts";

test("Continue keeps its original task, budget and progress and delivers one M4 mailbox direction", async (t) => {
  const f = await fixture(t);
  const goal = await f.server.agent.createGoal("local-user", {
    title: "Prepare report",
    milestones: ["Draft report"],
  });
  const task = await f.server.agent.createTask("local-user", {
    prompt: "Draft the report",
    goalId: goal.id,
    milestoneId: goal.milestones[0].id,
  });
  await f.db.compareAndSwap(
    "local-user",
    "tasks",
    task.id,
    {},
    { state: { ...task.state, savedProgress: "existing outline" } },
  );
  await f.db.put("local-user", "task-budgets", {
    id: task.id,
    revision: 0,
    maxSteps: 96,
    usedSteps: 3,
    maxMilliseconds: 21600000,
    usedMilliseconds: 5000,
  });
  await f.server.agent.control("local-user", task.id, "pause");
  const s = (await review(f)).find((s) => s.target.kind === "goal" && s.target.taskId === task.id)!;
  assert.ok(s);
  const body = {
    requestId: s.requestId,
    clientResponseId: "continue-one",
    expectedRevision: s.revision,
    action: "continue" as const,
  };
  const result = await f.server.agent.proactivity.respond("local-user", s.id, body);
  assert.equal(result.task?.id, task.id);
  assert.equal((await f.server.agent.mailbox.list("local-user", task.id)).length, 1);
  for (let i = 0; i < 100; i++) {
    const receipt = await f.db.get<{ status: string }>(
      "local-user",
      "conversation-inbox",
      `chat:proactivity-${s.requestId}`,
    );
    if (receipt?.status === "finished") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(
    (
      await f.db.get<{ status: string }>(
        "local-user",
        "conversation-inbox",
        `chat:proactivity-${s.requestId}`,
      )
    )?.status,
    "finished",
  );
  await f.restart();
  await f.server.agent.proactivity.respond("local-user", s.id, body);
  assert.equal((await f.server.agent.mailbox.list("local-user", task.id)).length, 1);
  assert.equal((await f.server.agent.getTask("local-user", task.id)).state.desiredRevision, 1);
  assert.equal(
    (await f.server.agent.getTask("local-user", task.id)).state.savedProgress,
    "existing outline",
  );
  assert.equal(
    (await f.db.get<{ usedSteps: number }>("local-user", "task-budgets", task.id))?.usedSteps,
    3,
  );
});

test("concurrent human completion wins over an acceptance prepared against an earlier goal revision", async (t) => {
  const f = await fixture(t);
  const goal = await f.server.agent.createGoal("local-user", {
    title: "Learn German",
    milestones: ["Choose a course"],
  });
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
    if (args[1] === "proactivity-answer:race") {
      reached();
      await barrier;
    }
    return mutate(...args);
  });
  const pending = f.server.agent.proactivity.respond("local-user", s.id, {
    requestId: s.requestId,
    clientResponseId: "race",
    expectedRevision: s.revision,
    action: "start",
  });
  await started;
  await f.server.agent.updateGoal("local-user", goal.id, {
    expectedRevision: goal.revision,
    milestone: { id: goal.milestones[0].id, done: true },
  });
  release();
  await assert.rejects(() => pending, /changed|revision/);
  assert.equal(
    (await f.server.agent.getGoal("local-user", goal.id)).milestones[0].origin?.kind,
    "user",
  );
  assert.equal((await f.db.list("local-user", "tasks")).length, 1);
});

test("the final Google write callback rechecks sent replies after token preparation", async (t) => {
  const f = await fixture(t);
  const s = (await review(f)).find((s) => s.target.kind === "mail")!;
  const accepted = await f.server.agent.proactivity.respond("local-user", s.id, {
    requestId: s.requestId,
    clientResponseId: "callback-accept",
    expectedRevision: s.revision,
    action: "start",
  });
  assert.ok(accepted.task);
  t.mock.method(
    f.server.workspace,
    "google",
    (
      _owner: string,
      _connectionId?: string,
      signal?: AbortSignal,
      beforeWrite?: () => Promise<void>,
    ) =>
      new GoogleClient({
        signal,
        beforeWrite,
        fetch: globalThis.fetch,
        getAccessToken: async () => {
          if (beforeWrite && !f.source.messages.some((m) => m.id === "human-final"))
            f.source.messages.push(message("human-final", "I already answered", true));
          return "fixture-access";
        },
      }),
  );
  let action: ActionProposal | undefined;
  const worker = new TaskWorker(f.db, async (owner, task) => {
    action = await f.server.actions.propose(
      owner,
      {
        kind: "email.send",
        data: {
          to: ["jamie@example.com"],
          subject: "Re: Coffee this week?",
          body: "Fixture reply",
          attachmentIds: [],
          threadId: "thread-one",
          replyToMessageId: "incoming",
        },
      },
      "callback-race",
      task.id,
    );
    return { status: "waiting_input" };
  });
  t.after(() => worker.stop());
  await worker.tick();
  assert.equal(action?.status, "failed");
  assert.match(action?.error ?? "", /answered|changed/);
  assert.ok(
    f.source.messages.some((m) => m.id === "human-final"),
    "the race reached token preparation for the concrete Google adapter",
  );
  assert.equal(f.source.writes, 0);
});
