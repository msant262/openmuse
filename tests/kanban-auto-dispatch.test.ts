import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { defineTool } from "@copilotkit/runtime/v2";
import { kanbanTaskTools } from "../apps/server/src/engine/kanban-tools.ts";
import { KanbanWorkflow } from "../apps/server/src/engine/kanban-workflow.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import { LocalThreads } from "../apps/server/src/threads.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("a model-created card is picked up automatically and its verified result reaches only the original conversation", async (t) => {
  const url = "https://sources.example/finding";
  const provider = await modelFixture(
    t,
    (i) =>
      [
        { name: "web_fetch", arguments: { url } },
        {
          name: "finish_task",
          arguments: { summary: "The requested source confirms the finding." },
        },
      ][i],
  );
  const f = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    computerEnabled: true,
  });
  assert.ok(f.threads instanceof LocalThreads);
  await f.threads.ensure("owner", "source-chat");
  await f.threads.ensure("owner", "other-chat");
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "enable",
    profile: { toolsets: ["kanban"] },
  });
  t.mock.method(f.agent.computer, "mkdir", async (_owner: string, path: string) => {
    await mkdir(join(f.directory, "computer", path.slice("/workspace/".length)), {
      recursive: true,
    });
    return { path };
  });
  t.mock.method(f.agent.web, "document", async () => ({
    url,
    contentType: "text/html",
    body: "<main>The requested source confirms the finding.</main>",
  }));
  const coordinator = await f.agent.createTask("owner", {
    prompt: "Read the requested source.",
    originThreadId: "source-chat",
    originMessageId: "user-request",
  });
  let cardId = "";
  const creationWorker = new TaskWorker(f.db, async (owner, task, ctx) => {
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
    const create = surface.tools.find((tool) => tool.name === "kanban_create");
    assert.ok(create?.execute);
    const execute = create.execute;
    const args = {
      title: "Read the finding",
      body: `Read ${url} and return the observed finding.`,
      assignee: "default",
    };
    const result = (await f.agent.journal.run(
      owner,
      task,
      { id: "create-card", name: "kanban_create", args },
      () => execute(args as never),
      true,
    )) as { task_id: string };
    cardId = result.task_id;
    return { status: "paused" };
  });
  t.after(() => creationWorker.stop());
  await creationWorker.tick();
  assert.ok(cardId);
  const board = new KanbanWorkflow(f.db, "owner", "default", { profileExists: () => true });
  await Promise.all([f.agent.routineTick(), f.agent.routineTick()]);
  const running = await board.get(cardId);
  assert.equal(running.status, "running");
  assert.equal(running.nativeOrigin?.taskId, coordinator.id);
  const nativeTasks = (await f.db.list<AgentTask>("owner", "tasks")).filter(
    (task) => task.id !== coordinator.id,
  );
  assert.equal(nativeTasks.length, 1);
  assert.equal(nativeTasks[0].originThreadId, "source-chat");
  assert.equal(nativeTasks[0].originMessageId, "user-request");
  await f.agent.worker.tick();
  assert.equal((await board.get(cardId)).status, "done");
  assert.equal((await f.agent.getTask("owner", nativeTasks[0].id)).status, "succeeded");
  const source = await f.db.threadMessagePage("owner", "source-chat", { limit: 20 });
  assert.equal(
    source.messages.filter(
      (message) =>
        message.role === "assistant" && String(message.content).includes("confirms the finding"),
    ).length,
    1,
  );
  assert.deepEqual(
    (await f.db.threadMessagePage("owner", "other-chat", { limit: 20 })).messages,
    [],
  );
  await f.agent.routineTick();
  assert.equal((await f.db.list<AgentTask>("owner", "tasks")).length, 2);
  assert.equal(provider.requests.length, 2);
});

