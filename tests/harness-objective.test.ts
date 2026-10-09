import assert from "node:assert/strict";
import test from "node:test";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("research workers receive the same boundary for unstated descriptive fields as their reviewers", async (t) => {
  const model = await modelFixture(t, () => ({
    name: "ask_user",
    arguments: { question: "Fixture pause" },
  }));
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await server.agent.createTask("owner", {
    prompt:
      "Compare three free generative AI courses, including language, duration and certificate cost.",
  });
  await server.agent.worker.tick();
  assert.ok(model.requests.length > 0);
  assert.ok(
    /DESCRIPTIVE_FIELD_SCOPE/.test(model.requests[0]!.body),
    "Worker must receive descriptive-field scope",
  );
  assert.ok(/not stated by the consulted provider/.test(model.requests[0]!.body));
  assert.ok(/does not waive eligibility constraints/.test(model.requests[0]!.body));
  assert.equal((await server.agent.getTask("owner", task.id)).status, "waiting_input");
});

test("confirmed native cleanup releases a failed task's slot even when unrelated maintenance fails", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", { prompt: "Read a public page" });
  assert.ok(await server.agent.workAdmission.claim(task.id, "background", task.id));
  assert.ok(await server.agent.workAdmission.hold(task.id));
  await server.db.put("owner", "tasks", {
    ...task,
    status: "failed",
    state: { ...task.state, nativeAdmissionPending: true },
  });
  await server.agent.journal.prepare("owner", {
    id: "native-read",
    taskId: task.id,
    revision: 0,
    bindingHash: "a".repeat(64),
    executorId: "native",
    executorEpoch: 1,
    resourceFence: 0,
    status: "outcome_unknown",
    toolName: "native.browser",
    args: { operation: "open" },
    effect: true,
    runToken: "old-run",
    resourceLeaseIds: [],
    createdAt: new Date().toISOString(),
    nativeEnvelope: { id: "native-read", kind: "browser" },
    receipt: { status: "outcome_unknown", data: { cleanupConfirmed: true } },
  });
  t.mock.method(server.db, "unfinishedActionLog", async () => {
    throw new Error("Unrelated source is unavailable");
  });
  await assert.rejects(
    () => (server.agent as unknown as { maintain(): Promise<void> }).maintain(),
    /Unrelated source/,
  );
  assert.equal(await server.db.get("__runtime__", "work-admissions", task.id), null);
  assert.equal((await server.agent.getTask("owner", task.id)).state.nativeAdmissionPending, false);
  assert.equal(
    (await server.agent.journal.operations("owner", task.id))[0].status,
    "outcome_unknown",
  );
});

const inventedCriteria = [
  {
    id: "map",
    kind: "artifact" as const,
    description: "A map with official data only",
    referenceId: "br-map-ufs",
    requiredItems: ["Official agency source"],
  },
];

test("a conversational handoff cannot replace the user's objective with invented completion criteria", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask(
    "owner",
    { prompt: "Create an official map", criteria: inventedCriteria },
    undefined,
    false,
    undefined,
    "Crie um infográfico com os percentuais por estado.",
    [
      {
        id: "user-request",
        role: "user",
        content: "Crie um infográfico com os percentuais por estado.",
      },
    ],
  );
  assert.equal(task.prompt, "Crie um infográfico com os percentuais por estado.");
  assert.deepEqual(
    task.criteria?.map((criterion) => criterion.id),
    ["requested-image"],
  );
  assert.ok(!task.criteria?.some((criterion) => criterion.referenceId === "br-map-ufs"));
});

test("retry repairs legacy assistant criteria while retaining the original image requirement", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", {
    prompt: "Crie um infográfico por estado.",
  });
  await server.db.put("owner", "tasks", {
    ...task,
    status: "failed",
    criteria: [...(task.criteria ?? []), ...inventedCriteria],
    state: {
      ...task.state,
      delegatedBrief: "Create an official map",
      conversationContext: { messages: [], priorResults: [] },
    },
  });
  const retried = await server.agent.control("owner", task.id, "retry");
  assert.deepEqual(
    retried.criteria?.map((criterion) => criterion.id),
    ["requested-image"],
  );
  assert.equal(retried.status, "queued");
});

test("explicit API criteria remain authoritative when retrying a task", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", {
    prompt: "Create an official map",
    criteria: inventedCriteria,
  });
  await server.db.put("owner", "tasks", { ...task, status: "failed" });
  const retried = await server.agent.control("owner", task.id, "retry");
  assert.ok(retried.criteria?.some((criterion) => criterion.referenceId === "br-map-ufs"));
});

test("a reviewed complete research answer is delivered despite the model labelling a blocked source partial", async (t) => {
  await modelFixture(
    t,
    (index) =>
      [
        { name: "web_fetch", arguments: { url: "https://news.example/live" } },
        {
          name: "finish_task",
          arguments: {
            outcome: "partial",
            summary:
              "A: 52%; B: 48%. Source: https://news.example/live. The official page was blocked.",
          },
        },
      ][index],
    {
      researchReview: () => ({
        complete: true,
        needsMoreResearch: false,
        missing: [],
        nextSteps: [],
      }),
    },
  );
  const server = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    researchReviewEnabled: true,
  });
  t.mock.method(server.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<article>Count complete: A 52%, B 48%.</article>",
  }));
  const task = await server.agent.createTask("owner", { prompt: "How is the count?" });
  await server.agent.worker.tick();
  const completed = await server.agent.getTask("owner", task.id);
  assert.equal(completed.status, "succeeded", completed.error ?? completed.result);
  assert.equal(completed.completion?.status, "verified");
  assert.match(completed.result ?? "", /52%/);
});
