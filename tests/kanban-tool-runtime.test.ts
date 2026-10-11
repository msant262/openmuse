import assert from "node:assert/strict";
import test from "node:test";
import { defineTool } from "@copilotkit/runtime/v2";
import { bindingHash } from "../apps/server/src/conversation-inbox.ts";
import { kanbanTaskTools } from "../apps/server/src/engine/kanban-tools.ts";
import { KanbanWorkflow } from "../apps/server/src/engine/kanban-workflow.ts";
import { ToolDiscovery } from "../apps/server/src/engine/tool-discovery.ts";
import { LostLeaseError } from "../apps/server/src/engine/worker.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("a saved explicit kanban opt-in reaches native discovery and creates an owner-scoped card", async (t) => {
  let cardId = "";
  const fixture = await modelFixture(t, (index) => {
    if (index === 0)
      return { name: "search_tools", arguments: { query: "kanban create workflow" } };
    // The unimplemented surface must fail the state assertion below, rather
    // than making the fake provider call a tool it was never offered.
    if (!fixture.requests.at(-1)?.body.includes("kanban_create"))
      return {
        name: "finish_task",
        arguments: { summary: "No workflow capability was available." },
      };
    return [
      undefined,
      { name: "describe_tools", arguments: { names: ["kanban_create", "kanban_show"] } },
      {
        name: "kanban_create",
        arguments: {
          title: "Research",
          body: "Find current sources",
          assignee: "default",
          idempotency_key: "research",
        },
      },
      { name: "kanban_show", arguments: { task_id: cardId } },
      { name: "finish_task", arguments: { summary: "The research card is recorded." } },
    ][index];
  });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  await f.db.put("owner", "execution-profiles", {
    id: "default",
    revision: 1,
    toolsets: ["kanban"],
    board: "pipeline",
  });
  const task = await f.agent.createTask("owner", {
    prompt: "Record a research workflow card with the source-finding specification.",
  });
  const put = f.db.durableMutation.bind(f.db);
  t.mock.method(f.db, "durableMutation", async (...args: Parameters<typeof put>) => {
    const result = await put(...args);
    const created = args[3].find((mutation) => mutation.kind === "kanban-cards:pipeline");
    if (created && result.status === "applied") cardId = created.id;
    return result;
  });
  await f.agent.worker.tick();
  const cards = await f.db.list<{ id: string; title: string; createdBy: string }>(
    "owner",
    "kanban-cards:pipeline",
  );
  assert.equal(cards.length, 1, "the discovered native tool must mutate the actual board");
  assert.equal(cards[0].title, "Research");
  assert.equal(cards[0].createdBy, "default");
  assert.equal((await f.db.list("another-owner", "kanban-cards:pipeline")).length, 0);
  const operations = await f.agent.journal.operations("owner", task.id);
  assert.ok(
    operations.some(
      (operation) => operation.toolName === "kanban_create" && operation.status === "succeeded",
    ),
  );
  assert.ok(
    operations.some(
      (operation) => operation.toolName === "kanban_show" && operation.status === "succeeded",
    ),
  );
  const first = JSON.parse(fixture.requests[0].body);
  assert.ok(
    !first.tools.some((tool: { name: string }) => tool.name === "kanban_create"),
    "full schemas stay deferred",
  );
});