test("automatic discovery obeys platform opt-ins, dependencies, disabled profiles and owner isolation", async (t) => {
  const f = await taskRuntime(t);
  for (const [owner, name, profile] of [
    ["owner", "enabled", { toolsets: ["kanban"] }],
    ["owner", "browser-only", { platformToolsets: { browser: ["kanban"] } }],
    ["owner", "disabled", { toolsets: ["kanban"], disabledToolsets: ["kanban"] }],
    ["other", "enabled", { toolsets: ["kanban"] }],
  ] as const) {
    await f.agent.executionProfiles.set(owner, name, {
      expectedRevision: 0,
      requestId: "profile",
      profile,
    });
    const board = new KanbanWorkflow(f.db, owner, "default", {
      profileExists: (id) => f.agent.executionProfiles.exists(owner, id),
    });
    await board.create(
      { role: "orchestrator", profile: name },
      { title: name, assignee: name },
      `create:${name}`,
    );
  }
  const board = new KanbanWorkflow(f.db, "owner", "default", { profileExists: () => true });
  const parent = await board.create(
    { role: "orchestrator", profile: "enabled" },
    { title: "Parent", assignee: "browser-only" },
    "parent",
  );
  const child = await board.create(
    { role: "orchestrator", profile: "enabled" },
    { title: "Dependent", assignee: "enabled", parents: [parent.id] },
    "child",
  );
  await f.agent.routineTick();
  assert.equal((await f.db.list<AgentTask>("owner", "tasks")).length, 1);
  assert.equal((await f.db.list<AgentTask>("other", "tasks")).length, 1);
  assert.equal((await board.get(child.id)).status, "todo");
});

test("confirmed failed attempts restore their phase and stop repeated failures; cancellation never respawns", async (t) => {
  const f = await taskRuntime(t);
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "profile",
    profile: { toolsets: ["kanban"] },
  });
  const board = new KanbanWorkflow(f.db, "owner", "default", { profileExists: () => true });
  const card = await board.create(
    { role: "orchestrator", profile: "default" },
    { title: "Bounded failures", assignee: "default" },
    "card",
  );
  await f.agent.routineTick();
  const first = (await board.get(card.id)).currentRun;
  assert.ok(first?.nativeTaskId);
  await f.db.compareAndSwapTask(
    "owner",
    first.nativeTaskId,
    { status: "queued" },
    {
      status: "failed",
      error: "The QA command was rejected before dispatch.",
      state: { runtimeExpired: true },
    },
  );
  await f.agent.routineTick();
  const second = (await board.get(card.id)).currentRun;
  assert.ok(second?.nativeTaskId);
  assert.notEqual(second.id, first.id);
  await f.db.compareAndSwapTask(
    "owner",
    second.nativeTaskId,
    { status: "queued" },
    { status: "failed", error: "The same QA command was rejected before dispatch." },
  );
  await f.agent.routineTick();
  const stopped = await board.get(card.id);
  assert.equal(stopped.status, "blocked");
  assert.equal(stopped.currentRun, null);
  assert.match(stopped.reason ?? "", /QA command/);
  await f.agent.routineTick();
  assert.equal((await f.db.list("owner", "tasks")).length, 2);
  const cancelCard = await board.create(
    { role: "orchestrator", profile: "default" },
    { title: "Cancelled work", assignee: "default" },
    "cancel-card",
  );
  await f.agent.routineTick();
  const cancelledRun = (await board.get(cancelCard.id)).currentRun;
  assert.ok(cancelledRun?.nativeTaskId);
  await f.db.compareAndSwapTask(
    "owner",
    cancelledRun.nativeTaskId,
    { status: "queued" },
    { status: "cancelled" },
  );
  await f.agent.routineTick();
  assert.equal((await board.get(cancelCard.id)).status, "blocked");
  assert.equal((await f.db.list("owner", "tasks")).length, 3);
});

