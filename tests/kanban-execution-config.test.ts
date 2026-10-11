import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { defineTool } from "@copilotkit/runtime/v2";
import { kanbanTaskTools } from "../apps/server/src/engine/kanban-tools.ts";
import { KanbanWorkflow } from "../apps/server/src/engine/kanban-workflow.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import { executionModelSelection } from "../apps/server/src/providers/preferences.ts";
import { SkillCatalog } from "../apps/server/src/skill-catalog.ts";
import { modelFixture, richChatFixtureProviders } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("authenticated profile project and directory defaults reach native card creation", async (t) => {
  const f = await taskRuntime(t);
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "configure",
    profile: {
      toolsets: ["kanban"],
      projects: [{ id: "app", slug: "app", primaryPath: "/workspace/repositories/app" }],
      defaultProject: "app",
      workdir: "/workspace/reports",
    },
  });
  const worker = new TaskWorker(f.db, async (owner, task, ctx) => {
    const surface = await kanbanTaskTools(
      f.agent,
      owner,
      task,
      (name, description, parameters, execute) =>
        defineTool({
          name,
          description,
          parameters,
          execute: (args) => execute(parameters.parse(args)),
        }),
      { guard: ctx.guard },
    );
    const create = surface.tools.find((entry) => entry.name === "kanban_create");
    assert.ok(create?.execute);
    const execute = create.execute;
    const inputs =
      task.prompt === "Report"
        ? [{ title: "Report", assignee: "default" }]
        : [
            { title: "Review app", assignee: "default", idempotency_key: "project" },
            {
              title: "Scratch task",
              assignee: "default",
              workspace_kind: "scratch",
              idempotency_key: "scratch",
            },
          ];
    for (const args of inputs) {
      const result = await f.agent.journal.run(
        owner,
        task,
        { id: createHash("sha256").update(args.title).digest("hex"), name: "kanban_create", args },
        () => execute(args as never),
        true,
      );
      assert.ok(!(result as { error?: string })?.error, JSON.stringify(result));
    }
    return { status: "waiting_input" };
  });
  t.after(() => worker.stop());
  const coordinator = await f.agent.createTask(
    "owner",
    { prompt: "Coordinate work" },
    "coordinate",
  );
  await worker.tick();
  const finished = await f.agent.getTask("owner", coordinator.id);
  assert.equal(
    finished.status,
    "waiting_input",
    JSON.stringify({ status: finished.status, error: finished.error }),
  );
  const cards = await f.db.list<{
    id: string;
    title: string;
    project?: string;
    workspaceKind: string;
    workspacePath?: string;
    branchName?: string;
  }>("owner", "kanban-cards:default");
  const project = cards.find((card) => card.title === "Review app");
  assert.ok(project);
  assert.equal(project.project, "app");
  assert.equal(project.workspaceKind, "worktree");
  assert.equal(project.workspacePath, `/workspace/repositories/app/.worktrees/${project.id}`);
  assert.match(project.branchName ?? "", /^app\//);
  assert.equal(cards.find((card) => card.title === "Scratch task")?.workspaceKind, "scratch");
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 1,
    requestId: "directory",
    profile: { toolsets: ["kanban"], workdir: "/workspace/reports" },
  });
  await f.agent.createTask("owner", { prompt: "Report" });
  await worker.tick();
  const report = (await f.db.list<typeof project>("owner", "kanban-cards:default")).find(
    (card) => card.title === "Report",
  );
  assert.ok(report);
  assert.equal(report.workspaceKind, "dir");
  assert.equal(report.workspacePath, "/workspace/reports");
  assert.deepEqual(await f.db.list("another-owner", "kanban-cards:default"), []);
});

test("card model wins over profile and account models and assigned skills are read before inference", async (t) => {
  const url = "https://sources.example/verified";
  const provider = await modelFixture(
    t,
    (index) =>
      [
        { name: "web_fetch", arguments: { url } },
        { name: "finish_task", arguments: { summary: "Verified the requested source." } },
      ][index],
  );
  const f = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    computerEnabled: true,
  });
  f.agent.config.modelProviders = richChatFixtureProviders(f.directory, [
    "openai/fixture",
    "openai/profile-model",
    "openai/card-model",
  ]);
  const skillDir = join(
    f.directory,
    "skills",
    "owners",
    createHash("sha256").update("owner").digest("hex"),
    "verification",
  );
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: verification\ndescription: Verify task sources\nrequired-tools: [web_fetch]\n---\n# Assigned verification guide\nRead the actual source before reporting the result.\n",
  );
  t.mock.method(f.agent.computer, "mkdir", async (_owner: string, path: string) => {
    await mkdir(join(f.directory, "computer", path.slice("/workspace/".length)), {
      recursive: true,
    });
    return { path };
  });
  t.mock.method(f.agent.web, "document", async () => ({
    url,
    contentType: "text/html",
    body: "<main>The source confirms the requested finding.</main>",
  }));
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "configure",
    profile: { toolsets: ["kanban"], model: "openai/profile-model", skills: ["research"] },
  });
  const board = new KanbanWorkflow(f.db, "owner", "default", { profileExists: () => true });
  const card = await board.create(
    { role: "orchestrator", profile: "default" },
    {
      title: "Verify source",
      body: `Read ${url}`,
      assignee: "default",
      model: "card-model",
      provider: "openai",
      skills: ["operator:verification"],
    },
    "card",
  );
  const native = await f.agent.dispatchKanbanCard(
    "owner",
    "default",
    card.id,
    "default",
    "dispatch",
  );
  await f.agent.worker.tick();
  assert.equal((await f.agent.getTask("owner", native.id)).status, "succeeded");
  assert.equal((await board.get(card.id)).status, "done");
  const initial = JSON.parse(provider.requests[0].body);
  assert.equal(initial.model, "card-model");
  assert.match(initial.instructions, /# Research toward the user's requested outcome/);
  assert.match(initial.instructions, /# Assigned verification guide/);
  assert.match(initial.instructions, /Workflow instructions do not grant tools/);
  assert.ok(
    !initial.instructions.includes("# Document generation"),
    "unselected guide bodies stay unloaded",
  );
  assert.ok(
    !(await f.agent.journal.operations("owner", native.id)).some(
      (op) => op.toolName === "skills_read",
    ),
    "assigned guides are already loaded without spending a tool round",
  );
});

