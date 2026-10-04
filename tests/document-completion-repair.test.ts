import assert from "node:assert/strict";
import test from "node:test";
import { modelProviderConfig } from "../apps/server/src/providers/config.ts";
import { LocalThreads } from "../apps/server/src/threads.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const documentArgs = {
  name: "Guia.pdf",
  title: "Guia do assistente",
  format: "pdf",
  content:
    "## Operação\n\nO servidor executa ferramentas registradas e preserva os recibos.\n\n## Limites\n\nConexões e resultados precisam ser verificados.",
  operationId: "first-draft",
};
const providers = () =>
  modelProviderConfig("/tmp/completion-repair", {
    ...process.env,
    MODEL_CAPABILITIES: JSON.stringify({
      "openai/fixture": {
        tools: true,
        vision: true,
        structuredOutput: true,
        contextTokens: 131072,
      },
    }),
  });

test("missing external delivery retains terminal partial behavior even with an unreviewed authored document", async (t) => {
  const fixture = await modelFixture(t, (index) =>
    index === 0
      ? { name: "create_document", arguments: documentArgs }
      : { name: "finish_task", arguments: { summary: "PDF criado e enviado." } },
  );
  const server = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    modelProviders: providers(),
  });
  const task = await server.agent.createTask("owner", {
    prompt: "Crie um PDF e envie por email para team@example.test.",
  });
  await server.agent.worker.tick();
  const saved = await server.agent.getTask("owner", task.id);
  assert.equal(saved.status, "failed");
  assert.equal(saved.completion?.status, "partial");
  assert.ok(
    saved.completion?.checks.some(
      (check) => check.criterionId === "requested-send" && !check.passed,
    ),
  );
  assert.equal(fixture.requests.length, 2);
  assert.notEqual(saved.state.documentReviewPending, true);
});

test("rejected finish and prose continuations share the unchanged cumulative budget", async (t) => {
  const fixture = await modelFixture(
    t,
    (index) =>
      index === 0
        ? { name: "create_document", arguments: documentArgs }
        : index === 2
          ? { name: "finish_task", arguments: { summary: "Pronto e revisado." } }
          : undefined,
    { text: () => "Pronto e revisado." },
  );
  const server = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    modelProviders: providers(),
  });
  const task = await server.agent.createTask("owner", { prompt: "Crie um PDF." });
  await server.db.put("owner", "task-budgets", {
    id: task.id,
    revision: 0,
    maxSteps: 4,
    usedSteps: 0,
    maxMilliseconds: 60000,
    usedMilliseconds: 0,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await server.agent.worker.tick();
    const pending = await server.agent.getTask("owner", task.id);
    assert.equal(pending.status, "queued");
    assert.equal(pending.attempts, attempt + 1);
    const budget = await server.db.get<{ maxSteps: number; usedSteps: number }>(
      "owner",
      "task-budgets",
      task.id,
    );
    assert.equal(budget?.maxSteps, 4);
    assert.equal(budget?.usedSteps, (attempt + 1) * 2);
  }
  await server.agent.worker.tick();
  const saved = await server.agent.getTask("owner", task.id);
  assert.equal(saved.status, "waiting_input");
  assert.equal(saved.state.budgetExhausted, true);
  assert.equal(fixture.requests.length, 4);
  assert.equal(await server.db.get("owner", "thread-publications", `task:${task.id}`), null);
  assert.equal(
    (await server.agent.journal.operations("owner", task.id)).filter(
      (entry) => entry.toolName === "create_document",
    ).length,
    1,
  );
  await server.agent.worker.tick();
  assert.equal(fixture.requests.length, 4, "no inference resumes without a budget extension");
});