test("confirmed process cleanup does not authorize replay of an uncertain effect", async (t) => {
  const f = await taskRuntime(t);
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "profile",
    profile: { toolsets: ["kanban"] },
  });
  const board = new KanbanWorkflow(f.db, "owner", "default", { profileExists: () => true });
  const card = await board.create(
    { role: "orchestrator", profile: "default" },
    { title: "Uncertain effect", assignee: "default" },
    "card",
  );
  await f.agent.routineTick();
  const run = (await board.get(card.id)).currentRun;
  assert.ok(run?.nativeTaskId);
  await f.db.compareAndSwapTask(
    "owner",
    run.nativeTaskId,
    { status: "queued" },
    {
      status: "failed",
      error: "The Google response was not confirmed.",
      state: { runtimeExpired: true },
    },
  );
  await f.db.put("owner", "task-operations", {
    id: "effect",
    taskId: run.nativeTaskId,
    effect: true,
    status: "outcome_unknown",
    receipt: { data: { cleanupConfirmed: true, outcomeUnknown: true } },
  });
  await f.agent.routineTick();
  const protectedCard = await board.get(card.id);
  assert.equal(protectedCard.status, "blocked");
  assert.equal(protectedCard.currentRun?.id, run.id);
  assert.equal((await f.db.list("owner", "tasks")).length, 1);
  await f.agent.routineTick();
  assert.equal((await f.db.list("owner", "tasks")).length, 1);
  await assert.rejects(
    board.unblock({ role: "orchestrator", profile: "default" }, card.id, "unsafe-resume"),
    /live worker/,
  );
  assert.equal(
    (await f.db.get<{ status: string }>("owner", "task-operations", "effect"))?.status,
    "outcome_unknown",
  );
  // Simulate observed reconciliation, rather than treating cleanup as proof.
  await f.db.compareAndSwap(
    "owner",
    "task-operations",
    "effect",
    { status: "outcome_unknown" },
    { status: "failed" },
  );
  await f.agent.routineTick();
  assert.equal((await board.get(card.id)).status, "running");
  assert.notEqual((await board.get(card.id)).currentRun?.id, run.id);
  assert.equal((await f.db.list("owner", "tasks")).length, 2);
});

test("preparation refusal backs off without counting a failure or starving other work; a configuration change retries immediately", async (t) => {
  const f = await taskRuntime(t);
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "enable",
    profile: { toolsets: ["kanban"] },
  });
  const board = new KanbanWorkflow(f.db, "owner", "default", { profileExists: () => true });
  const impossible = await board.create(
    { role: "orchestrator", profile: "default" },
    { title: "Goal needs its judge", assignee: "default", goalMode: true },
    "goal",
  );
  await board.create(
    { role: "orchestrator", profile: "default" },
    { title: "Ordinary work", assignee: "default" },
    "ordinary",
  );
  const dispatch = f.agent.dispatchKanbanCard.bind(f.agent);
  let refused = 0;
  t.mock.method(f.agent, "dispatchKanbanCard", (...args: Parameters<typeof dispatch>) => {
    if (args[2] === impossible.id) refused++;
    return dispatch(...args);
  });
  const candidates = await f.db.kanbanDispatchCandidates("ready");
  assert.deepEqual(Object.keys(candidates[0]).sort(), [
    "board",
    "cardId",
    "cardRevision",
    "owner",
    "profile",
    "profileRevision",
  ]);
  await f.agent.routineTick();
  await f.agent.routineTick();
  assert.equal(refused, 1);
  assert.equal((await f.db.list("owner", "tasks")).length, 1);
  assert.equal((await board.get(impossible.id)).consecutiveFailures ?? 0, 0);
  assert.match((await board.show(impossible.id)).dispatch?.error ?? "", /goal.*support/);
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 1,
    requestId: "updated",
    profile: { toolsets: ["kanban"], dispatchFailureLimit: 3 },
  });
  await f.agent.routineTick();
  assert.equal(refused, 2);
  assert.equal((await f.db.list("owner", "tasks")).length, 1);
});

test("a runtime pause prevents automatic dispatch and resuming picks up the same card once", async (t) => {
  const f = await taskRuntime(t);
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "enable",
    profile: { toolsets: ["kanban"] },
  });
  const board = new KanbanWorkflow(f.db, "owner", "default", { profileExists: () => true });
  const card = await board.create(
    { role: "orchestrator", profile: "default" },
    { title: "Paused dispatch", assignee: "default" },
    "card",
  );
  await f.agent.runtimePause.set("owner", { paused: true, expectedRevision: 0 });
  await f.agent.routineTick();
  assert.equal((await board.get(card.id)).status, "ready");
  assert.equal((await f.db.list("owner", "tasks")).length, 0);
  await f.agent.runtimePause.set("owner", { paused: false, expectedRevision: 1 });
  await f.agent.routineTick();
  await f.agent.routineTick();
  assert.equal((await board.get(card.id)).status, "running");
  assert.equal((await f.db.list("owner", "tasks")).length, 1);
});

