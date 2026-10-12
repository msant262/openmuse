import assert from "node:assert/strict";
import test from "node:test";
import { modelFixture, richChatFixtureProviders } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

for (const finishFirst of [false, true])
  test(`a rejected native research document repairs instead of asking the user${finishFirst ? " after a partial finish" : " before finish"}, with optional review disabled`, async (t) => {
    let server: Awaited<ReturnType<typeof taskRuntime>>;
    let taskId = "",
      fileId = "",
      receiptId = "";
    const actions = [
      "read",
      "create",
      "inspect",
      "reject",
      ...(finishFirst ? ["partial"] : []),
      "ask",
      "read-alternative",
      "replace",
      "inspect",
      "approve",
      "finish",
    ];
    const fixture = await modelFixture(t, async (index) => {
      const action = actions[index];
      const task = await server.agent.getTask("owner", taskId);
      fileId = task.artifactIds[0] ?? "";
      if (action === "read" || action === "read-alternative") {
        if (action === "read-alternative") {
          assert.equal(task.status, "running");
          assert.equal((await server.db.list("owner", "interaction-requests")).length, 0);
          const question = (await server.agent.journal.operations("owner", taskId)).find(
            (operation) => operation.toolName === "ask_user",
          );
          const receipt = question?.receipt as {
            paused?: boolean;
            repairable?: boolean;
            documentReviews?: Array<{ fileId: string; issues: string[] }>;
          };
          assert.equal(receipt.paused, false);
          assert.equal(receipt.repairable, true);
          assert.deepEqual(
            receipt.documentReviews?.map((review) => review.issues),
            [
              [
                "The selected course duration is unconfirmed. Read a relevant source or select another qualifying course.",
                "Course duration: The selected course duration is unconfirmed. Read a relevant source or select another qualifying course.",
              ],
            ],
          );
          assert.equal(receipt.documentReviews?.[0].fileId, fileId);
        }
        return {
          name: "web_fetch",
          arguments: {
            url: `https://courses.example/${action === "read" ? "first" : "alternative"}`,
          },
        };
      }
      if (action === "create" || action === "replace")
        return {
          name: "create_document",
          arguments: {
            name: "Cursos.pdf",
            title: "Cursos gratuitos de IA",
            format: "pdf",
            operationId: action,
            ...(action === "replace" && { replaceFileId: fileId }),
            content:
              action === "create"
                ? "# Curso inicial\n\nConteúdo gratuito. Duração: não confirmada.\n\nFonte: https://courses.example/first"
                : "# Curso alternativo\n\nConteúdo gratuito, em português, com duas horas de aulas. Certificado opcional custa €20.\n\nFonte: https://courses.example/alternative",
          },
        };
      if (action === "inspect")
        return { name: "inspect_document", arguments: { fileId, pageCount: 4 } };
      if (action === "reject" || action === "approve") {
        assert.match(fixture.requests[index].body, /data:image\/png;base64,/);
        const inspections = await server.db.list<{ id: string; fileId: string }>(
          "owner",
          "document-inspections",
        );
        const inspection = inspections.find((entry) => entry.fileId === fileId);
        assert.ok(inspection);
        receiptId = inspection.id;
        return {
          name: "confirm_document_review",
          arguments: {
            receiptId,
            passed: action === "approve",
            requestAudit:
              action === "reject"
                ? [
                    {
                      requirement: "Course duration",
                      satisfied: false,
                      evidence:
                        "The selected course duration is unconfirmed. Read a relevant source or select another qualifying course.",
                    },
                  ]
                : [
                    {
                      requirement: "Free course content",
                      satisfied: true,
                      evidence: "The alternative source explicitly states free lessons.",
                    },
                    {
                      requirement: "Course language",
                      satisfied: true,
                      evidence: "The alternative source explicitly states Portuguese.",
                    },
                    {
                      requirement: "Course duration",
                      satisfied: true,
                      evidence: "The alternative source explicitly states two hours.",
                    },
                    {
                      requirement: "Certificate price",
                      satisfied: true,
                      evidence:
                        "The alternative source explicitly states an optional certificate costs €20.",
                    },
                  ],
            issues:
              action === "reject"
                ? [
                    "The selected course duration is unconfirmed. Read a relevant source or select another qualifying course.",
                  ]
                : [],
          },
        };
      }
      if (action === "ask") {
        assert.equal(task.state.documentBriefReview ?? null, null);
        assert.equal(task.state.researchDeliveryReview ?? null, null);
        return {
          name: "ask_user",
          arguments: {
            question: "Você prefere trocar o curso por outro ou aceitar a duração não confirmada?",
          },
        };
      }
      return {
        name: "finish_task",
        arguments: {
          summary:
            action === "partial"
              ? "Ainda não revisei todas as informações."
              : "Comparativo revisado em PDF, anexado.",
          outcome: action === "partial" ? "partial" : "completed",
          artifactIds: [fileId],
        },
      };
    });
    const providers = richChatFixtureProviders("/tmp/native-question-recovery");
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
      body: url.endsWith("alternative")
        ? "<main>Free lessons. Language: Portuguese. Duration: two hours. Optional certificate costs €20.</main>"
        : "<main>Free lessons, no duration in this overview.</main>",
    }));
    const task = await server.agent.createTask("owner", {
      prompt:
        "Pesquise um curso gratuito de IA e entregue um PDF comparando conteúdo, idioma, duração e preço do certificado.",
    });
    taskId = task.id;
    await server.agent.worker.tick();
    const saved = await server.agent.getTask("owner", taskId);
    assert.equal(saved.status, "succeeded", saved.error ?? saved.question ?? saved.result);
    assert.equal(saved.completion?.status, "verified");
    assert.equal(fixture.requests.length, actions.length);
    assert.equal(fixture.reviewRequests.length, 0, "no optional second-model review is added");
    assert.equal((await server.db.list("owner", "interaction-requests")).length, 0);
  });