test("delegated children cannot borrow the parent's saved kanban opt-in or a model-provided run identity", async (t) => {
  const fixture = await modelFixture(t, (index) =>
    index === 0
      ? { name: "search_tools", arguments: { query: "kanban" } }
      : { name: "finish_task", arguments: { summary: "Findings returned to the parent." } },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  await f.db.put("owner", "execution-profiles", {
    id: "default",
    revision: 1,
    toolsets: ["kanban"],
    board: "default",
  });
  const parent = await f.agent.createTask(
    "owner",
    { prompt: "Coordinate findings." },
    "parent",
    true,
  );
  const child = await f.agent.createChildTask(
    "owner",
    parent,
    { prompt: "Read the board information and return findings." },
    "child",
  );
  await f.db.compareAndSwapTask(
    "owner",
    child.id,
    { status: "queued" },
    {
      input: {
        ...child.input,
        kanbanTaskId: "claimed-card",
        kanbanRunId: "claimed-run",
        executionProfile: "default",
      },
    },
  );
  await f.agent.worker.tick();
  assert.doesNotMatch(fixture.requests[0].body, /kanban_create|kanban_complete/);
  assert.equal((await f.db.list("owner", "kanban-cards:default")).length, 0);
});

test("saving tool opt-ins through the authenticated API preserves platform isolation and request binding", async (t) => {
  const f = await taskRuntime(t);
  const session = await f.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const { token } = await session.json();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const path = "/api/agent/execution-profiles/default";
  assert.equal((await f.app.request(path)).status, 401);
  const input = {
    expectedRevision: 0,
    requestId: "opt-in",
    profile: {
      toolsets: ["file"],
      platformToolsets: { task: ["kanban"], chat: ["file"] },
      board: "pipeline",
    },
  };
  const saved = await f.app.request(path, { method: "PUT", headers, body: JSON.stringify(input) });
  assert.equal(saved.status, 200);
  const profile = await saved.json();
  assert.equal(profile.revision, 1);
  assert.deepEqual(profile.platformToolsets, { task: ["kanban"], chat: ["file"] });
  const duplicate = await f.app.request(path, {
    method: "PUT",
    headers,
    body: JSON.stringify(input),
  });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), profile);
  const rebound = await f.app.request(path, {
    method: "PUT",
    headers,
    body: JSON.stringify({ ...input, profile: { toolsets: ["kanban"] } }),
  });
  assert.equal(rebound.status, 409);
});

test("a dispatcher-bound worker completes the real card with native completion evidence and cannot route the board", async (t) => {
  let cardId = "";
  const url = "https://sources.example/finding";
  const fixture = await modelFixture(
    t,
    (index) =>
      [
        { name: "web_fetch", arguments: { url } },
        {
          name: "describe_tools",
          arguments: { names: ["kanban_comment", "kanban_heartbeat", "kanban_complete"] },
        },
        {
          name: "kanban_comment",
          arguments: { task_id: cardId, body: "The observed source supports the finding." },
        },
        { name: "kanban_heartbeat", arguments: { note: "Source checked." } },
        { name: "kanban_complete", arguments: { summary: "The observed finding is recorded." } },
      ][index],
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async () => ({
    url,
    contentType: "text/html",
    body: "<main>The observed source supports the finding.</main>",
  }));
  const board = new KanbanWorkflow(f.db, "owner", "pipeline", {
    profileExists: (name) => name === "default",
  });
  const card = await board.create(
    { role: "orchestrator", profile: "default" },
    { title: "Record findings", assignee: "default" },
    "card",
  );
  cardId = card.id;
  const claim = await board.claim(card.id, "default", "claim");
  const task = await f.agent.createTask("owner", {
    prompt: `Read ${url} and record the observed finding.`,
  });
  // This fixture stamps the host binding after an actual canonical claim.
  // No model argument or task input grants this ownership.
  await f.db.put("owner", "kanban-executions", {
    id: task.id,
    board: "pipeline",
    cardId: card.id,
    profile: "default",
    runId: claim.runId,
  });
  await f.agent.worker.tick();
  const completed = await f.agent.getTask("owner", task.id);
  if (completed.status !== "succeeded" || completed.completion?.status !== "verified")
    t.diagnostic(
      JSON.stringify({
        status: completed.status,
        result: completed.result,
        error: completed.error,
        completion: completed.completion,
        card: await board.get(card.id),
        operations: (await f.agent.journal.operations("owner", task.id)).map(
          ({ toolName, status, receipt }) => ({ toolName, status, receipt }),
        ),
      }),
    );
  assert.equal(completed.status, "succeeded");
  assert.equal(
    completed.completion?.status,
    "verified",
    "kanban completion must retain the native verdict, not just success prose",
  );
  assert.equal((await board.get(card.id)).status, "done");
  assert.equal((await board.get(card.id)).currentRun, null);
  assert.equal((await board.comments(card.id)).values[0].author, "default");
  assert.equal((await board.runHistory(card.id)).values[0].outcome, "completed");
  assert.ok(
    (await f.agent.journal.operations("owner", task.id)).every(
      (operation) => operation.status === "succeeded",
    ),
  );
  assert.doesNotMatch(fixture.requests[0].body, /kanban_list|kanban_unblock/);
});

