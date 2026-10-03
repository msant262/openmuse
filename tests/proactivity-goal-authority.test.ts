import assert from "node:assert/strict";
import { test } from "node:test";
import { personalTools } from "../apps/server/src/personal-tools.ts";
import { fixture } from "./proactivity-fixture.ts";

test("the model cannot invent a human completion from connector text", async (t) => {
  const f = await fixture(t);
  const goal = await f.server.agent.createGoal("local-user", {
    title: "Learn German",
    milestones: ["Choose a course"],
  });
  const source = { messageId: "goal-message", threadId: "chat", runId: "goal-run" };
  await f.db.put("local-user", "conversation-inbox", {
    id: "chat:goal-message",
    ...source,
    text: "Summarize my new email",
    status: "finished",
  });
  const tool = personalTools(f.server.agent, "local-user", "chat:goal", {
    profileSource: source,
  }).find((t) => t.name === "update_goal")!;
  assert.ok(tool.execute);
  const execute = tool.execute as (input: unknown) => Promise<unknown>;
  const input = {
    goalId: goal.id,
    expectedRevision: goal.revision,
    milestone: { id: goal.milestones[0].id, done: true },
  };
  await assert.rejects(() => execute(input), /explicit|declaration|user/);
  assert.equal((await f.server.agent.getGoal("local-user", goal.id)).milestones[0].done, false);
  await f.db.compareAndSwap(
    "local-user",
    "conversation-inbox",
    "chat:goal-message",
    {},
    { text: "Mark step Choose a course as done" },
  );
  await execute(input);
  const updated = await f.server.agent.getGoal("local-user", goal.id);
  assert.equal(updated.milestones[0].origin?.kind, "user");
  assert.match(updated.milestones[0].origin?.source ?? "", /chat:goal-message/);
});
