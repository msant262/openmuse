import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { type KanbanScope, KanbanWorkflow } from "../apps/server/src/engine/kanban-workflow.ts";

const orchestrator: KanbanScope = { role: "orchestrator", profile: "coordinator" };

test("lost acknowledgements replay the same claim and completed handoff without another run or evidence check", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  let checks = 0;
  const board = new KanbanWorkflow(db, "owner", "research", {
    profileExists: () => true,
    beforeHandoff: async () => {
      checks++;
    },
  });
  const card = await board.create(
    orchestrator,
    { title: "Deliver PDF", assignee: "writer" },
    "create",
  );
  const run = await board.claim(card.id, "writer", "claim");
  assert.deepEqual(await board.claim(card.id, "writer", "claim"), run);
  const input = { summary: "Actual report delivered", artifacts: ["verified-report"] };
  const completed = await board.complete(run, input, "finish");
  assert.deepEqual(await board.complete(run, input, "finish"), completed);
  assert.equal(checks, 1, "an ACK retry must not repeat an already recorded handoff");
  assert.equal((await db.list("owner", "kanban-runs:research:" + card.id)).length, 1);
  assert.equal((await db.list("owner", "kanban-events:research:" + card.id)).length, 3);
  await assert.rejects(
    board.complete(run, { summary: "Different outcome" }, "finish"),
    /another board action/,
  );
  assert.deepEqual(await board.get(card.id), completed);
});

test("a worker that lost its claim cannot create follow-up tasks under its former run", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  let time = 1000;
  const board = new KanbanWorkflow(db, "owner", "research", {
    profileExists: () => true,
    now: () => time,
    leaseMs: 100,
  });
  const card = await board.create(
    orchestrator,
    { title: "Research", assignee: "worker" },
    "create",
  );
  const old = await board.claim(card.id, "worker", "old");
  time += 101;
  const current = await board.claim(card.id, "worker", "current");
  const before = await db.list("owner", "kanban-cards:research");
  await assert.rejects(
    board.create(old, { title: "Stale follow-up", assignee: "worker" }, "stale-child"),
    /run ownership/,
  );
  assert.deepEqual(await db.list("owner", "kanban-cards:research"), before);
  const child = await board.create(
    current,
    { title: "Actual follow-up", assignee: "worker" },
    "actual-child",
  );
  assert.equal(child.creatorTaskId, card.id);
  assert.equal(child.createdBy, "worker");
});

test("dependent work waits for both parents and retains the review handoff through requested changes", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const board = new KanbanWorkflow(db, "owner", "research", { profileExists: () => true });
  const a = await board.create(
    orchestrator,
    { title: "Read provider A", assignee: "researcher" },
    "a",
  );
  const b = await board.create(
    orchestrator,
    { title: "Read provider B", assignee: "researcher" },
    "b",
  );
  const report = await board.create(
    orchestrator,
    { title: "Deliver comparison", assignee: "writer", parents: [a.id, b.id] },
    "report",
  );
  assert.equal(report.status, "todo");
  await assert.rejects(board.claim(report.id, "writer", "early"), /dependencies/);
  for (const card of [a, b]) {
    const run = await board.claim(card.id, "researcher", "claim-" + card.id);
    await board.complete(run, { summary: "Read actual provider content." }, "finish-" + card.id);
  }
  const run = await board.claim(report.id, "writer", "write");
  await board.requestReview(
    run,
    {
      summary: "Comparison ready; fields checked.",
      reviewer: "reviewer",
      metadata: { sources: ["A", "B"] },
    },
    "review",
  );
  const review = await board.claim(report.id, "reviewer", "review-claim");
  await board.requestChanges(review, "Clarify the certificate fee.", "changes");
  const changed = await board.get(report.id);
  assert.equal(changed.assignee, "writer");
  assert.equal(changed.status, "ready");
  assert.equal(changed.blockCount, 0, "review cycles are not blocker loops");
  const second = await board.claim(report.id, "writer", "write-again");
  await board.requestReview(second, { summary: "Fee clarified." }, "review-again");
  assert.equal(
    (await board.get(report.id)).assignee,
    "reviewer",
    "retain the real reviewer on a second review",
  );
  const final = await board.claim(report.id, "reviewer", "final-claim");
  await board.complete(final, { summary: "Verified comparison." }, "final");
  assert.equal((await board.get(report.id)).status, "done");
});

