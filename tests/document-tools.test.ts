import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { lastValueFrom, toArray } from "rxjs";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { TaskOutcomeUnknownError } from "../apps/server/src/engine/task-journal.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import { mediaTools } from "../apps/server/src/media-tools.ts";
import { modelProviderConfig } from "../apps/server/src/providers/config.ts";
import { LocalThreads } from "../apps/server/src/threads.ts";
import { createDocumentPdf } from "../packages/integrations/src/document.ts";
import { inspectPdf } from "../packages/integrations/src/pdf.ts";
import { readPdfText } from "../packages/integrations/src/pdf-text.ts";
import { modelFixture, offeredHostTools } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const documentArgs = {
  name: "Apresentação.pdf",
  title: "Como eu trabalho — ações e limitações",
  format: "pdf",
  content:
    "Operação: recebo uma solicitação e uso ferramentas registradas.\n\nLimitações: não invento conexões nem comprovantes.",
  operationId: "self-description",
};

const visionProviders = () =>
  modelProviderConfig("/tmp/document-test", {
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

async function documentWorkerCall(
  server: Awaited<ReturnType<typeof taskRuntime>>,
  phase: number,
  request: string,
) {
  if (phase === 0) return { name: "create_document", arguments: documentArgs };
  if (phase === 1) {
    const [generation] = await server.db.list<{ id: string; fileId: string }>(
      "owner",
      "document-generations",
    );
    assert.ok(generation.fileId);
    return {
      name: "inspect_document",
      arguments: { fileId: generation.fileId, startPage: 1, pageCount: 4 },
    };
  }
  if (phase === 2) {
    assert.match(
      request,
      /data:image\/png;base64,/,
      "the reviewing turn must receive actual rendered pixels",
    );
    const [inspection] = await server.db.list<{ id: string; pageCount: number; pages: number[] }>(
      "owner",
      "document-inspections",
    );
    assert.deepEqual(
      inspection.pages,
      Array.from({ length: inspection.pageCount }, (_, index) => index + 1),
    );
    return {
      name: "confirm_document_review",
      arguments: { receiptId: inspection.id, passed: true, issues: [] },
    };
  }
  if (phase === 3)
    return { name: "finish_task", arguments: { summary: "O PDF está pronto e anexado." } };
  return undefined;
}

test("create_document publishes a real Portuguese PDF without the remote computer", async (t) => {
  const server = await taskRuntime(t);
  const attachments: string[] = [];
  const tool = mediaTools(server.agent.media, server.agent.computer, "owner", "document-test", {
    model: () => undefined,
    artifact: async (id) => {
      attachments.push(id);
    },
  }).find((entry) => entry.name === "create_document");
  assert.ok(tool?.execute, "the general document tool must be registered");
  const execute = tool.execute as (args: unknown) => Promise<unknown>;
  const result = (await execute(documentArgs)) as { fileId: string; name: string };
  assert.ok(result.fileId);
  assert.equal(result.name, documentArgs.name);
  assert.deepEqual(attachments, [result.fileId]);
  const bytes = await server.files.bytes("owner", result.fileId);
  assert.equal((await inspectPdf(bytes)).pageCount, 1);
  assert.match(await readPdfText(bytes), /ações\s+e\s+limitações/);
  assert.match(await readPdfText(bytes), /não invento conexões nem comprovantes/);
  assert.deepEqual(await execute(documentArgs), result);
  assert.equal((await server.db.list("owner", "files")).length, 1);
  await assert.rejects(server.files.bytes("other-owner", result.fileId));
  const conflict = await execute({ ...documentArgs, content: "Different content" });
  assert.ok(conflict && typeof conflict === "object" && "error" in conflict);
});

test("reading an internal document preview cannot promote it to a task or chat attachment", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", { prompt: "Crie um PDF" });
  const attachments: string[] = [];
  const tools = mediaTools(server.agent.media, server.agent.computer, "owner", `task:${task.id}`, {
    model: () => undefined,
    artifact: async (id) => {
      attachments.push(id);
    },
  });
  const execute = async (name: string, args: unknown) => {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool?.execute);
    return (tool.execute as (args: unknown) => Promise<Record<string, unknown>>)(args);
  };
  const document = await execute("create_document", documentArgs);
  const preview = await execute("inspect_document", {
    fileId: document.fileId,
    startPage: 1,
    pageCount: 2,
  });
  assert.equal(preview.attachment, false);
  assert.equal(preview.fileImage, true);
  assert.deepEqual(attachments, [document.fileId]);
  const reread = await execute("view_file", { fileId: preview.fileId });
  assert.equal(reread.attachment, false, "view_file must preserve internal preview status");
  assert.equal(reread.fileImage, true, "the model must still receive preview pixels");
  assert.deepEqual(attachments, [document.fileId], "view_file must not append an internal preview");
  assert.ok((await server.files.imageContent("owner", preview.fileId as string)).source.value);
  assert.ok(!(await server.files.list("owner")).some((file) => file.id === preview.fileId));
  await assert.rejects(server.files.reference("other-owner", preview.fileId as string));
  // Old or otherwise malformed task metadata cannot make internal pages public deliverables.
  await server.db.compareAndSwapTask(
    "owner",
    task.id,
    { status: "queued" },
    { artifactIds: [document.fileId as string, preview.fileId as string] },
  );
  assert.deepEqual(
    (await server.agent.detail("owner", task.id)).files.map((file) => file.id),
    [document.fileId],
  );
});

