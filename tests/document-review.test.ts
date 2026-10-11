import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import { DocumentReview } from "../apps/server/src/document-review.ts";
import { tanstackAgent } from "../apps/server/src/engine/tanstack-agent.ts";
import { modelProviderConfig } from "../apps/server/src/providers/config.ts";
import { LocalThreads } from "../apps/server/src/threads.ts";
import { createDocumentPdf } from "../packages/integrations/src/document.ts";
import { modelFixture, offeredHostTools } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6yS8AAAAASUVORK5CYII=",
  "base64",
);

test("actual worker rejects approval of a replaced draft without changing its failed review", async (t) => {
  let firstFileId = "",
    finalFileId = "",
    firstReceiptId = "",
    finalReceiptId = "";
  const document = {
    name: "Current document.pdf",
    format: "pdf",
    content: "# Current document\n\nUseful content.",
    design: { cover: false },
  };
  await modelFixture(
    t,
    (index) =>
      [
        { name: "create_document", arguments: { ...document, operationId: "old-draft" } },
        { name: "inspect_document", arguments: { fileId: firstFileId, pageCount: 4 } },
        {
          name: "confirm_document_review",
          arguments: {
            receiptId: firstReceiptId,
            passed: false,
            issues: ["Correct the draft content."],
          },
        },
        {
          name: "create_document",
          arguments: {
            ...document,
            operationId: "replacement",
            replaceFileId: firstFileId,
            content: "# Current document\n\nCorrected useful content.",
          },
        },
        {
          name: "confirm_document_review",
          arguments: { receiptId: firstReceiptId, passed: true, issues: [] },
        },
        { name: "inspect_document", arguments: { fileId: finalFileId, pageCount: 4 } },
        {
          name: "confirm_document_review",
          arguments: { receiptId: finalReceiptId, passed: true, issues: [] },
        },
        {
          name: "finish_task",
          arguments: { summary: "The current document is attached.", artifactIds: [finalFileId] },
        },
      ][index],
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const capability = f.agent.config.modelProviders?.routing?.capabilities["openai/fixture"];
  assert.ok(capability);
  capability.vision = true;
  const create = f.agent.media.createDocument.bind(f.agent.media);
  t.mock.method(f.agent.media, "createDocument", async (...args: Parameters<typeof create>) => {
    const result = await create(...args);
    if (!firstFileId) firstFileId = result.fileId;
    else finalFileId = result.fileId;
    return result;
  });
  const inspect = f.agent.media.inspectDocument.bind(f.agent.media);
  t.mock.method(f.agent.media, "inspectDocument", async (...args: Parameters<typeof inspect>) => {
    const result = await inspect(...args);
    if (!firstReceiptId) firstReceiptId = result.receiptId;
    else finalReceiptId = result.receiptId;
    return result;
  });
  const task = await f.agent.createTask("owner", { prompt: "Create a PDF with useful content." });
  await f.agent.worker.tick();
  const operations = await f.agent.journal.operations("owner", task.id);
  const confirmations = operations.filter((op) => op.toolName === "confirm_document_review");
  assert.equal(confirmations.length, 3);
  assert.equal(
    confirmations[1].status,
    "failed",
    "an obsolete draft cannot be approved after replacement",
  );
  assert.match((confirmations[1].receipt as { error: string }).error, /replaced|current document/i);
  assert.equal((await f.db.get("owner", "document-reviews", firstReceiptId))?.passed, false);
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question);
  assert.deepEqual(saved.artifactIds, [finalFileId]);
  assert.equal(saved.completion?.status, "verified");
});