test("an uncertain effect arriving at settlement commit retains the exact claim and receipt", async (t) => {
  const f = await taskRuntime(t);
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "enable",
    profile: { toolsets: ["kanban"] },
  });
  const board = new KanbanWorkflow(f.db, "owner", "default", { profileExists: () => true });
  const card = await board.create(
    { role: "orchestrator", profile: "default" },
    { title: "Settlement race", assignee: "default" },
    "card",
  );
  await f.agent.routineTick();
  const before = await board.get(card.id);
  assert.ok(before.currentRun?.nativeTaskId);
  const nativeId = before.currentRun.nativeTaskId;
  await f.db.compareAndSwapTask(
    "owner",
    nativeId,
    { status: "queued" },
    { status: "failed", error: "The reply was interrupted." },
  );
  const mutate = f.db.durableMutation.bind(f.db);
  t.mock.method(f.db, "durableMutation", async (...args: Parameters<typeof mutate>) => {
    if (args[1].includes("native-settled:"))
      await f.db.put("owner", "task-operations", {
        id: "late-effect",
        taskId: nativeId,
        effect: true,
        status: "outcome_unknown",
        receipt: { data: { cleanupConfirmed: true } },
      });
    return mutate(...args);
  });
  await assert.rejects(board.settleNativeRun(card.id, nativeId), /Concurrent/);
  assert.deepEqual(await board.get(card.id), before);
  assert.equal((await board.runHistory(card.id)).values[0].status, "running");
  assert.equal((await f.db.list("owner", "tasks")).length, 1);
  await board.settleNativeRun(card.id, nativeId);
  assert.equal((await board.get(card.id)).status, "blocked");
  assert.equal((await board.get(card.id)).currentRun?.id, before.currentRun.id);
});

test("review failures restore review, honor the configured failure circuit and preserve phase on explicit resume", async (t) => {
  const f = await taskRuntime(t);
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "enable",
    profile: { toolsets: ["kanban"], dispatchFailureLimit: 3 },
  });
  const board = new KanbanWorkflow(f.db, "owner", "default", { profileExists: () => true });
  const card = await board.create(
    { role: "orchestrator", profile: "default" },
    { title: "Review this finding", assignee: "default" },
    "card",
  );
  await f.agent.routineTick();
  let implementation = (await board.get(card.id)).currentRun;
  assert.ok(implementation?.nativeTaskId);
  await f.db.compareAndSwapTask(
    "owner",
    implementation.nativeTaskId,
    { status: "queued" },
    { status: "failed", error: "Implementation failed before dispatch." },
  );
  await f.agent.routineTick();
  implementation = (await board.get(card.id)).currentRun;
  assert.ok(implementation?.nativeTaskId);
  assert.equal((await board.get(card.id)).consecutiveFailures, 1);
  await f.db.compareAndSwapTask(
    "owner",
    implementation.nativeTaskId,
    { status: "queued" },
    {
      status: "running",
      leaseId: "actor",
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    },
  );
  // Exercise the real canonical review transition and native ownership checks.
  await board.requestReview(
    {
      role: "worker",
      profile: "default",
      taskId: card.id,
      runId: implementation.id,
      nativeTaskId: implementation.nativeTaskId,
      nativeLeaseId: "actor",
    },
    { summary: "The finding is available for review." },
    "review",
  );
  assert.equal((await board.get(card.id)).consecutiveFailures, 0);
  await f.db.compareAndSwapTask(
    "owner",
    implementation.nativeTaskId,
    { status: "running", leaseId: "actor" },
    { status: "succeeded", leaseId: null, leaseUntil: null },
  );
  for (let failure = 1; failure <= 3; failure++) {
    await f.agent.routineTick();
    const review = (await board.get(card.id)).currentRun;
    assert.ok(review?.nativeTaskId);
    assert.equal(review.phase, "review");
    await f.db.compareAndSwapTask(
      "owner",
      review.nativeTaskId,
      { status: "queued" },
      { status: "failed", error: `Reviewer failure ${failure} before dispatch.` },
    );
  }
  await f.agent.routineTick();
  const stopped = await board.get(card.id);
  assert.equal(stopped.status, "blocked");
  assert.equal(stopped.consecutiveFailures, 3);
  assert.equal(stopped.currentRun, null);
  assert.equal((await f.db.list("owner", "tasks")).length, 5);
  await board.unblock({ role: "orchestrator", profile: "default" }, card.id, "resume");
  assert.equal((await board.get(card.id)).status, "review");
  assert.equal((await board.get(card.id)).consecutiveFailures, 0);
  await f.agent.routineTick();
  assert.equal((await board.get(card.id)).currentRun?.phase, "review");
});

