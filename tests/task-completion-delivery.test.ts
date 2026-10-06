import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelMessage } from "@tanstack/ai";
import { bindingHash } from "../apps/server/src/conversation-inbox.ts";
import { ContextBudget } from "../apps/server/src/engine/context-budget.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import type { ComputerSnapshot } from "../packages/domain/src/computer.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("a timed-out Gmail search remains a failed read and the agent retries without asking the user", async (t) => {
  await modelFixture(
    t,
    (index) =>
      [
        {
          name: "search_mail",
          arguments: { query: 'subject:"Own test"', account: "alex@example.com" },
        },
        {
          name: "search_mail",
          arguments: { query: 'subject:"Own test"', account: "alex@example.com" },
        },
        {
          name: "finish_task",
          arguments: { summary: "Busca concluída: nenhum e-mail encontrado." },
        },
      ][index],
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  let reads = 0;
  t.mock.method(server.workspace, "searchMail", async () => {
    if (++reads === 1) throw new Error("The operation was aborted due to timeout");
    return [];
  });
  const task = await server.agent.createTask("owner", {
    prompt: 'Procure no Gmail o e-mail com assunto "Own test".',
  });
  await server.agent.worker.tick();
  const searches = (await server.agent.journal.operations("owner", task.id)).filter(
    (o) => o.toolName === "search_mail",
  );
  assert.equal(reads, 2);
  assert.deepEqual(
    searches.map((o) => [o.effect, o.status]),
    [
      [false, "failed"],
      [false, "succeeded"],
    ],
  );
  assert.equal((await server.agent.getTask("owner", task.id)).status, "succeeded");
  assert.equal((await server.db.list("owner", "interaction-requests")).length, 0);
});

test("maintenance recovers historical Google read timeouts but never releases an uncertain write", async (t) => {
  const server = await taskRuntime(t);
  for (const name of ["search_mail", "execute_google_workspace_tool"]) {
    const task = await server.agent.createTask("owner", { prompt: "Consulte meus e-mails" });
    const id = `uncertain:${task.id}`;
    const op = {
      id,
      taskId: task.id,
      revision: 0,
      bindingHash: bindingHash({ name }),
      executorId: "vps",
      executorEpoch: 1,
      resourceFence: 0,
      status: "outcome_unknown",
      toolName: name,
      args:
        name === "search_mail" ? { query: "in:inbox" } : { toolId: "gmail.users.messages.send" },
      effect: true,
      runToken: "old-run",
      resourceLeaseIds: [],
      createdAt: new Date().toISOString(),
      sequence: 1,
      receipt: { error: "The operation was aborted due to timeout" },
    };
    await server.db.put("owner", "task-operations", op);
    const blocked = await server.db.put("owner", "tasks", {
      ...task,
      status: "waiting_input" as const,
      state: { ...task.state, reconcilingOperationIds: [id] },
    });
    await server.agent.interactions.forTask("owner", blocked);
    assert.equal(await server.agent.recoverGoogleRead("owner", blocked), name === "search_mail");
    const saved = await server.agent.getTask("owner", task.id);
    assert.equal(saved.status, name === "search_mail" ? "queued" : "waiting_input");
    const result = await server.db.get<{ status: string; effect: boolean }>(
      "owner",
      "task-operations",
      id,
    );
    assert.equal(result?.status, name === "search_mail" ? "failed" : "outcome_unknown");
    assert.equal(result?.effect, name !== "search_mail");
    const questions = (
      await server.db.list<{ taskId: string; status: string }>("owner", "interaction-requests")
    ).filter((q) => q.taskId === task.id);
    assert.equal(questions[0].status, name === "search_mail" ? "superseded" : "waiting");
  }
});

test("legacy interrupted streams get an automatic retry while credential failures stay unscheduled", async (t) => {
  const server = await taskRuntime(t);
  for (const nextRunAt of [undefined, null])
    for (const failureCode of [
      undefined,
      "provider_stream_incomplete",
      "invalid_grant",
      "subscription_sharing_usage_limit_exceeded",
    ]) {
      const task = await server.agent.createTask("owner", { prompt: "Consulte minha agenda" });
      const interrupted = await server.db.put("owner", "tasks", {
        ...task,
        status: "waiting_provider" as const,
        nextRunAt,
        state: {
          ...task.state,
          providerCheckpoint: { code: "MODEL_PROVIDER_INTERRUPTED", accepted: true, failureCode },
        },
      });
      const expected = failureCode === undefined || failureCode === "provider_stream_incomplete";
      assert.equal(await server.agent.recoverInterruptedProvider("owner", interrupted), expected);
      const saved = await server.agent.getTask("owner", task.id);
      assert.equal(!!saved.nextRunAt, expected);
      assert.equal(saved.status, "waiting_provider");
    }
});

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

test("image capability lookup does not pin its parallel reference reads as completed effects", async (t) => {
  await modelFixture(
    t,
    (index) =>
      [
        { name: "image_generation_status", arguments: {} },
        {
          name: "create_document",
          arguments: {
            operationId: "context-document",
            name: "context.txt",
            format: "text",
            content: "Verified local document.",
          },
        },
        { name: "finish_task", arguments: { summary: "Created the requested text file." } },
      ][index],
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await server.agent.createTask("owner", {
    prompt: "Check runtime capabilities, then create a small TXT attachment.",
  });
  await server.agent.worker.tick();
  const operations = await server.agent.journal.operations("owner", task.id);
  const lookup = operations.find((op) => op.toolName === "image_generation_status");
  const creation = operations.find((op) => op.toolName === "create_document");
  assert.equal(lookup?.status, "succeeded");
  assert.equal(creation?.status, "succeeded");
  assert.ok(lookup?.toolCallId && creation?.toolCallId);
  const required = await server.agent.journal.requiredHistoryIds("owner", task.id);
  // Reproduce a completed parallel batch: one status read must not make its
  // large design-reference sibling mandatory for every subsequent inference.
  const messages: ModelMessage[] = [
    { role: "user", content: "Deliver the saved document." },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: lookup.toolCallId,
          type: "function",
          function: { name: lookup.toolName, arguments: "{}" },
        },
        {
          id: "reference",
          type: "function",
          function: { name: "design_references", arguments: "{}" },
        },
      ],
    },
    { role: "tool", toolCallId: lookup.toolCallId, content: JSON.stringify(lookup.receipt) },
    { role: "tool", toolCallId: "reference", content: "Optional reference text. ".repeat(1500) },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: creation.toolCallId,
          type: "function",
          function: { name: creation.toolName, arguments: JSON.stringify(creation.args) },
        },
      ],
    },
    { role: "tool", toolCallId: creation.toolCallId, content: JSON.stringify(creation.receipt) },
  ];
  const projected = ContextBudget.limit(messages, {
    requiredOperationIds: required,
    model: { id: "fixture", contextTokens: 16000 },
  });
  assert.ok(
    projected.some(
      (message) => message.role === "tool" && message.toolCallId === creation.toolCallId,
    ),
  );
  assert.ok(
    !projected.some(
      (message) => message.role === "tool" && message.toolCallId === lookup.toolCallId,
    ),
  );
  assert.equal(lookup.effect, false);
  assert.equal(creation.effect, true);
  assert.deepEqual(required, [creation.toolCallId]);
  const saved = await server.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", JSON.stringify(saved.completion));
});

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
  assert.equal(saved.status, "failed");
  assert.equal((await server.db.list("owner", "interaction-requests")).length, 0);
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
  assert.equal(detail.task.status, "failed");
  assert.equal((await server.db.list("owner", "interaction-requests")).length, 0);
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
  assert.equal(saved.status, "failed");
  assert.equal((await server.db.list("owner", "interaction-requests")).length, 0);
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