test("document review needs image dispatch, exact scope/revision, full page coverage and no failed latest assessment", async (t) => {
  const server = await taskRuntime(t);
  const review = new DocumentReview(server.db, server.files);
  const document = await server.files.importAttachment(
    "owner",
    "source.txt",
    Buffer.from("Current document"),
    "Test",
  );
  const preview = await server.files.importAttachment("owner", "preview.png", png, "Test");
  const scope = { scope: "task:one", revision: 2 };
  const sha256 = digest(await server.files.bytes("owner", document.id));
  const record = (pages: number[]) =>
    review.recordInspection("owner", {
      ...scope,
      fileId: document.id,
      sha256,
      pageCount: 3,
      pages,
      previewFileId: preview.id,
      rendererVersion: "test-1",
    });
  const first = await record([1, 2]);
  assert.equal(
    (await review.pendingAssessment("owner", scope, preview.id, [document.id]))?.pageCount,
    3,
    "the executor must distinguish the displayed pages from the complete document",
  );
  assert.equal(
    (await review.pendingAssessment("owner", scope, preview.id, [document.id]))?.receiptId,
    first.receiptId,
  );
  assert.equal(
    await review.pendingAssessment("other-owner", scope, preview.id, [document.id]),
    undefined,
  );
  assert.equal(
    await review.pendingAssessment("owner", { ...scope, revision: 1 }, preview.id, [document.id]),
    undefined,
  );
  assert.equal(await review.pendingAssessment("owner", scope, preview.id, []), undefined);
  await assert.rejects(
    review.confirm("owner", scope, { receiptId: "a".repeat(64), passed: true, issues: [] }),
    (error: Error) =>
      error.message.includes(first.receiptId) && error.message.includes("not a file ID"),
  );
  await assert.rejects(
    review.confirm("other-owner", scope, { receiptId: first.receiptId, passed: true, issues: [] }),
    (error: Error) =>
      error.message.includes("Current inspections: []") && !error.message.includes(first.receiptId),
  );
  await assert.rejects(
    review.confirm("owner", scope, { receiptId: first.receiptId, passed: true, issues: [] }),
    /image|observ/i,
  );
  await review.recordObserved("owner", { ...scope, revision: 1 }, preview.id);
  await assert.rejects(
    review.confirm("owner", scope, { receiptId: first.receiptId, passed: true, issues: [] }),
    /image|observ/i,
  );
  await review.recordObserved("owner", scope, preview.id);
  await assert.rejects(
    review.confirm("other-owner", scope, { receiptId: first.receiptId, passed: true, issues: [] }),
  );
  await assert.rejects(
    review.confirm(
      "owner",
      { ...scope, scope: "task:two" },
      { receiptId: first.receiptId, passed: true, issues: [] },
    ),
  );
  await review.confirm("owner", scope, { receiptId: first.receiptId, passed: true, issues: [] });
  assert.equal(
    await review.pendingAssessment("owner", scope, preview.id, [document.id]),
    undefined,
  );
  assert.deepEqual((await review.check("owner", scope, document.id, sha256)).missingPages, [3]);
  const last = await record([3]);
  await assert.rejects(
    review.confirm("owner", scope, { receiptId: last.receiptId, passed: true, issues: [] }),
    /image|observ/i,
  );
  await review.recordObserved("owner", scope, preview.id);
  await review.confirm("owner", scope, { receiptId: last.receiptId, passed: true, issues: [] });
  assert.equal((await review.check("owner", scope, document.id, sha256)).passed, true);
  await review.confirm("owner", scope, {
    receiptId: last.receiptId,
    passed: false,
    issues: ["Page 3 label overlaps a table"],
  });
  assert.equal(
    await review.pendingAssessment("owner", scope, preview.id, [document.id]),
    undefined,
    "a failed visual assessment releases tools for correction instead of trapping the reviewer",
  );
  assert.equal((await review.check("owner", scope, document.id, sha256)).passed, false);
  assert.equal(
    (await review.check("owner", { ...scope, revision: 3 }, document.id, sha256)).passed,
    false,
  );
  assert.equal((await review.check("owner", scope, document.id, "a".repeat(64))).passed, false);
});

