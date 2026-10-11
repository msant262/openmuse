import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { type KanbanScope, KanbanWorkflow } from "../apps/server/src/engine/kanban-workflow.ts";

const orchestrator: KanbanScope = { role: "orchestrator", profile: "coordinator" };

test("listing discovers newly ready work with compact SQL rows, filters and bounded truncation", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const board = new KanbanWorkflow(db, "owner", "research", { profileExists: () => true });
  const parent = await board.create(
    orchestrator,
    { title: "Source", assignee: "reader" },
    "parent",
  );
  const child = await board.create(
    orchestrator,
    {
      title: "Report",
      body: "source text ".repeat(10000),
      assignee: "writer",
      parents: [parent.id],
    },
    "child",
  );
  const run = await board.claim(parent.id, "reader", "claim");
  await board.complete(run, { summary: "Actual source checked" }, "done");
  for (let i = 0; i < 55; i++)
    await db.put("owner", "kanban-cards:research", {
      ...child,
      id: `other-${String(i).padStart(3, "0")}`,
      parents: [],
      status: "ready",
    });
  const original = db.list.bind(db);
  db.list = (owner, kind) => {
    assert.ok(!kind.startsWith("kanban-"), "workflow reads must not load entire collections");
    return original(owner, kind);
  };
  const listing = await board.list(orchestrator, {
    assignee: "writer",
    status: "ready",
    limit: 10,
  });
  assert.equal(listing.count, 10);
  assert.equal(listing.truncated, true);
  assert.equal(listing.next_limit, 20);
  assert.equal(listing.promoted, 1);
  assert.equal((await board.get(child.id)).status, "ready");
  assert.ok(JSON.stringify(listing).length < 10000, "large card bodies stay out of discovery");
  assert.equal((await board.list(orchestrator, { assignee: "missing" })).count, 0);
  await assert.rejects(board.list(run, {}), /orchestrator/i);
});

test("show restores parent handoffs, prior attempts and notes without leaking another owner", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const board = new KanbanWorkflow(db, "owner", "research", { profileExists: () => true });
  const parent = await board.create(orchestrator, { title: "Read", assignee: "reader" }, "parent");
  const run = await board.claim(parent.id, "reader", "claim");
  await board.comment(run, parent.id, "Found the actual fee on the provider page.", "note");
  await board.complete(run, { summary: "Fee checked", metadata: { fee: 0 } }, "done");
  const child = await board.create(
    orchestrator,
    { title: "Write", assignee: "writer", parents: [parent.id] },
    "child",
  );
  const state = await board.show(child.id);
  assert.equal(state.parents[0].handoff?.metadata?.fee, 0);
  assert.deepEqual(state.unsatisfied_parents, []);
  assert.match(state.worker_context, /Fee checked/);
  const prior = await board.show(parent.id);
  assert.equal(prior.comments.values[0].author, "reader");
  assert.equal(prior.comments.values[0].body, "Found the actual fee on the provider page.");
  assert.equal(prior.runs.values[0].outcome, "completed");
  assert.equal(prior.events.length, 4);
  const stranger = new KanbanWorkflow(db, "other-owner", "research", { profileExists: () => true });
  await assert.rejects(stranger.show(child.id), /not found/i);
});