test("discovered handoff schemas describe the actual host artifact and authority contracts", async (t) => {
  const f = await taskRuntime(t);
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "opt-in",
    profile: { toolsets: ["kanban"] },
  });
  const task = await f.agent.createTask(
    "owner",
    { prompt: "Coordinate the findings." },
    "task",
    true,
  );
  const surface = await kanbanTaskTools(
    f.agent,
    "owner",
    task,
    (name, description, parameters, execute) =>
      defineTool({
        name,
        description,
        parameters,
        execute: (args) => execute(parameters.parse(args)),
      }),
  );
  const discovery = new ToolDiscovery(surface.tools);
  const described = JSON.stringify(
    discovery.describe([
      "kanban_complete",
      "kanban_request_review",
      "kanban_attach",
      "kanban_attachments",
    ]),
  );
  assert.doesNotMatch(described, /~\/\.hermes\/cache|HERMES_KANBAN_TASK|HERMES_KANBAN_DB/);
  assert.match(described, /absolute native \/workspace/);
  assert.match(described, /file ID/);
});

test("ordinary native finish closes its assigned card through the same handoff gate", async (t) => {
  const url = "https://sources.example/finding";
  await modelFixture(
    t,
    (index) =>
      [
        { name: "web_fetch", arguments: { url } },
        { name: "finish_task", arguments: { summary: "The observed finding is recorded." } },
      ][index],
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async () => ({
    url,
    contentType: "text/html",
    body: "<main>The observed source supports the finding.</main>",
  }));
  const board = new KanbanWorkflow(f.db, "owner", "pipeline", { profileExists: () => true });
  const card = await board.create(
    { role: "orchestrator", profile: "default" },
    { title: "Read findings", assignee: "default" },
    "card",
  );
  const claim = await board.claim(card.id, "default", "claim");
  const task = await f.agent.createTask("owner", {
    prompt: `Read ${url} and record the observed finding.`,
  });
  await f.db.put("owner", "kanban-executions", {
    id: task.id,
    board: "pipeline",
    cardId: card.id,
    profile: "default",
    runId: claim.runId,
  });
  await f.agent.worker.tick();
  assert.equal((await f.agent.getTask("owner", task.id)).status, "succeeded");
  assert.equal((await f.agent.getTask("owner", task.id)).completion?.status, "verified");
  assert.equal(
    (await board.get(card.id)).status,
    "done",
    "the normal finish tool must not leave its assigned card running",
  );
});