test("document review rejects changed pixels/bytes and model-supplied false coverage", async (t) => {
  const server = await taskRuntime(t);
  const review = new DocumentReview(server.db, server.files);
  const file = await server.files.importAttachment(
    "owner",
    "source.txt",
    Buffer.from("Original"),
    "Test",
  );
  const preview = await server.files.importAttachment("owner", "preview.png", png, "Test");
  const scope = { scope: "task:one", revision: 0 };
  const args = {
    ...scope,
    fileId: file.id,
    sha256: digest(Buffer.from("Original")),
    pageCount: 1,
    pages: [1],
    previewFileId: preview.id,
    rendererVersion: "test-1",
  };
  await assert.rejects(review.recordInspection("owner", { ...args, pages: [2] }));
  await assert.rejects(review.recordInspection("owner", { ...args, pages: [1, 1] }));
  const receipt = await review.recordInspection("owner", args);
  await review.recordObserved("owner", scope, preview.id);
  await assert.rejects(
    review.confirm("owner", scope, {
      receiptId: receipt.receiptId,
      passed: true,
      issues: ["Clipped"],
    }),
  );
  await writeFile(
    join(server.directory, "files", `${preview.id}.bin`),
    Buffer.concat([png, Buffer.from("changed")]),
  );
  await assert.rejects(
    review.confirm("owner", scope, { receiptId: receipt.receiptId, passed: true, issues: [] }),
    /changed|match/i,
  );
  await writeFile(join(server.directory, "files", `${preview.id}.bin`), png);
  await writeFile(join(server.directory, "files", `${file.id}.bin`), Buffer.from("Modified"));
  await assert.rejects(
    review.confirm("owner", scope, { receiptId: receipt.receiptId, passed: true, issues: [] }),
    /changed|match/i,
  );
  assert.equal((await review.check("owner", scope, file.id, args.sha256)).passed, false);
});

test("new designed files require complete review while legacy PDFs retain their original completion contract", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", { prompt: "Create a PDF" });
  const bytes = await createDocumentPdf("Content", "Title");
  const file = await server.files.import("owner", "report.pdf", bytes, "Test");
  await server.db.compareAndSwapTask(
    "owner",
    task.id,
    { status: "queued" },
    { artifactIds: [file.id] },
  );
  assert.equal((await server.agent.verification.assess("owner", task.id, 0)).status, "verified");
  await server.db.put("owner", "document-generations", {
    id: "generation",
    fileId: file.id,
    sha256: digest(bytes),
    designVersion: 2,
  });
  assert.equal((await server.agent.verification.assess("owner", task.id, 0)).status, "partial");
  const preview = await server.files.importAttachment("owner", "preview.png", png, "Test");
  const review = new DocumentReview(server.db, server.files),
    scope = { scope: `task:${task.id}`, revision: 0 };
  const receipt = await review.recordInspection("owner", {
    ...scope,
    fileId: file.id,
    sha256: digest(bytes),
    pageCount: 1,
    pages: [1],
    previewFileId: preview.id,
    rendererVersion: "test-1",
  });
  await review.recordObserved("owner", scope, preview.id);
  await review.confirm("owner", scope, { receiptId: receipt.receiptId, passed: true, issues: [] });
  assert.equal((await server.agent.verification.assess("owner", task.id, 0)).status, "verified");
});