test("a succeeded native task without canonical handoff is not accepted as card completion", async (t) => {
  const f = await taskRuntime(t);
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "enable",
    profile: { toolsets: ["kanban"], dispatchFailureLimit: 1 },
  });
  const board = new KanbanWorkflow(f.db, "owner", "default", { profileExists: () => true });
  const card = await board.create(
    { role: "orchestrator", profile: "default" },
    { title: "Requires a verified result", assignee: "default" },
    "card",
  );
  await f.agent.routineTick();
  const run = (await board.get(card.id)).currentRun;
  assert.ok(run?.nativeTaskId);
  await f.db.compareAndSwapTask(
    "owner",
    run.nativeTaskId,
    { status: "queued" },
    { status: "succeeded", result: "I say it is done." },
  );
  await f.agent.routineTick();
  const stopped = await board.get(card.id);
  assert.equal(stopped.status, "blocked");
  assert.match(stopped.reason ?? "", /entrega verificada/);
  assert.equal(stopped.handoff, null);
  assert.equal((await board.runHistory(card.id)).values[0].outcome, "failed");
});

for (const timing of ["before discovery", "at claim commit"] as const) {
  test(`a chat deletion ${timing} forbids fresh automatic work without affecting another owner`, async (t) => {
    const f = await taskRuntime(t);
    assert.ok(f.threads instanceof LocalThreads);
    const threads = f.threads;
    for (const owner of ["owner", "other"]) {
      await threads.ensure(owner, "old-chat");
      await f.agent.executionProfiles.set(owner, "default", {
        expectedRevision: 0,
        requestId: "enable",
        profile: { toolsets: ["kanban"] },
      });
      const board = new KanbanWorkflow(f.db, owner, "default", {
        profileExists: () => true,
        nativeOrigin: { taskId: "finished-origin", threadId: "old-chat" },
      });
      await board.create(
        { role: "orchestrator", profile: "default" },
        { title: "Card from this chat", assignee: "default" },
        "card",
      );
    }
    const remove = async () => {
      const response = await threads.handle(
        new Request("http://local/api/copilotkit/threads/old-chat", { method: "DELETE" }),
        "owner",
      );
      assert.equal(response?.status, 200);
    };
    if (timing === "before discovery") await remove();
    else {
      const mutate = f.db.durableMutation.bind(f.db);
      t.mock.method(f.db, "durableMutation", async (...args: Parameters<typeof mutate>) => {
        if (args[0] === "owner" && args[1].startsWith("kanban:default:dispatch:")) await remove();
        return mutate(...args);
      });
    }
    await f.agent.routineTick();
    await f.agent.routineTick();
    assert.equal((await f.db.list("owner", "tasks")).length, 0);
    assert.equal((await f.db.list("other", "tasks")).length, 1);
    assert.ok((await f.db.get<{ deletedAt?: string }>("owner", "threads", "old-chat"))?.deletedAt);
    assert.equal(
      (await f.db.get<{ deletedAt?: string }>("other", "threads", "old-chat"))?.deletedAt,
      undefined,
    );
  });
}