for (const contract of ["goal", "pr"] as const) {
  test(`ordinary native finish cannot bypass the assigned ${contract} completion gate`, async (t) => {
    const url = "https://sources.example/finding";
    await modelFixture(
      t,
      (index) =>
        [
          { name: "web_fetch", arguments: { url } },
          { name: "finish_task", arguments: { summary: "The observed finding is recorded." } },
        ][index],
    );
    const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
    t.mock.method(f.agent.web, "document", async () => ({
      url,
      contentType: "text/html",
      body: "<main>The observed source supports the finding.</main>",
    }));
    const board = new KanbanWorkflow(f.db, "owner", "pipeline", { profileExists: () => true });
    const card = await board.create(
      { role: "orchestrator", profile: "default" },
      {
        title: "Read findings",
        assignee: "default",
        ...(contract === "goal"
          ? { goalMode: true }
          : { completionContract: "https://github.com/okami/research/pull/7" }),
      },
      "card",
    );
    const claim = await board.claim(card.id, "default", "claim");
    const task = await f.agent.createTask("owner", {
      prompt: `Read ${url} and record the observed finding.`,
    });
    await f.db.put("owner", "kanban-executions", {
      id: task.id,
      board: "pipeline",
      cardId: card.id,
      profile: "default",
      runId: claim.runId,
    });
    await f.agent.worker.tick();
    assert.notEqual(
      (await f.agent.getTask("owner", task.id)).status,
      "succeeded",
      "normal delivery cannot replace the required board gate",
    );
    assert.equal((await board.get(card.id)).status, "running");
    assert.equal((await board.get(card.id)).currentRun?.id, claim.runId);
  });
}

for (const contract of ["local", "goal", "pr"] as const) {
  test(`a resumed ${contract} delivery uses the actual assigned handoff gate and saved source`, async (t) => {
    const url = "https://sources.example/finding";
    let reads = 0;
    const fixture = await modelFixture(
      t,
      (index) =>
        [
          { name: "web_fetch", arguments: { url } },
          { name: "ask_user", arguments: { question: "Continue the saved finding?" } },
        ][index],
    );
    const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
    t.mock.method(f.agent.web, "document", async () => {
      reads++;
      return {
        url,
        contentType: "text/html",
        body: "<main>The observed source supports the finding.</main>",
      };
    });
    const board = new KanbanWorkflow(f.db, "owner", "pipeline", { profileExists: () => true });
    const card = await board.create(
      { role: "orchestrator", profile: "default" },
      {
        title: "Read findings",
        assignee: "default",
        ...(contract === "goal"
          ? { goalMode: true }
          : contract === "pr"
            ? { completionContract: "https://github.com/okami/research/pull/7" }
            : {}),
      },
      "card",
    );
    const claim = await board.claim(card.id, "default", "claim");
    const task = await f.agent.createTask("owner", {
      prompt: `Read ${url} and record the observed finding.`,
    });
    await f.db.put("owner", "kanban-executions", {
      id: task.id,
      board: "pipeline",
      cardId: card.id,
      profile: "default",
      runId: claim.runId,
    });
    await f.agent.worker.tick();
    assert.equal((await f.agent.getTask("owner", task.id)).status, "waiting_input");
    await f.agent.answer("owner", task.id, "Continue");
    const queued = await f.agent.getTask("owner", task.id);
    // Represents a recorded delivery awaiting recovery. The source and its
    // canonical receipt were acquired by the actual first worker above.
    const revision = Number(queued.state.appliedRevision ?? 0);
    await f.db.compareAndSwapTask(
      "owner",
      task.id,
      { status: "queued" },
      {
        state: {
          ...queued.state,
          pendingResearchDelivery: {
            summary: "The observed finding is recorded.",
            outcome: "completed",
            artifactIds: [],
            revision,
          },
        },
      },
    );
    const requestsBeforeResume = fixture.requests.length;
    await f.agent.worker.tick();
    const resumed = await f.agent.getTask("owner", task.id);
    if (contract === "local") {
      assert.equal(resumed.status, "succeeded");
      assert.equal(resumed.completion?.status, "verified");
      assert.equal(
        (await board.get(card.id)).status,
        "done",
        "resumed delivery cannot leave its assigned card running",
      );
      assert.ok(
        (await f.agent.journal.operations("owner", task.id)).some(
          (operation) => operation.toolName === "finish_task" && operation.status === "succeeded",
        ),
      );
    } else {
      assert.notEqual(
        resumed.status,
        "succeeded",
        "cached delivery cannot bypass goal or PR verification",
      );
      assert.equal((await board.get(card.id)).status, "running");
      assert.equal((await board.get(card.id)).currentRun?.id, claim.runId);
    }
    assert.equal(reads, 1, "recovery must reuse the actually acquired source");
    assert.equal(
      fixture.requests.length,
      requestsBeforeResume,
      "the saved delivery does not require a new inference",
    );
  });
}