for (const mode of ["missing", "failed", "prose"] as const)
  test(`a ${mode} document review keeps completion repairable until the actual final bytes pass`, async (t) => {
    let server: Awaited<ReturnType<typeof taskRuntime>>;
    let taskId = "",
      firstFileId = "",
      finalFileId = "";
    const actions =
      mode === "failed"
        ? ["create", "inspect", "reject", "finish", "replace", "inspect", "approve", "finish"]
        : ["create", mode === "prose" ? "prose" : "finish", "inspect", "approve", "finish"];
    const fixture = await modelFixture(
      t,
      async (index) => {
        const action = actions[index];
        if (action === "create") return { name: "create_document", arguments: documentArgs };
        const saved = await server.agent.getTask("owner", taskId);
        if (!firstFileId) firstFileId = saved.artifactIds[0];
        finalFileId = saved.artifactIds[0];
        if (action === "inspect") {
          assert.equal(saved.status, "running");
          assert.equal(
            await server.db.get("owner", "thread-publications", `task:${taskId}`),
            null,
            "a rejected finish must not publish a success claim",
          );
          return {
            name: "inspect_document",
            arguments: { fileId: finalFileId, startPage: 1, pageCount: 4 },
          };
        }
        if (action === "approve" || action === "reject") {
          assert.match(
            fixture.requests[index].body,
            /data:image\/png;base64,/,
            "the review inference receives real pixels",
          );
          const inspections = await server.db.list<{ id: string; fileId: string }>(
            "owner",
            "document-inspections",
          );
          const inspection = inspections.find((entry) => entry.fileId === finalFileId);
          assert.ok(inspection);
          return {
            name: "confirm_document_review",
            arguments: {
              receiptId: inspection.id,
              passed: action === "approve",
              issues: action === "reject" ? ["Shorten the body before delivering."] : [],
            },
          };
        }
        if (action === "replace") {
          assert.equal(saved.status, "running");
          assert.match(fixture.requests[index].body, /repairable/);
          return {
            name: "create_document",
            arguments: {
              ...documentArgs,
              content:
                "## Operação\n\nO servidor valida e executa ferramentas registradas.\n\n## Limites\n\nResultados exigem evidências.",
              operationId: "repaired-draft",
              replaceFileId: firstFileId,
            },
          };
        }
        if (action === "finish")
          return {
            name: "finish_task",
            arguments: { summary: "O PDF revisado está pronto e anexado." },
          };
        return undefined;
      },
      {
        text: (index) =>
          actions[index] === "prose" ? "O PDF revisado está pronto e anexado." : undefined,
      },
    );
    server = await taskRuntime(t, {
      agentBackend: "model",
      model: "openai/fixture",
      modelProviders: providers(),
    });
    assert.ok(server.threads instanceof LocalThreads);
    await server.threads.ensure("owner", `repair-${mode}`);
    const task = await server.agent.createTask("owner", {
      prompt: "Crie um PDF sobre como o assistente funciona.",
      originThreadId: `repair-${mode}`,
    });
    taskId = task.id;
    await server.agent.worker.tick();
    if (mode === "prose") {
      const pending = await server.agent.getTask("owner", taskId);
      assert.equal(pending.status, "queued");
      assert.equal(pending.state.continuation, true);
      assert.notEqual(pending.result, "O PDF revisado está pronto e anexado.");
      assert.equal(await server.db.get("owner", "thread-publications", `task:${taskId}`), null);
      await server.agent.worker.tick();
    }
    const saved = await server.agent.getTask("owner", taskId);
    assert.equal(saved.status, "succeeded", saved.error ?? saved.question);
    assert.equal(saved.completion?.status, "verified");
    assert.equal(fixture.requests.length, actions.length);
    assert.deepEqual(saved.artifactIds, [finalFileId]);
    if (mode === "failed") assert.notEqual(finalFileId, firstFileId);
    const publication = await server.db.get("owner", "thread-publications", `task:${taskId}`);
    assert.equal(publication?.status, "posted");
    const finishes = (await server.agent.journal.operations("owner", taskId)).filter(
      (entry) => entry.toolName === "finish_task",
    );
    if (mode !== "prose") {
      assert.equal(finishes.length, 2);
      assert.deepEqual((finishes[0].receipt as { complete: boolean }).complete, false);
      assert.equal((finishes[0].receipt as { repairable: boolean }).repairable, true);
      assert.equal((finishes[1].receipt as { complete: boolean }).complete, true);
    }
  });