test("cross-task notes retain trusted authors and ACK retries do not append a second comment", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  let now = 1000;
  const board = new KanbanWorkflow(db, "owner", "research", {
    profileExists: () => true,
    now: () => now,
    leaseMs: 100,
  });
  const source = await board.create(
    orchestrator,
    { title: "Research", assignee: "reader" },
    "source",
  );
  const target = await board.create(
    orchestrator,
    { title: "Synthesize", assignee: "writer" },
    "target",
  );
  const worker = await board.claim(source.id, "reader", "claim");
  const note = await board.comment(worker, target.id, "Reuse the checked source.", "comment");
  assert.deepEqual(
    await board.comment(worker, target.id, "Reuse the checked source.", "comment"),
    note,
  );
  assert.equal((await board.show(target.id)).comments.values.length, 1);
  const later = await board.comment(
    worker,
    target.id,
    "The certificate costs twenty euros.",
    "later",
  );
  const incremental = await board.comments(target.id, note.id);
  assert.deepEqual(
    incremental.values,
    [later],
    "a later note follows the durable polling watermark",
  );
  assert.equal(incremental.complete, true);
  await assert.rejects(
    board.comment(worker, target.id, "Changed text", "comment"),
    /another board action/,
  );
  now += 101;
  await assert.rejects(board.comment(worker, target.id, "Late note", "stale"), /run ownership/);
  await assert.rejects(
    board.comment({ role: "delegated", profile: "reader" }, target.id, "Child note", "child"),
    /delegated/,
  );
  assert.equal((await board.show(target.id)).comments.values.length, 2);
});

test("large fan-out stays bounded in discovery and every child remains available through continuation", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const board = new KanbanWorkflow(db, "owner", "research", { profileExists: () => true });
  const parent = await board.create(
    orchestrator,
    { title: "Research", assignee: "reader" },
    "parent",
  );
  for (let i = 0; i < 205; i++)
    await db.put("owner", "kanban-cards:research", {
      ...parent,
      id: `child-${String(i).padStart(3, "0")}`,
      assignee: "writer",
      parents: [parent.id],
      body: "Private task context ".repeat(1000),
      status: "todo",
    });
  const listing = await board.list(orchestrator, { assignee: "reader", limit: 1 });
  assert.equal(listing.tasks[0].children.length, 200, "card limits must also bound nested fan-out");
  assert.equal(listing.tasks[0].childCount, 205);
  assert.equal(listing.tasks[0].childrenComplete, false);
  assert.ok(JSON.stringify(listing).length < 10000, "child bodies do not enter discovery");
  const first = (await board.show(parent.id)).children;
  assert.equal(first.values.length, 200);
  assert.equal(first.complete, false);
  assert.ok(first.cursor);
  const next = await board.children(parent.id, first.cursor);
  assert.equal(next.values.length, 5);
  assert.equal(next.complete, true);
  assert.equal(next.cursor, null);
  assert.equal(new Set([...first.values, ...next.values].map((row) => row.id)).size, 205);
  const stranger = new KanbanWorkflow(db, "other-owner", "research", { profileExists: () => true });
  await assert.rejects(stranger.children(parent.id), /not found/i);
});

test("board continuation traverses every compact card in priority order without losing tied dates", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const board = new KanbanWorkflow(db, "owner", "research", { profileExists: () => true });
  const seed = await board.create(orchestrator, { title: "Seed", assignee: "writer" }, "seed");
  for (let i = 0; i < 210; i++)
    await db.put("owner", "kanban-cards:research", {
      ...seed,
      id: `task-${String(i).padStart(3, "0")}`,
      priority: i % 3,
      body: "Long task data ".repeat(1000),
    });
  let cursor: string | undefined;
  const rows: { id: string; priority: number }[] = [];
  for (let page = 0; page < 10; page++) {
    const result = await board.list(orchestrator, { limit: 37, after: cursor });
    assert.ok(JSON.stringify(result).length < 20000);
    rows.push(...result.tasks);
    if (!result.truncated) {
      assert.equal(result.cursor, null);
      break;
    }
    assert.ok(result.cursor && result.cursor !== cursor, "continuation must make progress");
    cursor = result.cursor;
  }
  assert.equal(rows.length, 211);
  assert.equal(new Set(rows.map((row) => row.id)).size, 211);
  assert.deepEqual(
    rows.map((row) => row.priority),
    rows.map((row) => row.priority).sort((a, b) => b - a),
  );
  await assert.rejects(board.list(orchestrator, { after: "another-owner-card" }), /not found/i);
});