for (const loseRecovery of [false, true]) {
  test(`a lost ${loseRecovery ? "recovery" : "worker"} acknowledgment recovers the committed handoff without another model turn or board mutation`, async (t) => {
    const url = "https://sources.example/finding";
    const fixture = await modelFixture(
      t,
      (index) =>
        [
          { name: "web_fetch", arguments: { url } },
          { name: "finish_task", arguments: { summary: "The observed finding is recorded." } },
        ][index],
    );
    const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
    const read = t.mock.method(f.agent.web, "document", async () => ({
      url,
      contentType: "text/html",
      body: "<main>The observed source supports the finding.</main>",
    }));
    const board = new KanbanWorkflow(f.db, "owner", "pipeline", { profileExists: () => true });
    const card = await board.create(
      { role: "orchestrator", profile: "default" },
      { title: "Read findings", assignee: "default" },
      "card",
    );
    const claim = await board.claim(card.id, "default", "claim");
    const task = await f.agent.createTask("owner", {
      prompt: `Read ${url} and record the observed finding.`,
    });
    await f.db.put("owner", "kanban-executions", {
      id: task.id,
      board: "pipeline",
      cardId: card.id,
      profile: "default",
      runId: claim.runId,
    });
    const mutate = f.db.durableMutation.bind(f.db);
    let interrupted = false;
    t.mock.method(f.db, "durableMutation", async (...args: Parameters<typeof mutate>) => {
      const result = await mutate(...args);
      if (
        !interrupted &&
        result.status === "applied" &&
        args[3].some(
          (mutation) =>
            mutation.kind === "kanban-cards:pipeline" &&
            (mutation.value as { status?: string }).status === "done",
        )
      ) {
        interrupted = true;
        f.agent.worker.abort(task.id, "shutdown");
        throw new LostLeaseError();
      }
      return result;
    });
    if (loseRecovery) {
      const record = f.agent.journal.recordReceipt.bind(f.agent.journal);
      let lost = false;
      t.mock.method(
        f.agent.journal,
        "recordReceipt",
        async (...args: Parameters<typeof record>) => {
          const saved = await record(...args);
          if (!lost && args[1].includes(":recover-handoff:") && saved.status === "succeeded") {
            lost = true;
            f.agent.worker.abort(task.id, "shutdown");
            throw new LostLeaseError();
          }
          return saved;
        },
      );
    }
    await f.agent.worker.tick();
    assert.equal(interrupted, true);
    assert.equal((await f.agent.getTask("owner", task.id)).status, "queued");
    const committed = await board.get(card.id);
    assert.equal(committed.status, "done");
    const requests = fixture.requests.length;
    await f.agent.worker.tick();
    if (loseRecovery) {
      assert.equal((await f.agent.getTask("owner", task.id)).status, "queued");
      await f.agent.worker.tick();
    }
    const recovered = await f.agent.getTask("owner", task.id);
    assert.equal(recovered.status, "succeeded", recovered.error ?? recovered.question);
    assert.equal(recovered.completion?.status, "verified");
    assert.equal(recovered.result, "The observed finding is recorded.");
    assert.deepEqual(
      await board.get(card.id),
      committed,
      "a committed handoff is observed, never executed again",
    );
    assert.equal(read.mock.callCount(), 1);
    assert.equal(fixture.requests.length, requests);
    assert.ok(
      (await f.agent.journal.operations("owner", task.id)).some(
        (operation) => operation.toolName === "finish_task" && operation.status === "succeeded",
      ),
    );
  });
}