test("interrupted document inspection recovers private preview bytes without delivering them", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", { prompt: "Crie um PDF" });
  const document = await server.agent.media.createDocument(
    "owner",
    documentArgs,
    `task:${task.id}`,
  );
  const put = server.db.put.bind(server.db);
  let crash = true;
  t.mock.method(
    server.db,
    "put",
    async (owner: string, kind: string, value: Parameters<typeof put>[2]) => {
      if (kind === "files" && "internal" in value && value.internal && crash) {
        crash = false;
        throw new Error("Crash after private preview bytes");
      }
      return put(owner, kind, value);
    },
  );
  const worker = new TaskWorker(server.db, async (owner, running) => {
    const args = { fileId: document.fileId, startPage: 1, pageCount: 2 };
    await assert.rejects(
      server.agent.journal.run(
        owner,
        running,
        { id: "inspect-private", name: "inspect_document", args },
        () => server.agent.media.inspectDocument(owner, args, `task:${task.id}`, 0),
        true,
      ),
      TaskOutcomeUnknownError,
    );
    return { status: "waiting_input", question: "Reconcile private preview" };
  });
  await worker.tick();
  await worker.stop();
  assert.deepEqual(await server.agent.journal.reconcileFiles("owner", task.id, server.files), []);
  const previews = (
    await server.db.list<{ id: string; internal?: boolean }>("owner", "files")
  ).filter((file) => file.internal);
  assert.equal(previews.length, 1);
  assert.equal((await server.files.reference("owner", previews[0].id)).attachment, false);
  assert.deepEqual(
    (await server.files.list("owner")).map((file) => file.id),
    [document.fileId],
  );
  assert.equal(
    (await server.agent.journal.operations("owner", task.id)).find(
      (operation) => operation.toolName === "inspect_document",
    )?.status,
    "succeeded",
  );
});

test("PDF layout preserves Unicode, long words and the last paragraph across pages", async () => {
  const paragraphs = Array.from(
    { length: 110 },
    (_, index) =>
      `Seção ${index}: ação, informações, café, coração. Cada seção contém conteúdo verificável.`,
  );
  const longWord = "X".repeat(220);
  const pdf = await createDocumentPdf(
    [...paragraphs, longWord, "ÚLTIMA LINHA: conteúdo completo."].join("\n\n"),
    "Apresentação em português — Ω",
  );
  assert.ok((await inspectPdf(pdf)).pageCount > 3);
  const text = await readPdfText(pdf);
  for (let index = 0; index < 110; index++) assert.ok(text.includes(`Seção ${index}:`));
  assert.ok(text.replace(/\s+/g, "").includes(longWord));
  assert.ok(text.includes("ÚLTIMA LINHA: conteúdo completo."));
  assert.deepEqual(
    await createDocumentPdf("Ação", "Título"),
    await createDocumentPdf("Ação", "Título"),
    "rendering must be stable across publication retries",
  );
});

