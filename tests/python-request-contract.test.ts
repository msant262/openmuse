import assert from "node:assert/strict";
import test from "node:test";
import { taskCriteria } from "../apps/server/src/engine/task-verification.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("an explicit Python session remains a mandatory execution obligation alongside its external work", async (t) => {
  const f = await taskRuntime(t);
  const prompt =
    "Use uma sessão Python para criar dois compromissos de teste na minha agenda da conta test@example.com para amanhã: QA Python A 20261010 às 11h e QA Python B 20261010 às 12h, ambos com 15 minutos de duração, no fuso Europe/Berlin. Guarde os resultados na sessão para eu continuar depois.";
  const task = await f.agent.createTask("owner", {
    prompt,
    criteria: [{ id: "model-result", kind: "observation", description: "Done", requiredItems: [] }],
  });
  assert.ok(task.criteria?.some((c) => c.id === "requested-python-session"));
  assert.ok(task.criteria?.some((c) => c.effect === "calendar.create"));
});

test("positive interpreter instructions require a Python session, while explanation, quotation and refusal do not", () => {
  for (const prompt of [
    "Use uma sessão Python para calcular o total e guarde o resultado.",
    "Use Python to calculate the total and keep the variables for later.",
    "Continue na mesma sessão Python e consulte o resultado salvo.",
    "Na sessão Python, execute a função que definimos para buscar os eventos.",
    "Calculate the total in the same Python session.",
    "Execute a função Python que definimos e mostre o resultado.",
    "Run the Python function and keep its result.",
  ])
    assert.ok(
      taskCriteria({ kind: "agent", prompt }).some((c) => c.id === "requested-python-session"),
      prompt,
    );
  for (const prompt of [
    "Explique como usar uma sessão Python.",
    "Explain how to use a Python session.",
    "Não use uma sessão Python; só explique o exemplo.",
    "Do not use Python, explain the calculation.",
    "Escreva uma função Python em um arquivo, sem executar.",
    'Traduza a frase "Use uma sessão Python para somar os valores".',
  ])
    assert.ok(
      !taskCriteria({ kind: "agent", prompt }).some((c) => c.id === "requested-python-session"),
      prompt,
    );
});

test("executing an existing function is an execution request even when its language comes from conversation context", () => {
  assert.ok(
    taskCriteria({
      kind: "agent",
      prompt: "Execute a função que definimos para calcular o total.",
    }).some((c) => c.effect === "command"),
  );
});

test("ordinary shell, JavaScript and unbound Python results cannot stand in for the requested interpreter", async (t) => {
  const f = await taskRuntime(t);
  const task = await f.agent.createTask("owner", {
    prompt: "Use uma sessão Python para calcular o total e guarde o resultado.",
  });
  for (const [id, toolName, args, receipt] of [
    [
      "shell",
      "run_computer_command",
      { command: "python3 -c 'print(42)'" },
      { id: "shell", status: "succeeded", exitCode: 0, stdout: "42" },
    ],
    [
      "javascript",
      "execute_code",
      { code: "return 42;", language: "javascript" },
      { status: "completed", value: 42 },
    ],
    [
      "unbound-python",
      "execute_code",
      { code: "total = 42", language: "python" },
      { command: { id: "unrelated", status: "succeeded" }, result: { status: "ok", stdout: "42" } },
    ],
  ] as const) {
    await f.agent.journal.prepare("owner", {
      id,
      taskId: task.id,
      revision: 0,
      executorId: "vps",
      executorEpoch: 1,
      resourceFence: 0,
      runToken: "fixture",
      resourceLeaseIds: [],
      createdAt: new Date().toISOString(),
      status: "succeeded",
      toolName,
      bindingHash: "a".repeat(64),
      effect: toolName === "run_computer_command",
      args,
      receipt,
    });
    const assessment = await f.agent.verification.assess("owner", task.id, 0);
    assert.ok(
      assessment.checks.some((c) => c.criterionId === "requested-python-session" && !c.passed),
      id,
    );
    await f.db.remove("owner", "task-operations", id);
  }
});

