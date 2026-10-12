import assert from "node:assert/strict";
import test from "node:test";
import { modelFixture, richChatFixtureProviders } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("a resumed PDF repair carries its exact review and does not restart general research", async (t) => {
  let server: Awaited<ReturnType<typeof taskRuntime>>;
  let taskId = "";
  let resumedInstructions = "";
  const subsequentInstructions = new Map<number, string>();
  const issue =
    "The source says there is no free certificate; remove the unsupported implication that a paid certificate is available.";
  const fixture = await modelFixture(
    t,
    async (index) => {
      const task = await server.agent.getTask("owner", taskId);
      const fileId = task.artifactIds[0];
      if (index === 7 || index === 9)
        subsequentInstructions.set(index, JSON.parse(fixture.requests[index].body).instructions);
      if (index === 0)
        return { name: "web_fetch", arguments: { url: "https://courses.example/policy" } };
      if (index === 1 || index === 6) {
        if (index === 6)
          resumedInstructions = JSON.parse(fixture.requests[index].body).instructions;
        return {
          name: "create_document",
          arguments: {
            name: "Curso.pdf",
            format: "pdf",
            operationId: `draft-${index}`,
            ...(index === 6 && { replaceFileId: fileId }),
            content: `# Curso de IA\n\nAulas gratuitas em português, duração de duas horas.\n\n${index === 1 ? "Certificado pago." : "Não há certificado gratuito; a fonte não informa uma opção paga."}\n\nFonte: https://courses.example/policy`,
          },
        };
      }
      if (index === 2 || index === 7)
        return { name: "inspect_document", arguments: { fileId, pageCount: 4 } };
      if (index === 3 || index === 8) {
        const inspections = await server.db.list<{ id: string; fileId: string }>(
          "owner",
          "document-inspections",
        );
        const inspection = inspections.find((inspection) => inspection.fileId === fileId);
        assert.ok(inspection);
        return {
          name: "confirm_document_review",
          arguments: {
            receiptId: inspection.id,
            passed: index === 8,
            issues: index === 3 ? [issue] : [],
            requestAudit: [
              {
                requirement: "Certificate availability",
                satisfied: index === 8,
                evidence:
                  index === 3
                    ? issue
                    : "The revised wording matches the observed certificate policy.",
              },
            ],
          },
        };
      }
      if (index === 4 || index === 9)
        return {
          name: "finish_task",
          arguments: {
            summary: "PDF comparativo.",
            outcome: index === 4 ? "partial" : "completed",
            artifactIds: [fileId],
          },
        };
      return undefined;
    },
    { text: (index) => (index === 5 ? "Vou corrigir a redação do PDF existente." : undefined) },
  );
  const providers = richChatFixtureProviders("/tmp/document-resume-context");
  assert.ok(providers.routing);
  providers.routing.capabilities["openai/fixture"].vision = true;
  server = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    modelProviders: providers,
    researchReviewEnabled: false,
  });
  t.mock.method(server.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<main>Free AI lessons. Language: Portuguese. Duration: two hours. No free certificate. No paid certificate offer is listed.</main>",
  }));
  const created = await server.agent.createTask("owner", {
    prompt:
      "Pesquise um curso gratuito de IA e entregue um PDF comparando conteúdo, idioma, duração e certificado.",
  });
  taskId = created.id;
  await server.agent.worker.tick();
  const resumed = await server.agent.getTask("owner", taskId);
  assert.equal(resumed.status, "queued", resumed.error ?? resumed.question);
  assert.equal(resumed.state.artifactSelectionFollowup, true);
  await server.agent.worker.tick();
  const completed = await server.agent.getTask("owner", taskId);
  assert.equal(completed.status, "succeeded", completed.error ?? completed.question);
  assert.equal(completed.completion?.status, "verified");
  assert.equal(fixture.requests.length, 10);
  assert.equal(
    (await server.agent.journal.operations("owner", taskId)).filter(
      (operation) => operation.toolName === "web_fetch",
    ).length,
    1,
  );
  assert.equal((await server.db.list("owner", "interaction-requests")).length, 0);
  assert.ok(
    resumedInstructions.includes(issue),
    "the next inference needs the concrete current correction in its instructions, not only an old receipt",
  );
  assert.doesNotMatch(
    resumedInstructions,
    /Continue research and correct omissions using available sources/,
  );
  assert.match(subsequentInstructions.get(7) ?? "", /"status":"inspection_required"/);
  assert.ok(
    !(subsequentInstructions.get(7) ?? "").includes(issue),
    "the replaced draft's defects must not become requirements for the new bytes",
  );
  assert.doesNotMatch(
    subsequentInstructions.get(9) ?? "",
    /Missing requirements: \["Complete correction_required/,
  );
});