test("text and Markdown preserve UTF-8; bounded and unsupported PDF inputs publish nothing", async (t) => {
  const server = await taskRuntime(t);
  for (const format of ["text", "markdown"] as const) {
    const content = "# Ação e conexões\n\nPortuguês, 日本語 e 🦊.\n";
    const result = await server.agent.media.createDocument(
      "owner",
      { ...documentArgs, name: "../../Anotações", format, content, operationId: format },
      "scope",
    );
    assert.deepEqual(await server.files.bytes("owner", result.fileId), Buffer.from(content));
    assert.equal(result.name, `Anotações.${format === "text" ? "txt" : "md"}`);
    assert.equal(
      (await server.files.get("owner", result.fileId)).mimeType,
      format === "text" ? "text/plain" : "text/markdown",
    );
  }
  for (const content of [
    " ",
    "a".repeat(120001),
    "bad\0text",
    "bad\ud800text",
    "unsupported 🦊",
    "line\n".repeat(5000),
  ]) {
    await assert.rejects(
      server.agent.media.createDocument(
        "owner",
        { ...documentArgs, content, operationId: String(content.length) },
        "rejected",
      ),
    );
  }
  assert.equal((await server.db.list("owner", "files")).length, 2);
});

test("chat document authoring delegates durably and publishes only after the worker produces bytes", async (t) => {
  let phase = 0;
  let server: Awaited<ReturnType<typeof taskRuntime>>;
  const fixture = await modelFixture(t, async (index) => {
    const names = offeredHostTools(fixture.requests[index].body);
    if (index === 0)
      return {
        name: "delegate_task",
        arguments: {
          kind: "agent",
          prompt: "Crie um PDF. Seções obrigatórias: Operação, Limitações.",
        },
      };
    if (!names.includes("finish_task")) return undefined;
    return documentWorkerCall(server, phase++, fixture.requests[index].body);
  });
  server = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    modelProviders: visionProviders(),
  });
  assert.ok(server.threads instanceof LocalThreads);
  await server.threads.ensure("owner", "pdf-handoff");
  await lastValueFrom(
    new ConversationAgent(server.agent.config, server.agent, "owner")
      .run({
        threadId: "pdf-handoff",
        runId: "create-pdf",
        messages: [
          {
            id: "request-pdf",
            role: "user",
            content: "Crie um PDF. Seções obrigatórias: Operação, Limitações.",
          },
        ],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  assert.equal(
    (await server.db.list("owner", "files")).length,
    0,
    "chat must leave authoring to its durable task",
  );
  const tasks = (await server.agent.snapshot("owner")).tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].originThreadId, "pdf-handoff");
  assert.equal(tasks[0].status, "queued");
  assert.equal(fixture.requests.length, 2, "chat completes without waiting for document authoring");
  await server.agent.worker.tick();
  const task = await server.agent.getTask("owner", tasks[0].id);
  assert.equal(task.status, "succeeded", task.error ?? task.question);
  assert.equal(task.artifactIds.length, 1);
  assert.equal(task.completion?.status, "verified");
  const bytes = await server.files.bytes("owner", task.artifactIds[0]);
  assert.equal((await inspectPdf(bytes)).pageCount, 1);
  assert.match(await readPdfText(bytes), /não invento conexões nem comprovantes/);
  await assert.rejects(server.files.bytes("other-owner", task.artifactIds[0]));
  const previews = await server.db.list<{ id: string; previewFileId: string }>(
    "owner",
    "document-inspections",
  );
  assert.ok(previews.length);
  assert.ok(previews.every((preview) => !task.artifactIds.includes(preview.previewFileId)));
  assert.equal(
    (await server.db.get("owner", "thread-publications", `task:${task.id}`))?.status,
    "posted",
  );
});

