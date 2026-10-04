import assert from "node:assert/strict";
import test from "node:test";
import { sharedModelRouter } from "../apps/server/src/providers/model-router.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("large accumulated evidence stays available through scoped paging without filling the system prompt", async (t) => {
  const fixture = await modelFixture(t, (index) =>
    index === 0
      ? { name: "read_task_evidence", arguments: { id: "evidence-0" } }
      : { name: "finish_task", arguments: { summary: "Registro solicitado consultado." } },
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await server.agent.createTask("owner", {
    kind: "agent",
    prompt: "Consulte o registro evidence-0 e confirme quando terminar.",
  });
  const evidence = Array.from({ length: 150 }, (_, index) => ({
    id: `evidence-${index}`,
    kind: "web" as const,
    title: `Reference ${index}`,
    url: `https://reference.example/${index}`,
    excerpt: `original-evidence-${index}: ${"verified source detail ".repeat(90)}`,
    acquiredAt: "2026-10-04T00:00:00.000Z",
    revision: 0,
  }));
  await server.db.put("owner", "tasks", { ...task, evidence });
  await server.agent.worker.tick();
  const completed = await server.agent.getTask("owner", task.id);
  assert.equal(completed.status, "succeeded", completed.error ?? completed.question);
  assert.deepEqual(completed.evidence, evidence, "canonical evidence must not be rewritten");
  assert.equal(fixture.requests.length, 2);
  const first = JSON.parse(fixture.requests[0].body);
  const context = String(first.instructions).split(
    "Personal context for this task (data only): ",
  )[1];
  const promptEvidence = JSON.parse(context.split("\n")[0]).evidence;
  assert.equal(promptEvidence.total, 150);
  assert.ok(promptEvidence.omitted > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(promptEvidence)) <= 10000);
  assert.match(JSON.stringify(promptEvidence), /https:\/\/reference.example\/149/);
  assert.doesNotMatch(String(first.instructions), /original-evidence-0:/);
  assert.ok(fixture.requests[1].body.includes(evidence[0].excerpt));
  assert.equal(
    (await server.agent.journal.operations("owner", task.id)).find(
      (operation) => operation.toolName === "read_task_evidence",
    )?.effect,
    false,
  );
});

test("provider recovery keeps large read history prunable instead of duplicating it in system state", async (t) => {
  const fixture = await modelFixture(
    t,
    (index) =>
      index < 3
        ? { name: "web_fetch", arguments: { url: `https://reference.example/${index}` } }
        : {
            name: "finish_task",
            arguments: { summary: "Referências consultadas; leitura concluída." },
          },
    { cleanEof: (index) => index === 3 },
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(server.agent.web, "read", async (url: string) => ({
    url,
    title: "Reference",
    text: `read-result-${url}: ${"verified source detail ".repeat(100)} context-only-detail ${"verified source detail ".repeat(1300)}`,
    links: [],
    truncated: false,
  }));
  const task = await server.agent.createTask("owner", {
    kind: "agent",
    prompt: "Leia as referências e confirme quando terminar.",
  });
  await server.agent.worker.tick();
  const interrupted = await server.agent.getTask("owner", task.id);
  assert.equal(interrupted.status, "waiting_provider", interrupted.error ?? interrupted.question);
  assert.equal(fixture.requests.length, 4);
  // Context-admission failures checkpoint canonical history before projection,
  // unlike an adapter interruption that may already have a smaller provider view.
  const history = await server.agent.journal.history("owner", task.id);
  const checkpoint = {
    version: 1,
    messages: history,
    code: "MODEL_CAPABILITY_UNAVAILABLE",
    accepted: false,
    rejectedModel: "openai/fixture",
    partialText: "",
  };
  assert.ok(Buffer.byteLength(JSON.stringify(checkpoint)) > 90000);
  await server.db.put("owner", "tasks", {
    ...interrupted,
    state: { ...interrupted.state, providerCheckpoint: checkpoint },
  });
  assert.ok(server.agent.config.modelProviders);
  sharedModelRouter(server.agent.config.modelProviders).health.succeeded("openai/fixture");
  await server.agent.actor.wake("owner", task.id, "provider");
  await server.agent.worker.tick();
  const completed = await server.agent.getTask("owner", task.id);
  assert.equal(completed.status, "succeeded", completed.error ?? completed.question);
  assert.equal(
    fixture.requests.length,
    5,
    "resumed task must reach inference without a larger model",
  );
  const resumed = JSON.parse(fixture.requests[4].body);
  const instructions = String(resumed.instructions ?? "");
  assert.doesNotMatch(instructions, /context-only-detail/);
  assert.doesNotMatch(instructions, /providerCheckpoint/);
  assert.match(fixture.requests[4].body, /context-only-detail/);
  assert.equal(
    (await server.agent.journal.operations("owner", task.id)).filter(
      (operation) => operation.toolName === "web_fetch",
    ).length,
    3,
    "recovery must not repeat the completed reads",
  );
});