test("a reclaimed worker cannot finish, heartbeat or change a successor's run", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  let time = 1000;
  const board = new KanbanWorkflow(db, "owner", "default", {
    now: () => time,
    leaseMs: 100,
    profileExists: () => true,
  });
  const card = await board.create(
    orchestrator,
    { title: "Long lookup", assignee: "worker" },
    "create",
  );
  const old = await board.claim(card.id, "worker", "first");
  time += 101;
  const current = await board.claim(card.id, "worker", "successor");
  const before = await board.get(card.id);
  await assert.rejects(
    board.complete(old, { summary: "Late answer" }, "late-finish"),
    /run ownership/,
  );
  await assert.rejects(board.heartbeat(old, "late", "late-heartbeat"), /run ownership/);
  await assert.rejects(
    board.block(old, "needs_input", "late question", "late-block"),
    /run ownership/,
  );
  assert.deepEqual(await board.get(card.id), before);
  await board.complete(current, { summary: "Current answer" }, "finish");
  assert.equal((await board.get(card.id)).status, "done");
});

test("concurrent opposite dependency links cannot form a cycle, and workers cannot link another live card", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const board = new KanbanWorkflow(db, "owner", "default", { profileExists: () => true });
  const a = await board.create(orchestrator, { title: "A", assignee: "worker" }, "a");
  const b = await board.create(orchestrator, { title: "B", assignee: "worker" }, "b");
  const links = await Promise.allSettled([
    board.link(orchestrator, a.id, b.id, "ab"),
    board.link(orchestrator, b.id, a.id, "ba"),
  ]);
  assert.equal(links.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = links.find((r) => r.status === "rejected");
  assert.ok(rejected && /concurrent|cycle/i.test(String(rejected.reason)));
  const free = [await board.get(a.id), await board.get(b.id)].find((c) => !c.parents.length);
  assert.ok(free);
  const run = await board.claim(free.id, "worker", "claim");
  await assert.rejects(
    board.link(orchestrator, free.id === a.id ? b.id : a.id, free.id, "foreign"),
    /running/,
  );
  await assert.rejects(
    board.complete(
      { ...run, taskId: free.id === a.id ? b.id : a.id },
      { summary: "Wrong task" },
      "wrong",
    ),
    /run ownership/,
  );
});

test("goal work cannot park itself, dependency blocking without an open parent becomes concrete input, and delegated children cannot mutate", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const board = new KanbanWorkflow(db, "owner", "default", { profileExists: () => true });
  const goal = await board.create(
    orchestrator,
    { title: "Research fully", assignee: "worker", goalMode: true },
    "goal",
  );
  const run = await board.claim(goal.id, "worker", "claim");
  await assert.rejects(board.schedule(run, "Later", "schedule"), /goal/i);
  await assert.rejects(board.block(run, "transient", "Try later", "transient"), /goal/i);
  await board.block(run, "dependency", "Need an actual decision.", "block");
  const blocked = await board.get(goal.id);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blockKind, "needs_input");
  await assert.rejects(board.unblock(run, goal.id, "worker-unblock"), /orchestrator/);
  await board.unblock(orchestrator, goal.id, "unblock");
  await assert.rejects(
    board.create(
      { role: "delegated", profile: "child" },
      { title: "Inherited scope", assignee: "worker" },
      "child",
    ),
    /delegated/,
  );
  const other = new KanbanWorkflow(db, "other-owner", "default", { profileExists: () => true });
  await assert.rejects(other.get(goal.id), /not found/);
});

test("invalid review profiles, phantom children and failed artifact preservation leave the current run intact", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const board = new KanbanWorkflow(db, "owner", "default", {
    profileExists: (profile) => profile !== "invented",
    beforeHandoff: async (_card, input) => {
      if (input.artifacts?.length) throw Error("Missing actual artifact");
    },
  });
  const card = await board.create(
    orchestrator,
    { title: "Deliver actual PDF", assignee: "writer" },
    "create",
  );
  const run = await board.claim(card.id, "writer", "claim");
  const before = await board.get(card.id);
  await assert.rejects(
    board.requestReview(run, { summary: "Ready", reviewer: "invented" }, "review"),
    /profile/,
  );
  await assert.rejects(
    board.complete(run, { summary: "Done", createdCards: ["invented"] }, "phantom"),
    /not found|created/,
  );
  await assert.rejects(
    board.complete(run, { summary: "Done", artifacts: ["missing.pdf"] }, "file"),
    /Missing actual artifact/,
  );
  assert.deepEqual(await board.get(card.id), before);
  await assert.rejects(board.requestChanges(run, "Changes", "unreviewed"), /review/);
});