for (const complete of [true, false])
  test(`image observation is recorded ${complete ? "before subsequent review tool execution" : "never for incomplete provider inference"}`, async (t) => {
    let receiptId = "";
    const model = await modelFixture(
      t,
      (index) =>
        index === 0
          ? { name: "inspect_document", arguments: {} }
          : index === 1
            ? { name: "review", arguments: {} }
            : undefined,
      { partialTool: (index) => !complete && index === 1 },
    );
    const server = await taskRuntime(t);
    const file = await server.files.importAttachment(
      "owner",
      "source.txt",
      Buffer.from("Original"),
      "Test",
    );
    const preview = await server.files.importAttachment(
      "owner",
      "preview.png",
      png,
      "Test",
      undefined,
      "render-operation",
    );
    const review = new DocumentReview(server.db, server.files),
      scope = { scope: "task:vision", revision: 0 };
    let confirmed = false;
    const agent = tanstackAgent({
      model: "openai/fixture",
      maxSteps: 3,
      prompt: "Inspect the rendered document, then review it.",
      providers: modelProviderConfig(server.directory, {
        ...process.env,
        MODEL_CAPABILITIES: JSON.stringify({
          "openai/fixture": {
            tools: true,
            vision: true,
            structuredOutput: true,
            contextTokens: 131072,
          },
        }),
      }),
      loadFileImage: (id) => server.files.imageContent("owner", id),
      onFileImageObserved: (id) => review.recordObserved("owner", scope, id),
      tools: [
        defineTool({
          name: "inspect_document",
          description: "Render the document",
          parameters: z.object({}),
          execute: async () => {
            const receipt = await review.recordInspection("owner", {
              ...scope,
              fileId: file.id,
              sha256: digest(Buffer.from("Original")),
              pageCount: 1,
              pages: [1],
              previewFileId: preview.id,
              rendererVersion: "test-1",
            });
            receiptId = receipt.receiptId;
            return { ...(await server.files.reference("owner", preview.id)), receiptId };
          },
        }),
        defineTool({
          name: "review",
          description: "Confirm visual assessment",
          parameters: z.object({}),
          execute: async () => {
            const result = await review.confirm("owner", scope, {
              receiptId,
              passed: true,
              issues: [],
            });
            confirmed = result.passed;
            return result;
          },
        }),
      ],
    });
    agent.threadId = "vision-review";
    agent.setMessages([{ id: "user", role: "user", content: "Inspect this document" }]);
    if (complete) await agent.runAgent({ runId: "review" });
    else await assert.rejects(agent.runAgent({ runId: "review" }), /confirmação/);
    assert.ok(model.requests[1].body.includes(`data:image/png;base64,${png.toString("base64")}`));
    assert.equal(confirmed, complete);
    if (!complete)
      await assert.rejects(
        review.confirm("owner", scope, { receiptId, passed: true, issues: [] }),
        /image|observ/i,
      );
  });

