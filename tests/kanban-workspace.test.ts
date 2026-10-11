import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { profileWorkspaceOptions } from "../apps/server/src/engine/execution-profiles.ts";
import { KanbanWorkflow } from "../apps/server/src/engine/kanban-workflow.ts";
import {
  kanbanWorkspaceIntent,
  prepareKanbanWorkspace,
} from "../apps/server/src/engine/kanban-workspace.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const exec = promisify(execFile);

test("a global pause at the final commit preserves the receipt without publishing the workspace binding", async (t) => {
  const f = await fixture(t);
  const mutate = f.db.durableMutation.bind(f.db);
  let paused = false;
  t.mock.method(f.db, "durableMutation", async (...args: Parameters<typeof mutate>) => {
    if (!paused && args[1].startsWith("kanban-workspace:")) {
      paused = true;
      await f.agent.runtimePause.set("owner", { paused: true, expectedRevision: 0 });
    }
    return mutate(...args);
  });
  const worker = new TaskWorker(f.db, async (owner, task, ctx) => {
    await prepareKanbanWorkspace(f.agent, owner, task, ctx);
    return { status: "waiting_input" };
  });
  t.after(() => worker.stop());
  await worker.tick();
  assert.equal(paused, true);
  assert.equal((await f.agent.getTask("owner", f.native.id)).status, "waiting_global_pause");
  assert.equal(f.mkdirCalls(), 1);
  const binding = await f.db.get<{ workspace: { prepared?: unknown } }>(
    "owner",
    "kanban-executions",
    f.native.id,
  );
  assert.equal(binding?.workspace.prepared, undefined);
  assert.ok(
    (await f.agent.journal.operations("owner", f.native.id)).some(
      (op) => op.toolName === "prepare_kanban_workspace" && op.status === "succeeded",
    ),
  );
});

async function fixture(
  t: TestContext,
  workspace: Record<string, unknown> = {},
  profileConfig: Record<string, unknown> = {},
) {
  const f = await taskRuntime(t, { computerEnabled: true });
  const root = join(f.directory, "physical-workspace");
  await mkdir(root);
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "enable",
    profile: { toolsets: ["kanban"], board: "pipeline", ...profileConfig },
  });
  const board = new KanbanWorkflow(f.db, "owner", "pipeline", {
    profileExists: () => true,
    ...profileWorkspaceOptions(await f.agent.executionProfiles.get("owner")),
  });
  const card = await board.create(
    { role: "orchestrator", profile: "default" },
    {
      title: "Prepare actual task files",
      assignee: "default",
      ...workspace,
    },
    "card",
  );
  let mkdirCalls = 0;
  t.mock.method(f.agent.computer, "mkdir", async (_owner: string, path: string) => {
    mkdirCalls++;
    await mkdir(join(root, path.slice("/workspace/".length)), { recursive: true });
    return { path };
  });
  t.mock.method(f.agent.computer, "execute", async (_owner: string, args: { command: string }) => {
    // Physical interpreter/Git in a temporary fixture; not a live native host.
    try {
      const { stdout, stderr } = await exec("bash", ["-c", args.command], { cwd: root });
      return { id: "workspace-command", status: "succeeded", stdout, stderr, exitCode: 0 };
    } catch (error) {
      const e = error as { stdout: string; stderr: string; code: number };
      return { id: "workspace-command", status: "failed", ...e, exitCode: e.code };
    }
  });
  const native = await f.agent.dispatchKanbanCard(
    "owner",
    "pipeline",
    card.id,
    "default",
    "dispatch",
  );
  return { ...f, root, board, card, native, mkdirCalls: () => mkdirCalls };
}

