import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { KanbanWorkflow } from "../apps/server/src/engine/kanban-workflow.ts";

const coordinator = { role: "orchestrator" as const, profile: "coordinator" };

test("creation preserves the original dispatcher, workspace, model, skill and completion contract", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const board = new KanbanWorkflow(db, "owner", "pipeline", { profileExists: () => true });
  const input = {
    title: "Implement",
    assignee: "worker",
    body: "Deliver the verified change",
    workspaceKind: "dir" as const,
    workspacePath: "/workspace/project",
    skills: ["code-review"],
    model: "small-model",
    provider: "compatible",
    maxRuntimeSeconds: 3600,
    goalMode: true,
    goalMaxTurns: 50,
    initialStatus: "blocked" as const,
    completionContract: "owner/repository",
  };
  const card = await board.create(coordinator, input, "create");
  assert.equal(card.status, "blocked");
  assert.equal(card.workspaceKind, "dir");
  assert.equal(card.workspacePath, "/workspace/project");
  assert.deepEqual(card.skills, ["code-review"]);
  assert.equal(card.model, "small-model");
  assert.equal(card.provider, "compatible");
  assert.equal(card.maxRuntimeSeconds, 3600);
  assert.equal(card.goalMaxTurns, 50);
  assert.equal(card.completionContract, "owner/repository");
  assert.deepEqual(await board.create(coordinator, input, "create"), card);
});

test("invalid provider, workspace and completion requests are rejected before a card is created", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const board = new KanbanWorkflow(db, "owner", "pipeline", { profileExists: () => true });
  const input = { title: "Implement", assignee: "worker" };
  await assert.rejects(
    board.create(coordinator, { ...input, provider: "compatible" }, "provider"),
    /requires.*model/i,
  );
  await assert.rejects(
    board.create(
      coordinator,
      { ...input, workspaceKind: "dir", workspacePath: "relative/project" },
      "path",
    ),
    /absolute.*workspace/i,
  );
  await assert.rejects(
    board.create(
      coordinator,
      { ...input, completionContract: "https://github.com/owner/repo/issues/3" },
      "contract",
    ),
    /completion contract/i,
  );
  await assert.rejects(
    board.create(coordinator, { ...input, goalMaxTurns: 0 }, "turns"),
    /positive integer/i,
  );
  assert.equal((await board.list(coordinator)).count, 0);
});

test("an automation idempotency key returns the live card across different requests without creating duplicates", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const board = new KanbanWorkflow(db, "owner", "pipeline", { profileExists: () => true });
  const input = {
    title: "Scheduled research",
    assignee: "worker",
    idempotencyKey: "daily-research",
  };
  const first = await board.create(coordinator, input, "request-1");
  const replay = await board.create(coordinator, input, "request-2");
  assert.equal(replay.id, first.id);
  assert.equal((await board.list(coordinator)).count, 1);
  const secondBoard = new KanbanWorkflow(db, "owner", "other", { profileExists: () => true });
  assert.notEqual((await secondBoard.create(coordinator, input, "request-3")).id, first.id);
});

test("a declared PR completion contract cannot be satisfied by prose without the host's real CI gate", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const board = new KanbanWorkflow(db, "owner", "pipeline", { profileExists: () => true });
  const card = await board.create(
    coordinator,
    {
      title: "Publish",
      assignee: "worker",
      completionContract: "https://github.com/owner/repo/pull/12",
    },
    "create",
  );
  const worker = await board.claim(card.id, "worker", "claim");
  await assert.rejects(
    board.complete(
      worker,
      {
        summary: "CI is green",
        metadata: { published_pr: "https://github.com/owner/repo/pull/12" },
      },
      "finish",
    ),
    /actual.*evidence/i,
  );
  assert.equal((await board.get(card.id)).status, "running");
});

test("a configured project resolves a fresh task path and deterministic branch instead of a dangling slug", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const board = new KanbanWorkflow(db, "owner", "pipeline", {
    profileExists: () => true,
    defaultProject: "app",
    resolveProject: async (name) =>
      name === "app" ? { id: "p_app", slug: "app", primaryPath: "/work/app" } : null,
  });
  const card = await board.create(
    coordinator,
    { title: "Fix the endpoint", assignee: "worker" },
    "project-default",
  );
  assert.equal(card.project, "p_app");
  assert.equal(card.workspaceKind, "worktree");
  assert.equal(card.workspacePath, `/work/app/.worktrees/${card.id}`);
  assert.equal(card.branchName, `app/${card.id}-fix-the-endpoint`);
  const scratch = await board.create(
    coordinator,
    { title: "Scratch", assignee: "worker", workspaceKind: "scratch" },
    "scratch",
  );
  const unlinked = await board.create(
    coordinator,
    { title: "No project", assignee: "worker", project: "" },
    "unlinked",
  );
  for (const plain of [scratch, unlinked]) {
    assert.equal(plain.project, undefined);
    assert.equal(plain.workspaceKind, "scratch");
    assert.equal(plain.workspacePath, undefined);
    assert.equal(plain.branchName, undefined);
  }
});