test("a new canonical attempt carries real prior progress and never replays a confirmed concrete effect", async (t) => {
  const f = await taskRuntime(t);
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "enable",
    profile: { toolsets: ["kanban"] },
  });
  const board = new KanbanWorkflow(f.db, "owner", "default", { profileExists: () => true });
  const card = await board.create(
    { role: "orchestrator", profile: "default" },
    { title: "Continue the verified work", assignee: "default" },
    "card",
  );
  await f.agent.routineTick();
  let sends = 0;
  const file = await f.files.importBinaryAttachment(
    "owner",
    "observed.txt",
    new TextEncoder().encode("Actual saved finding"),
    "QA",
    "text/plain",
    "prior-file",
  );
  const evidence = [
    {
      id: "read-source",
      kind: "web" as const,
      title: "Observed source",
      excerpt: "Actual saved finding",
      url: "https://sources.example/finding",
    },
  ];
  const worker = new TaskWorker(f.db, async (owner, task, ctx) => {
    await f.agent.journal.run(
      owner,
      task,
      {
        id: "confirmed-send",
        toolCallId: "concrete-provider-send",
        name: "gmail_send",
        args: { subject: "QA confirmed delivery" },
      },
      async () => {
        sends++;
        return { id: "observed-message", sent: true };
      },
      true,
    );
    await ctx.checkpoint({ evidence, artifactIds: [file.id] });
    return { status: "failed", error: "A later command was rejected before dispatch." };
  });
  t.after(() => worker.stop());
  await worker.tick();
  const first = (await board.get(card.id)).currentRun;
  assert.ok(first?.nativeTaskId);
  await f.db.put("other", "task-operations", {
    id: "foreign-receipt",
    taskId: first.nativeTaskId,
    toolName: "gmail_send",
    status: "succeeded",
    receipt: { private: "other-owner-only" },
  });
  await f.agent.routineTick();
  const second = (await board.get(card.id)).currentRun;
  assert.ok(second?.nativeTaskId);
  assert.notEqual(second.id, first.id);
  const continued = await f.agent.getTask("owner", second.nativeTaskId);
  assert.deepEqual(continued.evidence, evidence);
  assert.deepEqual(continued.artifactIds, [file.id]);
  assert.equal(
    Buffer.from(await f.files.bytes("owner", file.id)).toString(),
    "Actual saved finding",
  );
  assert.match(JSON.stringify(await f.agent.actor.history("owner", continued)), /observed-message/);
  assert.doesNotMatch(
    JSON.stringify(await f.agent.actor.history("owner", continued)),
    /other-owner-only/,
  );
  await worker.tick();
  assert.equal(
    sends,
    1,
    "a concrete call already performed in this card's previous attempt is observed, not dispatched again",
  );
  assert.equal(
    (await f.agent.journal.operations("owner", second.nativeTaskId)).filter(
      (operation) => operation.toolName === "gmail_send",
    ).length,
    1,
  );
});

test("a late uncertainty in the previous attempt forbids staging its successor atomically", async (t) => {
  const f = await taskRuntime(t);
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "enable",
    profile: { toolsets: ["kanban"] },
  });
  const board = new KanbanWorkflow(f.db, "owner", "default", { profileExists: () => true });
  const card = await board.create(
    { role: "orchestrator", profile: "default" },
    { title: "Continuation race", assignee: "default" },
    "card",
  );
  await f.agent.routineTick();
  const first = (await board.get(card.id)).currentRun;
  assert.ok(first?.nativeTaskId);
  const nativeId = first.nativeTaskId;
  await f.db.compareAndSwapTask(
    "owner",
    nativeId,
    { status: "queued" },
    { status: "failed", error: "The last command failed." },
  );
  const mutate = f.db.durableMutation.bind(f.db);
  t.mock.method(f.db, "durableMutation", async (...args: Parameters<typeof mutate>) => {
    if (args[1].startsWith("kanban:default:dispatch:"))
      await f.db.put("owner", "task-operations", {
        id: "late-previous-effect",
        taskId: nativeId,
        effect: true,
        status: "outcome_unknown",
        receipt: { data: { cleanupConfirmed: true } },
      });
    return mutate(...args);
  });
  await f.agent.routineTick();
  assert.equal((await f.db.list("owner", "tasks")).length, 1);
  assert.equal((await board.get(card.id)).currentRun, null);
  assert.equal((await board.get(card.id)).nativeContinuationTaskId, nativeId);
  await assert.rejects(
    f.agent.dispatchKanbanCard("owner", "default", card.id, "default", "manual-retry"),
    /sem resultado confirmado/,
  );
  assert.equal((await f.db.list("owner", "tasks")).length, 1);
});