test("worker replaces a failed reviewed draft, reviews the replacement pixels and publishes only the final document", async (t) => {
  let server: Awaited<ReturnType<typeof taskRuntime>>;
  let taskId = "",
    firstFileId = "",
    finalFileId = "";
  const create = {
    name: "Funcionamento.pdf",
    format: "pdf",
    title: "Como funciona",
    design: { cover: false },
    content:
      "## Funcionamento\n\nUso ferramentas registradas para cumprir pedidos.\n\n## Limitações\n\nNão invento conexões ou resultados.",
    operationId: "draft",
  };
  const fixture = await modelFixture(t, async (index) => {
    if (index === 0) return { name: "create_document", arguments: create };
    const task = await server.agent.getTask("owner", taskId);
    if (index === 1 || index === 4) {
      assert.equal(task.artifactIds.length, 1);
      if (index === 1) firstFileId = task.artifactIds[0];
      else {
        finalFileId = task.artifactIds[0];
        assert.notEqual(finalFileId, firstFileId);
      }
      assert.equal((await server.agent.verification.assess("owner", taskId, 0)).status, "partial");
      return {
        name: "inspect_document",
        arguments: { fileId: task.artifactIds[0], startPage: 1, pageCount: 4 },
      };
    }
    if (index === 2 || index === 5) {
      assert.match(fixture.requests[index].body, /data:image\/png;base64,/);
      const request = JSON.parse(fixture.requests[index].body);
      assert.deepEqual(
        request.tools.map((tool: { name: string }) => tool.name),
        ["tool_call"],
        "assess the displayed pages before resuming unrelated work",
      );
      assert.equal(request.tool_choice, "required");
      assert.equal(
        request.tools[0].parameters.properties.id.const,
        "okami_confirm_document_review",
      );
      if (index === 5) {
        const forcedReview = (request.instructions as string).slice(
          (request.instructions as string).lastIndexOf(
            "Assess the actual document preview in this inference",
          ),
        );
        assert.ok(
          forcedReview.includes("A conclusão precisa de destaque visual"),
          "a replacement's required review must retain the actual earlier rejected issue",
        );
        const earlierOutputs = JSON.parse(fixture.requests[3].body).input;
        const earlierReview = JSON.parse(
          earlierOutputs.findLast((item: { type: string }) => item.type === "function_call_output")
            .output,
        );
        assert.equal(typeof earlierReview.fileId, "string");
        assert.ok(
          forcedReview.includes(`"fileId":${JSON.stringify(earlierReview.fileId)}`),
          "historical rejection must retain the same model-visible file reference as its actual receipt",
        );
        assert.ok(/not additional requirements/.test(forcedReview));
      }
      const receipts = await server.db.list<{ id: string; fileId: string }>(
        "owner",
        "document-inspections",
      );
      const receipt = receipts.find((entry) => entry.fileId === task.artifactIds[0]);
      assert.ok(receipt);
      return {
        name: "confirm_document_review",
        arguments: {
          receiptId: receipt.id,
          passed: index === 5,
          issues: index === 2 ? ["A conclusão precisa de destaque visual"] : [],
        },
      };
    }
    if (index === 3) {
      const offered = offeredHostTools(fixture.requests[index].body);
      assert.ok(offered.includes("create_document") || offered.includes("search_tools"));
      assert.equal((await server.agent.verification.assess("owner", taskId, 0)).status, "partial");
      assert.equal(await server.db.get("owner", "thread-publications", `task:${taskId}`), null);
      return {
        name: "create_document",
        arguments: {
          ...create,
          content: `${create.content}\n\n> Confirme o resultado antes da entrega.`,
          operationId: "corrected",
          replaceFileId: firstFileId,
        },
      };
    }
    if (index === 6)
      return { name: "finish_task", arguments: { summary: "O documento revisado está pronto." } };
    return undefined;
  });
  server = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    modelProviders: modelProviderConfig("/tmp/document-review", {
      ...process.env,
      MODEL_CAPABILITIES: JSON.stringify({
        "openai/fixture": {
          tools: true,
          vision: true,
          structuredOutput: true,
          contextTokens: 131072,
        },
      }),
    }),
  });
  assert.ok(server.threads instanceof LocalThreads);
  await server.threads.ensure("owner", "document-replacement");
  const task = await server.agent.createTask("owner", {
    prompt: "Crie um PDF sobre funcionamento e limitações.",
    originThreadId: "document-replacement",
  });
  taskId = task.id;
  await server.agent.worker.tick();
  const saved = await server.agent.getTask("owner", taskId);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question);
  assert.deepEqual(saved.artifactIds, [finalFileId]);
  assert.equal(saved.completion?.status, "verified");
  assert.ok(
    await server.files.bytes("owner", firstFileId),
    "supersession preserves the original owned file",
  );
  const inspections = await server.db.list<{ id: string; previewFileId: string }>(
    "owner",
    "document-inspections",
  );
  assert.equal(inspections.length, 2);
  assert.ok(inspections.every((entry) => !saved.artifactIds.includes(entry.previewFileId)));
  const detail = await server.agent.detail("owner", taskId);
  assert.deepEqual(
    detail.files.map((file) => file.id),
    [finalFileId],
  );
  assert.equal(
    (await server.db.get("owner", "thread-publications", `task:${taskId}`))?.status,
    "posted",
  );
  const history = JSON.stringify(await server.threads.history("owner", "document-replacement"));
  assert.ok(history.includes("O documento revisado está pronto."));
  assert.ok(!history.includes(firstFileId));
  assert.ok(inspections.every((entry) => !history.includes(entry.previewFileId)));
});

