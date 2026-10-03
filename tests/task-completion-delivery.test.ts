import assert from "node:assert/strict";
import { test } from "node:test";
import { bindingHash } from "../apps/server/src/conversation-inbox.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import type { ComputerSnapshot } from "../packages/domain/src/computer.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const runningComputer: ComputerSnapshot = {
  enabled: true,
  provider: "native",
  status: "running",
  workspacePath: "/workspace",
  network: "public-only",
  profile: "open",
  commands: [],
  executorId: "fixture-computer",
  executorEpoch: 1,
  connected: true,
  trustMode: "restricted",
  containmentGuaranteed: true,
  readiness: { account: { state: "ready" }, runtime: { state: "ready" } },
};

test("a completed computer status lookup verifies observation while its subject is running", async (t) => {
  await modelFixture(
    t,
    (index) =>
      [
        { name: "computer_status", arguments: {} },
        {
          name: "finish_task",
          arguments: { summary: "O computador está conectado e em execução." },
        },
      ][index],
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  server.agent.computer.snapshot = async () => runningComputer;
  const task = await server.agent.createTask("owner", {
    prompt: "Consulte o status do computador e informe o resultado; não execute comandos.",
  });
  await server.agent.worker.tick();
  const saved = await server.agent.getTask("owner", task.id);
  const lookup = (await server.agent.journal.operations("owner", task.id)).find(
    (op) => op.toolName === "computer_status",
  );
  assert.equal(lookup?.effect, false);
  assert.equal(lookup?.status, "succeeded");
  assert.deepEqual(lookup?.receipt, runningComputer);
  assert.equal(saved.status, "succeeded", saved.question);
  assert.equal(saved.completion?.status, "verified");
  assert.ok(saved.completion?.checks.some((check) => check.evidenceIds.includes(lookup?.id ?? "")));
});

test("a failed computer status lookup cannot verify an observation", async (t) => {
  await modelFixture(
    t,
    (index) =>
      [
        { name: "computer_status", arguments: {} },
        { name: "finish_task", arguments: { summary: "The computer is available." } },
      ][index],
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  server.agent.computer.snapshot = async () => {
    throw new Error("Computer status unavailable");
  };
  const task = await server.agent.createTask("owner", { prompt: "Inspect computer readiness" });
  await server.agent.worker.tick();
  const saved = await server.agent.getTask("owner", task.id);
  const lookup = (await server.agent.journal.operations("owner", task.id)).find(
    (op) => op.toolName === "computer_status",
  );
  assert.equal(lookup?.status, "failed");
  assert.equal(saved.status, "waiting_input");
  assert.equal(saved.completion?.status, "unverified");
});

test("a running native command remains pending and cannot verify its effect", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", { prompt: "Run a bounded command" });
  const receipt = { id: "native-job", status: "running", background: true };
  const worker = new TaskWorker(server.db, async (owner, running) => {
    await server.agent.journal.run(
      owner,
      running,
      { id: "native-call", name: "run_computer_command", args: { command: "sleep 1" } },
      async () => receipt,
      true,
    );
    return { status: "waiting_job" };
  });
  t.after(() => worker.stop());
  await worker.tick();
  const [op] = await server.agent.journal.operations("owner", task.id);
  assert.equal(op.effect, true);
  assert.equal(op.status, "running");
  assert.deepEqual(op.receipt, receipt);
  assert.equal((await server.agent.getTask("owner", task.id)).status, "waiting_job");
  assert.equal((await server.agent.verification.assess("owner", task.id, 0)).status, "unverified");
});

const textPlanPrompt =
  "Produza um plano em português com exatamente três passos para organizar uma mesa. Entregue o plano como texto. Não execute comandos nem ações externas. Não altere arquivos existentes.";
const textPlan =
  "1. Retire os itens que não pertencem à mesa.\n2. Agrupe papéis e materiais por categoria.\n3. Organize os itens de uso frequente e limpe a superfície.";

test("finishing an explicitly requested text plan persists its actual output before verification", async (t) => {
  const { requests } = await modelFixture(
    t,
    (index) =>
      [
        {
          name: "set_plan",
          arguments: {
            steps: [
              "Retire os itens que não pertencem à mesa.",
              "Agrupe papéis e materiais por categoria.",
              "Organize os itens de uso frequente e limpe a superfície.",
            ],
          },
        },
        { name: "finish_task", arguments: { summary: textPlan } },
      ][index],
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await server.agent.createTask("owner", { kind: "plan", prompt: textPlanPrompt });
  await server.agent.worker.tick();
  const detail = await server.agent.detail("owner", task.id);
  assert.equal(detail.task.status, "succeeded", detail.task.question);
  assert.equal(detail.task.result, textPlan);
  assert.equal(detail.task.completion?.status, "verified");
  assert.equal(detail.artifacts.length, 1);
  const [artifact] = detail.artifacts;
  assert.equal(artifact.taskId, task.id);
  assert.equal(artifact.revision, 0);
  assert.equal(artifact.kind, "plan");
  assert.equal(artifact.data.text, textPlan);
  assert.deepEqual(artifact.data.steps, [
    "Retire os itens que não pertencem à mesa.",
    "Agrupe papéis e materiais por categoria.",
    "Organize os itens de uso frequente e limpe a superfície.",
  ]);
  assert.ok(detail.task.artifactIds.includes(artifact.id));
  assert.ok(
    detail.task.completion?.checks.some((check) => check.evidenceIds.includes(artifact.id)),
  );
  assert.equal(requests.length, 2);
  assert.equal((await server.db.list("owner", "files")).length, 0);
  assert.equal((await server.db.list("owner", "actions")).length, 0);
});

test("a text plan completion claim without its steps is still unverified", async (t) => {
  await modelFixture(t, () => ({
    name: "finish_task",
    arguments: { summary: "Your requested three-step plan is complete." },
  }));
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await server.agent.createTask("owner", { kind: "plan", prompt: textPlanPrompt });
  await server.agent.worker.tick();
  const detail = await server.agent.detail("owner", task.id);
  assert.equal(detail.task.status, "waiting_input");
  assert.equal(detail.task.completion?.status, "unverified");
  assert.equal(detail.artifacts.length, 0);
});

test("a persisted text plan cannot substitute for a requested external receipt", async (t) => {
  await modelFixture(t, () => ({ name: "finish_task", arguments: { summary: textPlan } }));
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await server.agent.createTask("owner", {
    kind: "plan",
    prompt: `${textPlanPrompt} Envie o plano por email para user@example.test.`,
  });
  await server.agent.worker.tick();
  const saved = await server.agent.getTask("owner", task.id);
  assert.equal(saved.status, "waiting_input");
  assert.notEqual(saved.completion?.status, "verified");
  assert.ok(
    saved.completion?.checks.some(
      (check) => check.criterionId === "requested-send" && !check.passed,
    ),
  );
  assert.equal((await server.db.list("owner", "actions")).length, 0);
});

test("a directive recovers an old status read using fresh evidence without replaying an effect", async (t) => {
  await modelFixture(
    t,
    (index) =>
      [
        { name: "computer_status", arguments: {} },
        {
          name: "finish_task",
          arguments: { summary: "O computador está conectado e em execução." },
        },
      ][index],
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  let reads = 0;
  server.agent.computer.snapshot = async () => {
    reads++;
    return runningComputer;
  };
  const task = await server.agent.createTask("owner", {
    prompt: "Consulte o status do computador",
  });
  await server.agent.journal.prepare("owner", {
    id: "legacy-read",
    taskId: task.id,
    revision: 0,
    bindingHash: bindingHash({}),
    executorId: "vps",
    executorEpoch: 1,
    resourceFence: 0,
    status: "running",
    toolName: "computer_status",
    toolCallId: "legacy-read-call",
    args: {},
    effect: false,
    runToken: "legacy-run",
    resourceLeaseIds: [],
    createdAt: new Date().toISOString(),
    receipt: runningComputer,
  });
  await server.db.compareAndSwapTask(
    "owner",
    task.id,
    { status: task.status },
    { status: "waiting_input", result: "O computador está conectado e em execução." },
  );
  await server.agent.mailbox.enqueue("owner", task.id, {
    clientMessageId: "retry-status",
    text: "Retome a consulta original e leia computer_status novamente.",
  });
  await server.agent.worker.tick();
  const saved = await server.agent.getTask("owner", task.id);
  const operations = await server.agent.journal.operations("owner", task.id);
  const previous = operations.find((op) => op.id === "legacy-read");
  const current = operations.find((op) => op.toolName === "computer_status" && op.revision === 1);
  assert.equal(saved.status, "succeeded", saved.question);
  assert.equal(saved.state.appliedRevision, 1);
  assert.equal(saved.completion?.status, "verified");
  assert.equal(current?.status, "succeeded");
  assert.equal(previous?.status, "running");
  assert.deepEqual(previous?.receipt, runningComputer);
  assert.equal(reads, 1);
  assert.ok(
    saved.completion?.checks.some((check) => check.evidenceIds.includes(current?.id ?? "")),
  );
  assert.ok(saved.completion?.checks.every((check) => !check.evidenceIds.includes("legacy-read")));
  assert.equal(operations.filter((op) => op.effect).length, 0);
});

test("a directive recovers a delivered text plan as an artifact owned by the new revision", async (t) => {
  await modelFixture(t, () => ({ name: "finish_task", arguments: { summary: textPlan } }));
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await server.agent.createTask("owner", { kind: "plan", prompt: textPlanPrompt });
  await server.db.compareAndSwapTask(
    "owner",
    task.id,
    { status: task.status },
    { status: "waiting_input", result: textPlan },
  );
  await server.agent.mailbox.enqueue("owner", task.id, {
    clientMessageId: "retry-text-plan",
    text: "Retome o plano original como texto e entregue os três passos já produzidos.",
  });
  await server.agent.worker.tick();
  const detail = await server.agent.detail("owner", task.id);
  assert.equal(detail.task.status, "succeeded", detail.task.question);
  assert.equal(detail.task.state.appliedRevision, 1);
  assert.equal(detail.task.completion?.status, "verified");
  assert.equal(detail.artifacts.length, 1);
  const [artifact] = detail.artifacts;
  assert.equal(artifact.taskId, task.id);
  assert.equal(artifact.revision, 1);
  assert.equal(artifact.data.text, textPlan);
  assert.ok(detail.task.artifactIds.includes(artifact.id));
  assert.ok(
    detail.task.completion?.checks.some((check) => check.evidenceIds.includes(artifact.id)),
  );
  assert.equal((await server.db.list("owner", "actions")).length, 0);
});

test("a completed direct model response delivers an explicitly requested text plan without a finish tool call", async (t) => {
  await modelFixture(t, () => undefined, { text: () => textPlan });
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await server.agent.createTask("owner", { kind: "plan", prompt: textPlanPrompt });
  await server.agent.worker.tick();
  const detail = await server.agent.detail("owner", task.id);
  assert.equal(detail.task.status, "succeeded", detail.task.question);
  assert.equal(detail.task.completion?.status, "verified");
  assert.equal(detail.artifacts.length, 1);
  assert.equal(detail.artifacts[0].data.text, textPlan);
  assert.equal(detail.artifacts[0].revision, 0);
  assert.equal(detail.operations.length, 0);
});

test("a late transport failure cannot publish a direct model text plan as a completed delivery", async (t) => {
  await modelFixture(t, () => undefined, { text: () => textPlan, lateFailure: () => true });
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await server.agent.createTask("owner", { kind: "plan", prompt: textPlanPrompt });
  await server.agent.worker.tick();
  const detail = await server.agent.detail("owner", task.id);
  assert.notEqual(detail.task.status, "succeeded");
  assert.equal(detail.artifacts.length, 0);
});