test("an ended board card without its atomic native proof cannot manufacture a task completion", async (t) => {
  const fixture = await modelFixture(t, () => undefined);
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const board = new KanbanWorkflow(f.db, "owner", "pipeline", { profileExists: () => true });
  const card = await board.create(
    { role: "orchestrator", profile: "default" },
    { title: "Read findings", assignee: "default" },
    "card",
  );
  const claim = await board.claim(card.id, "default", "claim");
  const task = await f.agent.createTask("owner", {
    prompt: "Read the finding and record the actual result.",
  });
  await f.db.put("owner", "kanban-executions", {
    id: task.id,
    board: "pipeline",
    cardId: card.id,
    profile: "default",
    runId: claim.runId,
  });
  const operation = await f.agent.journal.prepare("owner", {
    id: "legacy-finish",
    taskId: task.id,
    revision: 0,
    bindingHash: bindingHash({ name: "finish_task", args: { summary: "Unverified finding" } }),
    executorId: "task",
    executorEpoch: 1,
    resourceFence: 0,
    status: "queued",
    toolName: "finish_task",
    args: { summary: "Unverified finding" },
    effect: false,
    runToken: "previous-run",
    resourceLeaseIds: [],
    createdAt: new Date().toISOString(),
  });
  const ended = await board.complete(
    claim,
    { summary: "Unverified finding" },
    `${task.id}:${operation.id}`,
  );
  await f.agent.worker.tick();
  const observed = await f.agent.getTask("owner", task.id);
  assert.notEqual(observed.status, "succeeded");
  assert.match(observed.error ?? "", /saved handoff does not verify/i);
  assert.deepEqual(await board.get(card.id), ended);
  assert.equal(fixture.requests.length, 0);
});

test("disabling kanban after dispatch cannot turn an assigned handoff into ordinary task completion", async (t) => {
  const url = "https://sources.example/finding";
  const fixture = await modelFixture(
    t,
    (index) =>
      [
        { name: "web_fetch", arguments: { url } },
        { name: "ask_user", arguments: { question: "Continue the saved finding?" } },
        { name: "finish_task", arguments: { summary: "The recorded finding is delivered." } },
      ][index],
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async () => ({
    url,
    contentType: "text/html",
    body: "<main>The observed source supports the finding.</main>",
  }));
  const board = new KanbanWorkflow(f.db, "owner", "pipeline", { profileExists: () => true });
  const card = await board.create(
    { role: "orchestrator", profile: "default" },
    { title: "Record findings", assignee: "default" },
    "card",
  );
  const claim = await board.claim(card.id, "default", "claim");
  const task = await f.agent.createTask("owner", {
    prompt: `Read ${url} and record the actual finding.`,
  });
  await f.db.put("owner", "kanban-executions", {
    id: task.id,
    board: "pipeline",
    cardId: card.id,
    profile: "default",
    runId: claim.runId,
  });
  await f.agent.worker.tick();
  assert.equal((await f.agent.getTask("owner", task.id)).status, "waiting_input");
  await f.agent.answer("owner", task.id, "Continue");
  await f.db.put("owner", "execution-profiles", {
    id: "default",
    revision: 1,
    disabledToolsets: ["kanban"],
  });
  const requestsBeforeResume = fixture.requests.length;
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.notEqual(
    saved.status,
    "succeeded",
    "removing a tool opt-in must not remove its assigned completion gate",
  );
  assert.equal((await board.get(card.id)).status, "running");
  assert.equal((await board.get(card.id)).currentRun?.id, claim.runId);
  assert.equal(
    fixture.requests.length,
    requestsBeforeResume,
    "the disabled assigned surface is checked before another inference",
  );
});