test("a crash after PDF bytes are published is reconciled from the same file intention", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", { prompt: "Create a PDF" });
  const put = server.db.put.bind(server.db);
  let crash = true;
  t.mock.method(
    server.db,
    "put",
    async (owner: string, kind: string, value: Parameters<typeof put>[2]) => {
      if (kind === "files" && crash) {
        crash = false;
        throw new Error("Crash after writing PDF");
      }
      return put(owner, kind, value);
    },
  );
  const worker = new TaskWorker(server.db, async (owner, running) => {
    const tool = mediaTools(server.agent.media, server.agent.computer, owner, `task:${task.id}`, {
      model: () => undefined,
    }).find((entry) => entry.name === "create_document");
    assert.ok(tool?.execute);
    const execute = tool.execute as (args: unknown) => Promise<unknown>;
    await assert.rejects(
      server.agent.journal.run(
        owner,
        running,
        { id: "create-pdf", name: "create_document", args: documentArgs },
        () => execute(documentArgs),
        true,
      ),
      TaskOutcomeUnknownError,
    );
    return { status: "waiting_input", question: "Reconcile local publication" };
  });
  await worker.tick();
  await worker.stop();
  assert.equal((await server.db.list("owner", "files")).length, 0);
  const recovered = await server.agent.journal.reconcileFiles("owner", task.id, server.files);
  assert.equal(recovered.length, 1);
  assert.equal((await readdir(join(server.directory, "files"))).length, 1);
  const operation = (await server.agent.journal.operations("owner", task.id)).find(
    (entry) => entry.toolName === "create_document",
  );
  assert.equal(operation?.status, "succeeded");
  assert.match(
    await readPdfText(await server.files.bytes("owner", recovered[0])),
    /conexões nem comprovantes/,
  );
  const [generation] = await server.db.list<{
    id: string;
    fileId: string;
    sha256: string;
    designVersion: number;
    scope: string;
  }>("owner", "document-generations");
  assert.equal(generation.fileId, recovered[0]);
  assert.equal(
    generation.designVersion,
    2,
    "crash recovery must retain the visual review contract",
  );
  assert.equal(generation.scope, `task:${task.id}`);
  assert.equal(
    generation.sha256,
    createHash("sha256")
      .update(await server.files.bytes("owner", recovered[0]))
      .digest("hex"),
  );
});

test("PDF completion validates actual authored page text and rejects metadata-only claims", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", {
    prompt: "Create a PDF. Required sections: Operation, Limitations.",
  });
  for (const [body, expected] of [
    [
      "Operation: tools perform work. Limitations: only configured tools are available.",
      "verified",
    ],
    ["An unrelated document with no requested sections.", "unverified"],
  ] as const) {
    const pdf = await PDFDocument.create();
    pdf.setTitle("Operation and Limitations");
    pdf.setSubject("Operation: everything. Limitations: nothing.");
    pdf.addPage().drawText(body, { font: await pdf.embedFont(StandardFonts.Helvetica), size: 10 });
    const file = await server.files.import("owner", "report.pdf", await pdf.save(), "Fixture");
    await server.db.compareAndSwapTask(
      "owner",
      task.id,
      { status: "queued" },
      { artifactIds: [file.id] },
    );
    assert.equal((await server.agent.verification.assess("owner", task.id, 0)).status, expected);
  }
});