test("a worker inherits only its canonical project and gets another path, including cross-profile resolution", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const board = new KanbanWorkflow(db, "owner", "pipeline", {
    profileExists: () => true,
    resolveProject: async (name, scope) =>
      scope.role === "orchestrator" && name === "app"
        ? { id: "p_app", slug: "app", primaryPath: "/work/app" }
        : null,
  });
  const parent = await board.create(
    coordinator,
    { title: "Parent", assignee: "worker", project: "app" },
    "parent",
  );
  const worker = await board.claim(parent.id, "worker", "claim-parent");
  const child = await board.create(worker, { title: "Child", assignee: "other" }, "child");
  assert.equal(child.creatorTaskId, parent.id);
  assert.equal(child.project, "p_app");
  assert.equal(child.workspaceKind, "worktree");
  assert.equal(child.workspacePath, `/work/app/.worktrees/${child.id}`);
  assert.notEqual(child.workspacePath, parent.workspacePath);
  assert.equal(child.branchName, `app/${child.id}-child`);
  const explicit = await board.create(
    worker,
    {
      title: "Explicit folder",
      assignee: "other",
      workspaceKind: "dir",
      workspacePath: "/work/other",
    },
    "explicit",
  );
  assert.equal(explicit.project, undefined);
  assert.equal(explicit.workspacePath, "/work/other");
});

test("an unknown project falls back to scratch without a dangling identity or the creator's folder", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const board = new KanbanWorkflow(db, "owner", "pipeline", {
    profileExists: () => true,
    resolveProject: async () => null,
  });
  const card = await board.create(
    coordinator,
    { title: "Unresolved", assignee: "worker", project: "missing" },
    "missing",
  );
  assert.equal(card.project, undefined);
  assert.equal(card.workspaceKind, "scratch");
  assert.equal(card.workspacePath, undefined);
});

test("simultaneous automation requests converge on one committed card instead of leaving one request failed", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const board = new KanbanWorkflow(db, "owner", "pipeline", { profileExists: () => true });
  const input = { title: "Scheduled", assignee: "worker", idempotencyKey: "same-run" };
  const result = await Promise.allSettled([
    board.create(coordinator, input, "race-1"),
    board.create(coordinator, input, "race-2"),
  ]);
  assert.deepEqual(
    result.map((r) => r.status),
    ["fulfilled", "fulfilled"],
  );
  const cards = result.map((r) => {
    assert.equal(r.status, "fulfilled");
    return r.value;
  });
  assert.equal(cards[0].id, cards[1].id);
  assert.equal((await board.list(coordinator)).count, 1);
  await assert.rejects(
    board.create(coordinator, { ...input, title: "Rebound" }, "race-1"),
    /another board action/i,
  );
});

test("an invalid initial status cannot silently land as a dispatchable card", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const board = new KanbanWorkflow(db, "owner", "pipeline", { profileExists: () => true });
  await assert.rejects(
    board.create(
      coordinator,
      { title: "Invalid", assignee: "worker", initialStatus: "done" as never },
      "invalid-status",
    ),
    /initial status/i,
  );
  assert.equal((await board.list(coordinator)).count, 0);
});

test("project resolution cannot let an expired creator continue creating cards", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  let now = 1000;
  const board = new KanbanWorkflow(db, "owner", "pipeline", {
    profileExists: () => true,
    now: () => now,
    leaseMs: 50,
    resolveProject: async (name, scope) => {
      if (scope.role === "worker") now += 100;
      return { id: "p_app", slug: "app", primaryPath: "/work/app" };
    },
  });
  const parent = await board.create(
    coordinator,
    { title: "Parent", assignee: "worker", project: "app" },
    "parent",
  );
  const worker = await board.claim(parent.id, "worker", "claim");
  await assert.rejects(
    board.create(
      worker,
      { title: "Late child", assignee: "other", project: "p_app" },
      "late-child",
    ),
    /ownership/i,
  );
  assert.equal((await board.list(coordinator)).count, 1);
});

test("a deduplicated request keeps its original acknowledgment after the card starts running", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const board = new KanbanWorkflow(db, "owner", "pipeline", { profileExists: () => true });
  const input = { title: "Scheduled", assignee: "worker", idempotencyKey: "same-run" };
  await board.create(coordinator, input, "first");
  const acknowledged = await board.create(coordinator, input, "alias");
  await board.claim(acknowledged.id, "worker", "claim");
  assert.deepEqual(await board.create(coordinator, input, "alias"), acknowledged);
  assert.equal((await board.get(acknowledged.id)).status, "running");
});

test("a deduplicated request ID cannot be rebound to different input even when its automation key matches", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const board = new KanbanWorkflow(db, "owner", "pipeline", { profileExists: () => true });
  const input = { title: "Scheduled", assignee: "worker", idempotencyKey: "same-run" };
  await board.create(coordinator, input, "first");
  await board.create(coordinator, input, "alias");
  await assert.rejects(
    board.create(coordinator, { ...input, title: "Different work" }, "alias"),
    /another board action/i,
  );
  assert.equal((await board.list(coordinator)).count, 1);
});

test("both concurrent creation requests retain a bound acknowledgment after a worker claims the card", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const board = new KanbanWorkflow(db, "owner", "pipeline", { profileExists: () => true });
  const input = { title: "Scheduled", assignee: "worker", idempotencyKey: "same-run" };
  const requests = ["concurrent-a", "concurrent-b"];
  const acknowledgments = await Promise.all(
    requests.map((id) => board.create(coordinator, input, id)),
  );
  assert.equal(acknowledgments[0].id, acknowledgments[1].id);
  await board.claim(acknowledgments[0].id, "worker", "claim");
  for (const [index, requestId] of requests.entries()) {
    assert.deepEqual(await board.create(coordinator, input, requestId), acknowledgments[index]);
    await assert.rejects(
      board.create(coordinator, { ...input, title: "Different work" }, requestId),
      /another board action/i,
    );
  }
  assert.equal((await board.get(acknowledgments[0].id)).status, "running");
  assert.equal((await board.list(coordinator)).count, 1);
});