test("worker assesses every displayed batch of a long document and rejects an unrelated write before assessment", async (t) => {
  let server: Awaited<ReturnType<typeof taskRuntime>>;
  let taskId = "",
    attemptedDetour = false;
  const create = {
    name: "Guia.pdf",
    format: "pdf",
    title: "Guia de estudo",
    design: { cover: false },
    content: Array.from(
      { length: 14 },
      (_, i) =>
        `## Etapa ${i + 1}\n\n${Array.from(
          { length: 8 },
          () =>
            "Reserve um período para praticar o que foi aprendido. Revise o resultado, anote as dúvidas e verifique as fontes antes de continuar para a próxima etapa.",
        ).join("\n\n")}`,
    ).join("\n\n"),
    operationId: "long-draft",
  };
  const fixture = await modelFixture(t, async (index) => {
    if (index === 0) return { name: "create_document", arguments: create };
    const task = await server.agent.getTask("owner", taskId);
    const inspections = await server.db.list<{ id: string; pages: number[]; pageCount: number }>(
      "owner",
      "document-inspections",
    );
    const latest = inspections[0];
    const confirmed = latest && (await server.db.get("owner", "document-reviews", latest.id));
    if (latest && !confirmed) {
      const request = JSON.parse(fixture.requests[index].body);
      assert.equal(request.tools.length, 1);
      assert.equal(
        request.tools[0].parameters.properties.id.const,
        "okami_confirm_document_review",
      );
      assert.equal(
        request.tools[0].parameters.properties.args.properties.receiptId.const,
        latest.id,
      );
      assert.match(fixture.requests[index].body, /data:image\/png;base64,/);
      if (!attemptedDetour) {
        attemptedDetour = true;
        return {
          name: "create_document",
          arguments: { ...create, content: "Unrelated replacement", operationId: "detour" },
        };
      }
      return {
        name: "confirm_document_review",
        arguments: { receiptId: latest.id, passed: true, issues: [] },
      };
    }
    const nextPage = latest ? latest.pages.at(-1)! + 1 : 1;
    if (!latest || nextPage <= latest.pageCount)
      return {
        name: "inspect_document",
        arguments: { fileId: task.artifactIds[0], startPage: nextPage, pageCount: 2 },
      };
    return {
      name: "finish_task",
      arguments: { summary: "O guia revisado está pronto.", artifactIds: task.artifactIds },
    };
  });
  server = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    modelProviders: modelProviderConfig("/tmp/document-batches", {
      ...process.env,
      MODEL_CAPABILITIES: JSON.stringify({
        "openai/fixture": {
          tools: true,
          vision: true,
          structuredOutput: true,
          contextTokens: 131072,
        },
      }),
    }),
  });
  const task = await server.agent.createTask("owner", { prompt: "Crie um guia completo em PDF." });
  taskId = task.id;
  await server.agent.worker.tick();
  const saved = await server.agent.getTask("owner", taskId);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question);
  assert.equal(saved.completion?.status, "verified");
  assert.equal(saved.artifactIds.length, 1);
  const inspections = await server.db.list<{ id: string; pages: number[]; pageCount: number }>(
    "owner",
    "document-inspections",
  );
  assert.ok(inspections[0].pageCount > 4, "exercise multiple batches beyond one renderer call");
  const reviews = await server.db.list<{ id: string; passed: boolean }>(
    "owner",
    "document-reviews",
  );
  assert.equal(reviews.length, inspections.length);
  assert.ok(reviews.every((review) => review.passed));
  const operations = (await server.agent.detail("owner", taskId)).operations;
  const writes = operations.filter((op) => op.toolName === "create_document");
  assert.equal(writes.filter((op) => op.status === "succeeded").length, 1);
  assert.equal(
    (await server.db.list("owner", "document-generations")).length,
    1,
    "the detour is rejected before it can author a second document",
  );
  t.diagnostic(`Confirmed ${inspections[0].pageCount} pages in ${inspections.length} batches.`);
});