for (const reviewState of ["private-input", "replaced-draft", "no-draft"] as const)
  test(`indispensable private questions remain available with ${reviewState}`, async (t) => {
    let server: Awaited<ReturnType<typeof taskRuntime>>;
    let taskId = "";
    const actions =
      reviewState === "no-draft"
        ? ["read", "ask"]
        : [
            "read",
            "create",
            "inspect",
            "reject",
            ...(reviewState === "replaced-draft" ? ["replace"] : []),
            "ask",
          ];
    const question =
      "Quais são seus horários fixos de trabalho? Preciso deles para montar a agenda de estudo sem conflito com seu trabalho.";
    const fixture = await modelFixture(t, async (index) => {
      const action = actions[index];
      const task = await server.agent.getTask("owner", taskId);
      const fileId = task.artifactIds[0];
      if (action === "read")
        return { name: "web_fetch", arguments: { url: "https://courses.example/open" } };
      if (action === "create" || action === "replace")
        return {
          name: "create_document",
          arguments: {
            name: "Plano.pdf",
            format: "pdf",
            content:
              "# Curso de IA\n\nDuas horas de conteúdo gratuito em português.\n\nA agenda de estudos precisa respeitar seu horário de trabalho.",
            operationId: action,
            ...(action === "replace" && { replaceFileId: fileId }),
          },
        };
      if (action === "inspect")
        return { name: "inspect_document", arguments: { fileId, pageCount: 4 } };
      if (action === "reject") {
        assert.match(fixture.requests[index].body, /data:image\/png;base64,/);
        const inspections = await server.db.list<{ id: string; fileId: string }>(
          "owner",
          "document-inspections",
        );
        const inspection = inspections.find((entry) => entry.fileId === fileId);
        assert.ok(inspection);
        return {
          name: "confirm_document_review",
          arguments: {
            receiptId: inspection.id,
            passed: false,
            requestAudit: [
              {
                requirement:
                  reviewState === "private-input"
                    ? "User's fixed work hours"
                    : "Course content, language and duration",
                satisfied: reviewState !== "private-input",
                evidence:
                  reviewState === "private-input"
                    ? "The requested personal schedule lacks the user's fixed work hours."
                    : "The observed course source states free lessons, two hours, in Portuguese.",
              },
            ],
            issues:
              reviewState === "private-input"
                ? ["The requested personal schedule lacks the user's fixed work hours."]
                : ["Fix this draft's table layout."],
            ...(reviewState === "private-input" && { privateInput: question }),
          },
        };
      }
      return { name: "ask_user", arguments: { question } };
    });
    const providers = richChatFixtureProviders("/tmp/private-question-boundary");
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
      body: "<main>Free lessons, two hours, in Portuguese.</main>",
    }));
    const task = await server.agent.createTask("owner", {
      prompt:
        "Pesquise um curso gratuito de IA e faça um PDF com a agenda de estudos que respeite meus horários fixos de trabalho.",
    });
    taskId = task.id;
    await server.agent.worker.tick();
    const saved = await server.agent.getTask("owner", taskId);
    assert.equal(saved.status, "waiting_input", saved.error ?? saved.result);
    assert.equal(saved.question, question);
    assert.equal(fixture.requests.length, actions.length);
    assert.equal(fixture.reviewRequests.length, 0);
    const interactions = await server.db.list("owner", "interaction-requests");
    assert.equal(interactions.length, 1);
    assert.equal(
      (await server.agent.journal.operations("owner", taskId)).findLast(
        (op) => op.toolName === "ask_user",
      )?.status,
      "succeeded",
    );
  });