test("a direction accepted during handoff verification cannot complete the old card or task", async (t) => {
  const url = "https://sources.example/finding";
  await modelFixture(
    t,
    (index) =>
      [
        { name: "web_fetch", arguments: { url } },
        { name: "describe_tools", arguments: { names: ["kanban_complete"] } },
        { name: "kanban_complete", arguments: { summary: "The observed finding is recorded." } },
      ][index],
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async () => ({
    url,
    contentType: "text/html",
    body: "<main>The observed source supports the finding.</main>",
  }));
  const board = new KanbanWorkflow(f.db, "owner", "pipeline", { profileExists: () => true });
  const card = await board.create(
    { role: "orchestrator", profile: "default" },
    { title: "Read findings", assignee: "default" },
    "card",
  );
  const claim = await board.claim(card.id, "default", "claim");
  const task = await f.agent.createTask("owner", {
    prompt: `Read ${url} and record the observed finding.`,
  });
  await f.db.put("owner", "kanban-executions", {
    id: task.id,
    board: "pipeline",
    cardId: card.id,
    profile: "default",
    runId: claim.runId,
  });
  const assess = f.agent.verification.assess.bind(f.agent.verification);
  let revised = false;
  t.mock.method(f.agent.verification, "assess", async (...args: Parameters<typeof assess>) => {
    const proof = await assess(...args);
    if (args[1] === task.id && proof.status === "verified" && !revised) {
      revised = true;
      await f.agent.mailbox.enqueue("owner", task.id, {
        clientMessageId: "new-direction",
        text: "Also read the second source before concluding.",
        expectedRevision: 0,
      });
    }
    return proof;
  });
  await f.agent.worker.tick();
  assert.ok(revised, "the direction must race after a real passing assessment");
  assert.equal(
    (await board.get(card.id)).status,
    "running",
    "a stale native proof must not close the board run",
  );
  assert.equal((await board.get(card.id)).currentRun?.id, claim.runId);
  assert.notEqual((await f.agent.getTask("owner", task.id)).status, "succeeded");
});

test("kanban completion keeps an unrelated uncertain business effect pending", async (t) => {
  const url = "https://sources.example/finding";
  await modelFixture(
    t,
    (index) =>
      [
        { name: "web_fetch", arguments: { url } },
        { name: "describe_tools", arguments: { names: ["kanban_complete"] } },
        { name: "kanban_complete", arguments: { summary: "The observed finding is recorded." } },
      ][index],
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async () => ({
    url,
    contentType: "text/html",
    body: "<main>The observed source supports the finding.</main>",
  }));
  const board = new KanbanWorkflow(f.db, "owner", "pipeline", { profileExists: () => true });
  const card = await board.create(
    { role: "orchestrator", profile: "default" },
    { title: "Read findings", assignee: "default" },
    "card",
  );
  const claim = await board.claim(card.id, "default", "claim");
  const task = await f.agent.createTask("owner", {
    prompt: `Read ${url} and record the observed finding.`,
  });
  await f.db.put("owner", "kanban-executions", {
    id: task.id,
    board: "pipeline",
    cardId: card.id,
    profile: "default",
    runId: claim.runId,
  });
  const operation = await f.agent.journal.prepare("owner", {
    id: "prior-business-effect",
    taskId: task.id,
    revision: 0,
    bindingHash: bindingHash({ effect: "send" }),
    executorId: "task",
    executorEpoch: 1,
    resourceFence: 0,
    status: "outcome_unknown",
    toolName: "send_email",
    args: {},
    effect: true,
    runToken: "previous-run",
    resourceLeaseIds: [],
    createdAt: new Date().toISOString(),
  });
  await f.agent.worker.tick();
  assert.equal((await board.get(card.id)).status, "running");
  assert.equal((await board.get(card.id)).currentRun?.id, claim.runId);
  assert.notEqual((await f.agent.getTask("owner", task.id)).status, "succeeded");
  const operations = await f.agent.journal.operations("owner", task.id);
  assert.equal(operations.find((entry) => entry.id === operation.id)?.status, "outcome_unknown");
  assert.ok(
    operations.some(
      (entry) =>
        entry.toolName === "kanban_complete" &&
        entry.status === "failed" &&
        /uncertain result/.test(JSON.stringify(entry.receipt)),
    ),
  );
});
