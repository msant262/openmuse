import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { lastValueFrom, toArray } from "rxjs";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { TaskOutcomeUnknownError } from "../apps/server/src/engine/task-journal.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import { mediaTools } from "../apps/server/src/media-tools.ts";
import { LocalThreads } from "../apps/server/src/threads.ts";
import { createDocumentPdf } from "../packages/integrations/src/document.ts";
import { inspectPdf } from "../packages/integrations/src/pdf.ts";
import { readPdfText } from "../packages/integrations/src/pdf-text.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const documentArgs = {
  name: "Apresentação.pdf",
  title: "Como eu trabalho — ações e limitações",
  format: "pdf",
  content:
    "Operação: recebo uma solicitação e uso ferramentas registradas.\n\nLimitações: não invento conexões nem comprovantes.",
  operationId: "self-description",
};

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
  assert.match(await readPdfText(bytes), /ações e limitações/);
  assert.match(await readPdfText(bytes), /não invento conexões nem comprovantes/);
  assert.deepEqual(await execute(documentArgs), result);
  assert.equal((await server.db.list("owner", "files")).length, 1);
  await assert.rejects(server.files.bytes("other-owner", result.fileId));
  const conflict = await execute({ ...documentArgs, content: "Different content" });
  assert.ok(conflict && typeof conflict === "object" && "error" in conflict);
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
  let workerCreated = false;
  const fixture = await modelFixture(t, (index) => {
    const names = (JSON.parse(fixture.requests[index].body).tools ?? []).map(
      (tool: { name: string }) => tool.name,
    );
    if (index === 0) return { name: "create_document", arguments: documentArgs };
    if (!names.includes("finish_task")) return undefined;
    if (!workerCreated) {
      workerCreated = true;
      return { name: "create_document", arguments: documentArgs };
    }
    return { name: "finish_task", arguments: { summary: "O PDF está pronto e anexado." } };
  });
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
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
  await server.agent.worker.tick();
  const task = await server.agent.getTask("owner", tasks[0].id);
  assert.equal(task.status, "succeeded", task.error ?? task.question);
  assert.equal(task.artifactIds.length, 1);
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

test("worker creates and delivers its own PDF with an effect receipt and verified contents", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? { name: "create_document", arguments: documentArgs }
      : { name: "finish_task", arguments: { summary: "O PDF está pronto e anexado." } },
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
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
