import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";
import { GoogleClient } from "../packages/integrations/src/google.ts";
import { fixture, message, review } from "./proactivity-fixture.ts";

async function waitForChildren(
  f: Awaited<ReturnType<typeof fixture>>,
  parent: AgentTask,
  child: AgentTask,
) {
  await f.db.compareAndSwap(
    "local-user",
    "tasks",
    parent.id,
    {},
    {
      status: "waiting_children",
      state: { ...parent.state, waitingChildIds: [child.id] },
    },
  );
}
const reply = {
  kind: "email.send" as const,
  data: {
    to: ["jamie@example.com"],
    subject: "Re: Coffee this week?",
    body: "Synthetic delegated reply",
    attachmentIds: [],
    threadId: "thread-one",
    replyToMessageId: "incoming",
  },
};

test("delegated descendants retain current mail authority across restart and cannot send after a human reply", async (t) => {
  const f = await fixture(t);
  const s = (await review(f)).find((s) => s.target.kind === "mail")!;
  const { task: parent } = await f.server.agent.proactivity.respond("local-user", s.id, {
    requestId: s.requestId,
    clientResponseId: "delegated-parent",
    expectedRevision: s.revision,
    action: "start",
  });
  assert.ok(parent);
  const child = await f.server.agent.createChildTask(
    "local-user",
    parent,
    { prompt: "Prepare the selected reply" },
    "delegated-child",
  );
  const descendant = await f.server.agent.createChildTask(
    "local-user",
    child,
    { prompt: "Send the selected reply" },
    "delegated-descendant",
  );
  await waitForChildren(f, parent, child);
  await waitForChildren(f, child, descendant);
  await f.server.agent.proactivity.revalidateTask("local-user", descendant);
  await f.restart();
  f.source.messages.push(message("delegated-human-sent", "Already answered this request", true));
  let action: ActionProposal | undefined;
  const seen: string[] = [];
  const worker = new TaskWorker(f.db, async (owner, task) => {
    seen.push(task.id);
    action = await f.server.actions.propose(owner, reply, "delegated-effect", task.id);
    return { status: "waiting_input" };
  });
  t.after(() => worker.stop());
  await worker.tick();
  assert.deepEqual(seen, [descendant.id]);
  assert.equal(action?.status, "failed");
  assert.match(action?.error ?? "", /answered|changed/);
  assert.equal(f.source.writes, 0);
  await assert.rejects(
    () => f.server.agent.proactivity.revalidateTask("local-user", descendant),
    /answered|changed/,
  );
});

test("a delegated reply reaches the concrete Google callback and rechecks the ancestor after token preparation", async (t) => {
  const f = await fixture(t);
  const s = (await review(f)).find((s) => s.target.kind === "mail")!;
  const { task: parent } = await f.server.agent.proactivity.respond("local-user", s.id, {
    requestId: s.requestId,
    clientResponseId: "delegated-callback-parent",
    expectedRevision: s.revision,
    action: "start",
  });
  assert.ok(parent);
  const child = await f.server.agent.createChildTask(
    "local-user",
    parent,
    { prompt: "Send the selected reply" },
    "delegated-callback-child",
  );
  await waitForChildren(f, parent, child);
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
          if (beforeWrite && !f.source.messages.some((m) => m.id === "delegated-final-human"))
            f.source.messages.push(message("delegated-final-human", "Already answered", true));
          return "fixture-access";
        },
      }),
  );
  let action: ActionProposal | undefined;
  const worker = new TaskWorker(f.db, async (owner, task) => {
    action = await f.server.actions.propose(owner, reply, "delegated-callback-effect", task.id);
    return { status: "waiting_input" };
  });
  t.after(() => worker.stop());
  await worker.tick();
  assert.ok(
    f.source.messages.some((m) => m.id === "delegated-final-human"),
    "the concrete adapter reached token preparation",
  );
  assert.equal(action?.status, "failed");
  assert.match(action?.error ?? "", /answered|changed/);
  assert.equal(f.source.writes, 0);
});

test("a Continued parent's suggestion-only goal authority also governs its child", async (t) => {
  const f = await fixture(t);
  const goal = await f.server.agent.createGoal("local-user", {
    title: "Prepare report",
    milestones: ["Draft report"],
  });
  const parent = await f.server.agent.createTask("local-user", {
    prompt: "Draft report",
    goalId: goal.id,
    milestoneId: goal.milestones[0].id,
  });
  assert.equal(parent.input.proactivityBinding, undefined);
  await f.server.agent.control("local-user", parent.id, "pause");
  const s = (await review(f)).find(
    (s) => s.target.kind === "goal" && s.target.taskId === parent.id,
  )!;
  await f.server.agent.proactivity.respond("local-user", s.id, {
    requestId: s.requestId,
    clientResponseId: "continued-parent",
    expectedRevision: s.revision,
    action: "continue",
  });
  const currentParent = await f.server.agent.getTask("local-user", parent.id);
  const child = await f.server.agent.createChildTask(
    "local-user",
    currentParent,
    { prompt: "Write the selected report section" },
    "continued-child",
  );
  await waitForChildren(f, currentParent, child);
  await f.server.agent.proactivity.revalidateTask("local-user", child);
  const currentGoal = await f.server.agent.getGoal("local-user", goal.id);
  await f.server.agent.updateGoal("local-user", goal.id, {
    expectedRevision: currentGoal.revision,
    milestone: { id: goal.milestones[0].id, done: true },
  });
  await assert.rejects(
    () => f.server.agent.proactivity.revalidateTask("local-user", child),
    /goal|completed|changed/,
  );
});

test("valid delegated work can dispatch its authorized reply through the same Google adapter", async (t) => {
  const f = await fixture(t);
  const s = (await review(f)).find((s) => s.target.kind === "mail")!;
  const { task: parent } = await f.server.agent.proactivity.respond("local-user", s.id, {
    requestId: s.requestId,
    clientResponseId: "valid-delegated-parent",
    expectedRevision: s.revision,
    action: "start",
  });
  assert.ok(parent);
  const child = await f.server.agent.createChildTask(
    "local-user",
    parent,
    { prompt: "Send the selected reply" },
    "valid-delegated-child",
  );
  await waitForChildren(f, parent, child);
  let action: ActionProposal | undefined;
  const worker = new TaskWorker(f.db, async (owner, task) => {
    action = await f.server.actions.propose(owner, reply, "valid-delegated-effect", task.id);
    return { status: "waiting_input" };
  });
  t.after(() => worker.stop());
  await worker.tick();
  assert.equal(action?.status, "succeeded");
  assert.equal(f.source.writes, 1, "only the synthetic connector records this authorized send");
});