test("restart recovers a replacement's review metadata and removes its superseded draft from delivery", async (t) => {
  let server: Awaited<ReturnType<typeof taskRuntime>>;
  let taskId = "",
    originalId = "",
    replacementId = "";
  const fixture = await modelFixture(t, async (index) => {
    const running = await server.agent.getTask("owner", taskId);
    if (index === 0) {
      assert.equal(running.artifactIds.length, 1);
      replacementId = running.artifactIds[0];
      assert.notEqual(replacementId, originalId);
      assert.equal((await server.agent.verification.assess("owner", taskId, 0)).status, "partial");
      return {
        name: "inspect_document",
        arguments: { fileId: replacementId, startPage: 1, pageCount: 4 },
      };
    }
    if (index === 1) {
      assert.match(fixture.requests[index].body, /data:image\/png;base64,/);
      const [inspection] = await server.db.list<{ id: string }>("owner", "document-inspections");
      return {
        name: "confirm_document_review",
        arguments: { receiptId: inspection.id, passed: true, issues: [] },
      };
    }
    if (index === 2)
      return { name: "finish_task", arguments: { summary: "Documento recuperado e revisado." } };
    return undefined;
  });
  server = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    modelProviders: visionProviders(),
  });
  const task = await server.agent.createTask("owner", {
    prompt: "Crie um PDF. Seções obrigatórias: Operação, Limitações.",
  });
  taskId = task.id;
  const original = await server.agent.media.createDocument(
    "owner",
    documentArgs,
    `task:${task.id}`,
  );
  originalId = original.fileId;
  await server.db.compareAndSwapTask(
    "owner",
    task.id,
    { status: "queued" },
    { artifactIds: [originalId] },
  );
  const put = server.db.put.bind(server.db);
  let crash = true;
  t.mock.method(
    server.db,
    "put",
    async (owner: string, kind: string, value: Parameters<typeof put>[2]) => {
      if (
        kind === "document-generations" &&
        "fileId" in value &&
        "replacesFileId" in value &&
        value.replacesFileId === originalId &&
        crash
      ) {
        crash = false;
        throw new Error("Crash before final document metadata");
      }
      return put(owner, kind, value);
    },
  );
  const args = {
    ...documentArgs,
    operationId: "replacement",
    replaceFileId: originalId,
    content: `${documentArgs.content}\n\nConclusão: verifique os resultados antes de entregar.`,
  };
  const worker = new TaskWorker(server.db, async (owner, running) => {
    await assert.rejects(
      server.agent.journal.run(
        owner,
        running,
        { id: "replace-pdf", name: "create_document", args },
        () => server.agent.media.createDocument(owner, args, `task:${task.id}`),
        true,
      ),
      /Crash before final document metadata/,
    );
    return { status: "waiting_input", question: "Recover publication after interruption" };
  });
  await worker.tick();
  await worker.stop();
  const before = await server.agent.getTask("owner", taskId);
  assert.deepEqual(before.artifactIds, [originalId]);
  assert.ok(
    (await server.agent.journal.operations("owner", taskId)).some(
      (operation) => operation.status === "outcome_unknown",
    ),
  );
  await server.db.compareAndSwapTask(
    "owner",
    taskId,
    { status: "waiting_input" },
    { status: "queued" },
  );
  await server.agent.worker.tick();
  const saved = await server.agent.getTask("owner", taskId);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question);
  assert.deepEqual(saved.artifactIds, [replacementId]);
  assert.equal(saved.completion?.status, "verified");
  const generation = (
    await server.db.list<{
      id: string;
      fileId: string;
      designVersion: number;
      replacesFileId?: string;
      sha256: string;
    }>("owner", "document-generations")
  ).find((entry) => entry.fileId === replacementId);
  assert.equal(generation?.designVersion, 2);
  assert.equal(generation?.replacesFileId, originalId);
  assert.equal(
    generation?.sha256,
    createHash("sha256")
      .update(await server.files.bytes("owner", replacementId))
      .digest("hex"),
  );
  assert.deepEqual(
    (await server.agent.detail("owner", taskId)).files.map((file) => file.id),
    [replacementId],
  );
});

test("worker creates and delivers its own PDF with an effect receipt and verified contents", async (t) => {
  let server: Awaited<ReturnType<typeof taskRuntime>>;
  const fixture = await modelFixture(t, (index) =>
    documentWorkerCall(server, index, fixture.requests[index].body),
  );
  server = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    modelProviders: visionProviders(),
  });
  assert.ok(server.threads instanceof LocalThreads);
  await server.threads.ensure("owner", "document-chat");
  const task = await server.agent.createTask("owner", {
    prompt: "Crie um PDF. Seções obrigatórias: Operação, Limitações.",
    originThreadId: "document-chat",
  });
  await server.agent.worker.tick();
  const saved = await server.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question);
  assert.equal(saved.completion?.status, "verified");
  assert.equal(saved.artifactIds.length, 1);
  const op = (await server.agent.journal.operations("owner", task.id)).find(
    (entry) => entry.toolName === "create_document",
  );
  assert.equal(op?.effect, true);
  assert.equal(op?.status, "succeeded");
  const publication = await server.db.get("owner", "thread-publications", `task:${task.id}`);
  assert.equal(publication?.threadId, "document-chat");
  assert.equal(publication?.status, "posted");
});