test("a registered default project is dispatched into its physical worktree and project branch", async (t) => {
  const f = await fixture(
    t,
    {},
    {
      projects: [{ id: "application", slug: "app", primaryPath: "/workspace/repository" }],
      defaultProject: "application",
    },
  );
  const repo = join(f.root, "repository");
  await mkdir(repo);
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await exec(
    "git",
    [
      "-c",
      "user.name=QA",
      "-c",
      "user.email=qa@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    { cwd: repo },
  );
  const worker = new TaskWorker(f.db, async (owner, task, ctx) => {
    const prepared = await prepareKanbanWorkspace(f.agent, owner, task, ctx);
    assert.equal(prepared?.cwd, `/workspace/repository/.worktrees/${f.card.id}`);
    const branch = (
      await exec("git", ["branch", "--show-current"], { cwd: join(repo, ".worktrees", f.card.id) })
    ).stdout.trim();
    assert.equal(branch, f.card.branchName);
    assert.match(branch, /^app\//);
    await writeFile(join(repo, ".worktrees", f.card.id, "proof.txt"), "project execution");
    return { status: "waiting_input" };
  });
  t.after(() => worker.stop());
  await worker.tick();
  const task = await f.agent.getTask("owner", f.native.id);
  assert.equal(task.status, "waiting_input", task.error ?? task.question);
  assert.equal(f.card.project, "application");
  assert.equal(
    (await exec("git", ["branch", "--show-current"], { cwd: repo })).stdout.trim(),
    "main",
  );
  assert.equal(
    await readFile(join(repo, ".worktrees", f.card.id, "proof.txt"), "utf8"),
    "project execution",
  );
});

test("native worker provisions a stable scratch workspace and recovers its committed binding", async (t) => {
  const f = await fixture(t);
  let observed: string | undefined;
  const worker = new TaskWorker(f.db, async (owner, task, ctx) => {
    const first = await prepareKanbanWorkspace(f.agent, owner, task, ctx);
    assert.ok(first);
    observed = first.cwd;
    await writeFile(
      join(f.root, first.cwd.slice("/workspace/".length), "proof.txt"),
      "actual contents",
    );
    assert.deepEqual(await prepareKanbanWorkspace(f.agent, owner, task, ctx), first);
    return { status: "waiting_input", question: "Fixture wait" };
  });
  t.after(() => worker.stop());
  await worker.tick();
  assert.equal(
    (await f.agent.getTask("owner", f.native.id)).status,
    "waiting_input",
    JSON.stringify(await f.agent.getTask("owner", f.native.id)),
  );
  assert.equal(observed, `/workspace/.okami/kanban/pipeline/workspaces/${f.card.id}`);
  assert.equal(f.mkdirCalls(), 1);
  assert.ok(observed);
  assert.equal(
    await readFile(join(f.root, observed.slice("/workspace/".length), "proof.txt"), "utf8"),
    "actual contents",
  );
  assert.equal((await f.board.get(f.card.id)).workspacePath, observed);
  assert.ok(
    (await f.agent.journal.operations("owner", f.native.id)).some(
      (op) => op.toolName === "prepare_kanban_workspace" && op.status === "succeeded",
    ),
  );
});

test("explicit directory is created without changing or removing its existing files", async (t) => {
  const f = await fixture(t, { workspaceKind: "dir", workspacePath: "/workspace/reports" });
  await mkdir(join(f.root, "reports"));
  await writeFile(join(f.root, "reports", "real.txt"), "preserve");
  const worker = new TaskWorker(f.db, async (owner, task, ctx) => {
    assert.equal(
      (await prepareKanbanWorkspace(f.agent, owner, task, ctx))?.cwd,
      "/workspace/reports",
    );
    return { status: "waiting_input" };
  });
  t.after(() => worker.stop());
  await worker.tick();
  assert.equal(
    (await f.agent.getTask("owner", f.native.id)).status,
    "waiting_input",
    JSON.stringify(await f.agent.getTask("owner", f.native.id)),
  );
  assert.equal(await readFile(join(f.root, "reports", "real.txt"), "utf8"), "preserve");
  assert.equal(f.mkdirCalls(), 1);
});

test("worktree provision uses a real separate Git branch and leaves the primary checkout unchanged", async (t) => {
  const f = await fixture(t, { workspaceKind: "worktree", workspacePath: "/workspace/repository" });
  const repo = join(f.root, "repository");
  await mkdir(repo);
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await exec(
    "git",
    [
      "-c",
      "user.name=QA",
      "-c",
      "user.email=qa@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    { cwd: repo },
  );
  const worker = new TaskWorker(f.db, async (owner, task, ctx) => {
    const bound = await prepareKanbanWorkspace(f.agent, owner, task, ctx);
    assert.equal(bound?.cwd, `/workspace/repository/.worktrees/${f.card.id}`);
    assert.equal(
      (
        await exec("git", ["branch", "--show-current"], {
          cwd: join(repo, ".worktrees", f.card.id),
        })
      ).stdout.trim(),
      `wt/${f.card.id}`,
    );
    assert.equal(
      (await exec("git", ["branch", "--show-current"], { cwd: repo })).stdout.trim(),
      "main",
    );
    assert.deepEqual(await prepareKanbanWorkspace(f.agent, owner, task, ctx), bound);
    return { status: "waiting_input" };
  });
  t.after(() => worker.stop());
  await worker.tick();
  assert.equal(
    (await f.agent.getTask("owner", f.native.id)).status,
    "waiting_input",
    JSON.stringify(await f.agent.getTask("owner", f.native.id)),
  );
});

test("worktree preparation rejects a symlink instead of using an unrelated checkout", async (t) => {
  const f = await fixture(t, { workspaceKind: "worktree", workspacePath: "/workspace/linked" });
  await symlink(f.directory, join(f.root, "linked"));
  const worker = new TaskWorker(f.db, async (owner, task, ctx) => {
    await assert.rejects(
      () => prepareKanbanWorkspace(f.agent, owner, task, ctx),
      /workspace|worktree|directory/i,
    );
    return { status: "waiting_input" };
  });
  t.after(() => worker.stop());
  await worker.tick();
  const binding = await f.db.get<{ workspace: { prepared?: unknown } }>(
    "owner",
    "kanban-executions",
    f.native.id,
  );
  assert.equal(binding?.workspace.prepared, undefined);
  assert.equal((await f.agent.getTask("owner", f.native.id)).status, "waiting_input");
});

test("workspace intent rejects traversal and does not guess a repository", () => {
  for (const workspacePath of ["relative", "/workspace/../outside", "/workspace-other"])
    assert.throws(() =>
      kanbanWorkspaceIntent("board", { id: "card", workspaceKind: "dir", workspacePath } as never),
    );
  assert.throws(
    () => kanbanWorkspaceIntent("board", { id: "card", workspaceKind: "worktree" } as never),
    /repository|path/i,
  );
});

test("a replaced actor cannot publish workspace preparation after a physical mkdir", async (t) => {
  const f = await fixture(t);
  const mkdirPhysical = f.agent.computer.mkdir.bind(f.agent.computer);
  t.mock.method(f.agent.computer, "mkdir", async (owner: string, path: string) => {
    const result = await mkdirPhysical(owner, path);
    await f.db.compareAndSwapTask(owner, f.native.id, {}, { leaseId: "replacement-worker" });
    return result;
  });
  let rejected = false;
  const worker = new TaskWorker(f.db, async (owner, task, ctx) => {
    await assert.rejects(
      () => prepareKanbanWorkspace(f.agent, owner, task, ctx),
      /lease|ownership|authority/i,
    );
    rejected = true;
    return { status: "waiting_input" };
  });
  t.after(() => worker.stop());
  await worker.tick();
  assert.equal(rejected, true);
  assert.equal(f.mkdirCalls(), 1);
  const binding = await f.db.get<{ workspace: { prepared?: unknown } }>(
    "owner",
    "kanban-executions",
    f.native.id,
  );
  assert.equal(binding?.workspace.prepared, undefined);
  assert.equal((await f.board.get(f.card.id)).workspacePath, undefined);
});

test("an existing unrelated linked worktree is preserved and a card-owned branch is created", async (t) => {
  const f = await fixture(t, {
    workspaceKind: "worktree",
    workspacePath: "/workspace/repository/linked",
  });
  const repo = join(f.root, "repository");
  await mkdir(repo);
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await exec(
    "git",
    [
      "-c",
      "user.name=QA",
      "-c",
      "user.email=qa@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    { cwd: repo },
  );
  await exec("git", ["worktree", "add", "-b", "unrelated", "linked"], { cwd: repo });
  await writeFile(join(repo, "linked", "preserve.txt"), "real existing content");
  const worker = new TaskWorker(f.db, async (owner, task, ctx) => {
    const workspace = await prepareKanbanWorkspace(f.agent, owner, task, ctx);
    assert.equal(workspace?.cwd, `/workspace/repository/.worktrees/${f.card.id}`);
    return { status: "waiting_input" };
  });
  t.after(() => worker.stop());
  await worker.tick();
  assert.equal(
    (await f.agent.getTask("owner", f.native.id)).status,
    "waiting_input",
    JSON.stringify(await f.agent.getTask("owner", f.native.id)),
  );
  assert.equal(
    (await exec("git", ["branch", "--show-current"], { cwd: join(repo, "linked") })).stdout.trim(),
    "unrelated",
  );
  assert.equal(
    await readFile(join(repo, "linked", "preserve.txt"), "utf8"),
    "real existing content",
  );
});