test("accepted directions can request or remove the interpreter obligation without preserving a stale requirement", async (t) => {
  const f = await taskRuntime(t);
  const task = await f.agent.createTask("owner", { prompt: "Consulte o status do computador." });
  const directed = {
    ...task,
    state: {
      ...task.state,
      appliedRevision: 1,
      directives: [{ seq: 1, text: "Use uma sessão Python e guarde o resultado." }],
    },
  };
  await f.db.put("owner", "tasks", directed);
  assert.ok(
    (await f.agent.verification.assess("owner", task.id, 1)).checks.some(
      (c) => c.criterionId === "requested-python-session",
    ),
  );
  await f.db.put("owner", "tasks", {
    ...directed,
    state: {
      ...directed.state,
      appliedRevision: 2,
      directives: [
        ...directed.state.directives,
        { seq: 2, text: "Não use Python; apenas mostre o status do computador." },
      ],
    },
  });
  const revised = await f.agent.verification.assess("owner", task.id, 2);
  assert.ok(!revised.checks.some((c) => c.criterionId === "requested-python-session"));
  assert.notEqual(
    revised.status,
    "verified",
    "removing the runtime requirement must not remove every remaining obligation",
  );
});

test("a successful ordinary read cannot finish a task that still owes its requested Python session", async (t) => {
  const fixture = await modelFixture(
    t,
    (index) =>
      [
        { name: "computer_status", arguments: {} },
        {
          name: "finish_task",
          arguments: { summary: "O computador está conectado e o resultado foi salvo." },
        },
        {
          name: "finish_task",
          arguments: {
            outcome: "partial",
            summary: "A consulta foi feita; a sessão Python solicitada não foi executada.",
          },
        },
      ][index],
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  let reads = 0;
  f.agent.computer.snapshot = async () => {
    reads++;
    return {
      enabled: true,
      provider: "native",
      status: "running",
      workspacePath: "/workspace",
      network: "public-only",
      profile: "open",
      maxTimeoutMs: 3000,
      commands: [],
    };
  };
  const task = await f.agent.createTask("owner", {
    prompt:
      "Use uma sessão Python para consultar o status do computador e guarde o resultado na sessão.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.notEqual(saved.status, "succeeded");
  assert.ok(
    saved.completion?.checks.some((c) => c.criterionId === "requested-python-session" && !c.passed),
  );
  assert.equal(reads, 1, "repair must preserve the successful read instead of repeating it");
  assert.ok(fixture.requests.length >= 3);
});

test("a configured Python request exposes the interpreter schema and workflow in the first provider request", async (t) => {
  const fixture = await modelFixture(t, () => ({
    name: "finish_task",
    arguments: { outcome: "partial", summary: "No interpreter was run." },
  }));
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  Object.assign(f.agent.computer, {
    pythonAvailable: async () => true,
    python: async () => assert.fail("this fixture checks the initial surface, not execution"),
  });
  await f.agent.createTask("owner", {
    prompt: "Use uma sessão Python para calcular o total e guarde o resultado.",
  });
  await f.agent.worker.tick();
  const request = JSON.parse(fixture.requests[0].body);
  const tools = request.tools.flatMap(
    (t: { name?: string; tools?: { name?: string }[] }) => t.tools ?? [t],
  );
  const interpreter = tools.find((t: { name?: string }) => t.name === "execute_code");
  assert.ok(interpreter);
  assert.ok(interpreter.parameters.properties.language.enum.includes("python"));
  assert.ok(interpreter.parameters.properties.language.enum.includes("javascript"));
  assert.match(request.instructions, /requested Python session/);
  assert.match(request.instructions, /hermes_tools/);
  assert.match(request.instructions, /already confirmed/);
});
