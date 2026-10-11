import assert from "node:assert/strict";
import test from "node:test";
import { InteractionRequests } from "../apps/server/src/interaction-requests.ts";
import { procedureInputSchema } from "../packages/domain/src/playbooks.ts";
import { questionSchema } from "../packages/domain/src/runtime.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const question =
  "O IBM tem idioma/duração/credencial bem especificados, porém a emissão da credencial depende de elegibilidade ligada a uma organização participante. Prefere manter a credencial IBM ou escolher outro certificado de curso?";
const schema = {
  title: "Critério da comparação",
  fields: [
    {
      id: "criterio",
      type: "single" as const,
      label: "Qual caminho prefere?",
      options: [
        {
          id: "A",
          label: "Manter IBM; indicar claramente a condição de elegibilidade da credencial",
        },
        { id: "B", label: "Substituir IBM por outra opção de acesso aberto" },
      ],
    },
  ],
};

test("educational credential discussion can be presented and answered without the authentication channel", async (t) => {
  const f = await taskRuntime(t);
  const task = await f.agent.createTask("owner", { prompt: "Compare course certificates." });
  await f.db.put("owner", "tasks", { ...task, status: "waiting_input" });
  const requests = new InteractionRequests(f.db);
  const saved = await requests.create("owner", {
    taskId: task.id,
    revision: task.attempts,
    kind: "question",
    schema,
  });
  await requests.answer("owner", saved.id, {
    clientResponseId: "course-credential-choice",
    revision: task.attempts,
    answer: { criterio: "B" },
  });
  const answered = await requests.status("owner", saved.id);
  assert.equal(answered.kind, "question");
  assert.equal(answered.status, "answered");
  assert.deepEqual(answered.kind === "question" && answered.answer, { criterio: "B" });
  assert.equal((await f.agent.getTask("owner", task.id)).status, "queued");
});

test("actual copied worker allows educational credential prose in ask_user and its canonical receipt", async (t) => {
  await modelFixture(t, (index) =>
    index === 0 ? { name: "ask_user", arguments: { question, schema } } : undefined,
  );
  const f = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    researchReviewEnabled: false,
  });
  const task = await f.agent.createTask("owner", {
    prompt: "Compare course certificates and let me choose the credential I prefer.",
  });
  await f.agent.worker.tick();
  const operation = (await f.agent.journal.operations("owner", task.id)).find(
    (op) => op.toolName === "ask_user",
  );
  assert.equal(operation?.status, "succeeded");
  assert.equal((operation?.receipt as { paused?: boolean })?.paused, true);
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "waiting_input");
  assert.equal(saved.question, question);
  const request = await f.agent.interactions.forTask("owner", saved);
  assert.equal(request.kind, "question");
  assert.equal(request.schema.title, schema.title);
});

test("educational credential document bindings and reusable inputs preserve ordinary data", async (t) => {
  const f = await taskRuntime(t);
  const task = await f.agent.createTask("owner", { prompt: "Fill the course certificate form." });
  await f.db.put("owner", "tasks", { ...task, status: "waiting_input" });
  const requests = new InteractionRequests(f.db);
  const saved = await requests.create(
    "owner",
    {
      taskId: task.id,
      revision: task.attempts,
      kind: "question",
      schema: {
        title: "Dados do certificado",
        fields: [{ id: "issuer", label: "Emissor da credencial educacional", type: "text" }],
      },
    },
    { issuer: { name: "Emissor da credencial educacional", checkbox: false } },
  );
  await requests.answer("owner", saved.id, {
    clientResponseId: "course-issuer",
    revision: task.attempts,
    answer: { issuer: "IBM SkillsBuild" },
  });
  assert.deepEqual((await f.agent.getTask("owner", task.id)).input.fields, {
    "Emissor da credencial educacional": "IBM SkillsBuild",
  });
  const procedure = procedureInputSchema.parse({
    requestId: "educational-certificate",
    sourceTaskId: task.id,
    title: "Comparar certificados",
    inputs: [{ name: "issuer", label: "Emissor da credencial educacional" }],
    steps: ["Compare the educational credential conditions."],
    verification: ["Read the published certificate conditions."],
  });
  assert.equal(procedure.inputs[0].label, "Emissor da credencial educacional");
});

test("authentication credential prompts and secret field identifiers still require the private channel", () => {
  for (const title of [
    "Informe a credencial de login",
    "Enter your IBM credentials",
    "Credenciais de autenticação",
    "Digite sua credencial",
    "Your account credentials",
    "Password for this login",
    "IBM certificate: informe sua senha",
    "Credencial",
  ])
    assert.equal(
      questionSchema.safeParse({
        title,
        fields: [{ id: "reply", label: "Your answer", type: "text" }],
      }).success,
      false,
      title,
    );
  for (const id of ["password", "senha", "access_token", "credential", "credencial"])
    assert.equal(
      questionSchema.safeParse({
        title: "Dados do curso",
        fields: [{ id, label: "Your answer", type: "text" }],
      }).success,
      false,
      id,
    );
});