test("unavailable configured model cannot silently dispatch using the account default", async (t) => {
  const f = await taskRuntime(t, { model: "openai/fixture" });
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "enable",
    profile: { toolsets: ["kanban"], model: "openai/unavailable" },
  });
  const board = new KanbanWorkflow(f.db, "owner", "default", { profileExists: () => true });
  const card = await board.create(
    { role: "orchestrator", profile: "default" },
    { title: "Work", assignee: "default" },
    "card",
  );
  await assert.rejects(
    f.agent.dispatchKanbanCard("owner", "default", card.id, "default", "dispatch"),
    /unavailable|available model/i,
  );
  assert.deepEqual(await board.get(card.id), card);
  assert.deepEqual(await f.db.list("owner", "tasks"), []);
  assert.deepEqual(await f.db.list("owner", "kanban-executions"), []);
});

test("profile paths and project defaults reject invalid configuration at the authenticated boundary", async (t) => {
  const f = await taskRuntime(t);
  for (const profile of [
    { workdir: "/tmp/private" },
    { projects: [{ id: "app", slug: "app", primaryPath: "/workspace/../private" }] },
    { defaultProject: "unknown", projects: [] },
    {
      projects: [
        { id: "app", slug: "app", primaryPath: "/workspace/a" },
        { id: "app", slug: "app", primaryPath: "/workspace/b" },
      ],
    },
  ]) {
    await assert.rejects(
      f.agent.executionProfiles.set("owner", "default", {
        expectedRevision: 0,
        requestId: "invalid",
        profile,
      }),
    );
  }
  assert.equal((await f.agent.executionProfiles.get("owner")).revision, 0);
});

test("a profile model is used for ordinary work without activating kanban", async (t) => {
  const provider = await modelFixture(t, () => ({
    name: "finish_task",
    arguments: {
      summary:
        "Start by reserving time for fixed commitments. Choose one priority for work and one for study, then leave breaks and flexible time between those blocks. Review the schedule each evening and adjust tomorrow's plan.",
    },
  }));
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  f.agent.config.modelProviders = richChatFixtureProviders(f.directory, [
    "openai/fixture",
    "openai/profile-model",
  ]);
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "model",
    profile: { model: "openai/profile-model" },
  });
  const task = await f.agent.createTask("owner", {
    prompt: "Explain how to organize a daily schedule.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(
    saved.status,
    "succeeded",
    JSON.stringify({
      error: saved.error,
      question: saved.question,
      result: saved.result,
      completion: saved.completion,
    }),
  );
  assert.equal(JSON.parse(provider.requests[0].body).model, "profile-model");
  assert.deepEqual(await f.db.list("owner", "kanban-executions"), []);
});

test("a missing assigned guide names the failed configuration and makes no inference request", async (t) => {
  const provider = await modelFixture(t, () => undefined);
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "guide",
    profile: { skills: ["operator:missing-guide"] },
  });
  const task = await f.agent.createTask("owner", { prompt: "Use the configured workflow." });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "waiting_input");
  assert.match(saved.question ?? "", /operator:missing-guide/);
  assert.match(saved.question ?? "", /execution profile default/);
  assert.equal(provider.requests.length, 0);
});

test("ambiguous guide names require the complete identity, and duplicate selections read one guide", async (t) => {
  const f = await taskRuntime(t);
  const root = join(
    f.directory,
    "skills",
    "owners",
    createHash("sha256").update("owner").digest("hex"),
    "research",
  );
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "SKILL.md"),
    "---\nname: research\ndescription: Owner research guide\nrequired-tools: [web_fetch]\n---\n# Owner guide\n",
  );
  const catalog = new SkillCatalog(f.agent.config, f.agent.playbooks);
  await assert.rejects(
    catalog.preload("owner", ["research"], ["web_fetch", "search_web"]),
    /ambiguous/,
  );
  const selected = await catalog.preload(
    "owner",
    ["builtin:research", "builtin:research"],
    ["web_fetch", "search_web"],
  );
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, "builtin:research");
  assert.equal(selected[0].truncated, false);
  await assert.rejects(
    catalog.preload("another-owner", ["operator:research"], ["web_fetch"]),
    /could not be loaded/,
  );
});

test("model-provider mismatch is rejected instead of choosing a different connected route", async (t) => {
  await modelFixture(t, () => undefined);
  const f = await taskRuntime(t, { model: "openai/fixture" });
  await assert.rejects(
    executionModelSelection(f.db, f.agent.config, "owner", "openai/fixture", "mimo"),
    /do not match/,
  );
  const selected = await executionModelSelection(
    f.db,
    f.agent.config,
    "owner",
    "fixture",
    "openai",
  );
  assert.equal(selected.model, "openai/fixture");
  assert.deepEqual(selected.fallbacks, []);
});
