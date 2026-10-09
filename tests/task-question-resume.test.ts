import assert from "node:assert/strict";
import test from "node:test";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("a source review requiring indispensable private eligibility information still allows its question", async (t) => {
  await modelFixture(
    t,
    (index) =>
      [
        {
          name: "ask_user",
          arguments: {
            question: "Em qual país você reside? A elegibilidade do curso depende da residência.",
          },
        },
        {
          name: "finish_task",
          arguments: {
            summary: "Não confirmei a elegibilidade sem o país de residência.",
            outcome: "partial",
          },
        },
      ][index],
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", {
    prompt: "Pesquise cursos gratuitos restritos a residentes no meu país, que ainda não informei.",
  });
  await f.db.compareAndSwapTask(
    "owner",
    task.id,
    { status: "queued" },
    {
      state: {
        ...task.state,
        documentBriefReview: {
          revision: 0,
          complete: false,
          userInputRequired: true,
          missing: [
            "The user's country of residence is indispensable to restricted-course eligibility.",
          ],
          nextSteps: [],
          needsMoreResearch: false,
        },
      },
    },
  );
  await f.agent.worker.tick();
  assert.equal((await f.agent.getTask("owner", task.id)).status, "waiting_input");
  assert.equal((await f.db.list("owner", "interaction-requests")).length, 1);
});

test("a repeated answered task question returns its saved answer without another input card", async (t) => {
  let phase = 0;
  let step = 0;
  const { requests } = await modelFixture(t, () => {
    if (phase === 0)
      return { name: "ask_user", arguments: { question: "Qual país para a pesquisa?" } };
    if (step++ === 0)
      return { name: "ask_user", arguments: { question: "Qual país para a pesquisa?" } };
    return {
      name: "finish_task",
      arguments: { summary: "Pesquisa concluída para o Brasil, sem compra." },
    };
  });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", { prompt: "Pesquise promoções de maquiagem" });
  await f.agent.worker.tick();
  const pending = await f.agent.getTask("owner", task.id);
  const card = await f.agent.interactions.forTask("owner", pending);
  await f.agent.interactions.answer("owner", card.id, {
    clientResponseId: "country-answer",
    revision: card.revision,
    answer: { reply: "Brasil" },
  });
  phase = 1;
  await f.agent.worker.tick();
  const result = await f.agent.getTask("owner", task.id);
  assert.equal(result.status, "failed", result.question || result.error || undefined);
  assert.equal((await f.db.list("owner", "interaction-requests")).length, 1);
  assert.ok(requests.some((request) => request.body.includes("already_answered")));
});

test("resume retains every labelled answer and places the latest answer after old tool history", async (t) => {
  let phase = 0;
  const { requests } = await modelFixture(t, () =>
    phase === 0
      ? { name: "ask_user", arguments: { question: "Qual país?" } }
      : phase === 1
        ? { name: "ask_user", arguments: { question: "Qual categoria?" } }
        : {
            name: "finish_task",
            arguments: { summary: "Pesquisa concluída para batom no Brasil." },
          },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", { prompt: "Pesquise promoções" });
  for (const [index, answer] of ["Brasil", "Batom"].entries()) {
    phase = index;
    await f.agent.worker.tick();
    const pending = await f.agent.getTask("owner", task.id);
    const card = await f.agent.interactions.forTask("owner", pending);
    await f.agent.interactions.answer("owner", card.id, {
      clientResponseId: `answer-${index}`,
      revision: card.revision,
      answer: { reply: answer },
    });
  }
  phase = 2;
  requests.length = 0;
  await f.agent.worker.tick();
  const body = JSON.parse(requests[0].body);
  const content = JSON.stringify(body.input ?? body.messages);
  assert.match(content, /Brasil/);
  assert.match(content, /Batom/);
  const last = (body.input ?? body.messages).at(-1);
  assert.equal(last.role, "user");
  assert.match(JSON.stringify(last), /Qual país.*Brasil/);
  assert.match(JSON.stringify(last), /Qual categoria.*Batom/);
});

test("an unverified partial result closes without manufacturing a question", async (t) => {
  await modelFixture(t, () => ({
    name: "finish_task",
    arguments: { summary: "Encontrei as lojas, mas o acesso bloqueou a confirmação dos preços." },
  }));
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", {
    prompt: "Pesquise promoções de maquiagem",
    originThreadId: "makeup",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "failed");
  assert.equal(saved.completion?.status, "unverified");
  assert.ok(!saved.question);
  assert.match(saved.result ?? "", /bloqueou/);
  assert.equal((await f.db.list("owner", "interaction-requests")).length, 0);
  const publications = await f.db.list<{ text: string }>("owner", "thread-publications");
  assert.ok(publications.some((item) => item.text.includes("bloqueou")));
});

test("an explicit stop answer ends without model work or another question and keeps partial evidence", async (t) => {
  const { requests } = await modelFixture(t, () => ({
    name: "ask_user",
    arguments: { question: "Como continuar?" },
  }));
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", { prompt: "Pesquise promoções" });
  await f.agent.worker.tick();
  const pending = await f.agent.getTask("owner", task.id);
  const card = await f.agent.interactions.forTask("owner", pending);
  await f.agent.interactions.answer("owner", card.id, {
    clientResponseId: "stop",
    revision: card.revision,
    answer: { reply: "pode parar por aqui o que voce me mandou foi o suficiente" },
  });
  const before = requests.length;
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "cancelled");
  assert.ok(!saved.question);
  assert.equal(requests.length, before);
  assert.equal((await f.db.list("owner", "interaction-requests")).length, 1);
});

test("negated stop, requests to stop asking, and quoted text keep the task active", async (t) => {
  const f = await taskRuntime(t);
  for (const [index, reply] of [
    "não pare, continue",
    "pare de perguntar e continue pesquisando",
    "stop asking and continue researching",
    "O documento diz 'pode parar por aqui', mas continue",
    '"stop now" is the text to translate',
  ].entries()) {
    const task = await f.agent.createTask("owner", { prompt: "Pesquise promoções" });
    await f.db.compareAndSwapTask(
      "owner",
      task.id,
      { status: "queued" },
      { status: "waiting_input", question: "Detalhe necessário", attempts: 1 },
    );
    const card = await f.agent.interactions.forTask(
      "owner",
      await f.agent.getTask("owner", task.id),
    );
    await f.agent.interactions.answer("owner", card.id, {
      clientResponseId: `negative-stop-${index}`,
      revision: 1,
      answer: { reply },
    });
    assert.equal((await f.agent.getTask("owner", task.id)).state.userRequestedStop, false, reply);
  }
});
