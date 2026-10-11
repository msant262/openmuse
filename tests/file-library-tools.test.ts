import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { computerTools } from "../apps/server/src/computer-tools.ts";
import type { FileLibrary } from "../apps/server/src/file-library.ts";
import { mediaTools } from "../apps/server/src/media-tools.ts";
import { createDocumentPdf } from "../packages/integrations/src/document.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("saved-file media filters accept MIME families and an empty query lists the newest upload first", async (t) => {
  const f = await taskRuntime(t);
  const old = await f.files.importAttachment(
    "owner",
    "older.mp3",
    Buffer.from("old"),
    "Audio",
    "audio/mpeg",
  );
  await f.db.put("owner", "files", { ...old, createdAt: "2026-10-01T00:00:00Z" });
  const task = await f.agent.createTask("owner", { prompt: "Deliver older.mp3" });
  await f.db.put("owner", "tasks", { ...task, status: "succeeded", artifactIds: [old.id] });
  const current = await f.files.importAttachment(
    "owner",
    "new-upload.m4a",
    Buffer.from("new"),
    "Uploaded by you",
    "audio/mp4",
  );
  await f.files.importAttachment(
    "owner",
    "notes.txt",
    Buffer.from("notes"),
    "Uploaded by you",
    "text/plain",
  );
  const search = mediaTools(f.agent.media, f.agent.computer, "owner", "media-filter", {
    model: () => undefined,
  }).find((tool) => tool.name === "search_saved_files");
  assert.ok(search?.execute);
  for (const mimeType of ["audio/", "audio/*"]) {
    const result = (await search.execute({ query: "", mimeType } as never)) as {
      files: { fileId: string }[];
      total: number;
    };
    assert.equal(result.total, 2);
    assert.equal(result.files[0].fileId, current.id);
  }
  const exact = (await search.execute({ query: "", mimeType: "audio/mpeg" } as never)) as {
    files: { fileId: string }[];
  };
  assert.deepEqual(
    exact.files.map((file) => file.fileId),
    [old.id],
  );
});

test("the harness finds, reads and redelivers a saved PDF without the computer", async (t) => {
  const server = await taskRuntime(t);
  const bytes = await createDocumentPdf(
    "Trilha de cursos de IA",
    "Curso introdutório de inteligência artificial. Plano de quatro semanas.",
  );
  const pdf = await server.files.import(
    "owner",
    "TrilhaCursosIA.pdf",
    bytes,
    "Cursos de IA para iniciantes",
  );
  await server.files.import("other-owner", "Trilha secreta.pdf", bytes, "Private");
  await server.files.importAttachment(
    "owner",
    "preview.txt",
    Buffer.from("private"),
    "preview",
    "text/plain",
    "preview",
    true,
  );
  const old = await server.files.import("owner", "Trilha antiga.pdf", bytes, "Archived");
  await server.db.put("owner", "files", { ...old, historyHiddenAt: new Date().toISOString() });
  const attached: string[] = [];
  const tools = mediaTools(server.agent.media, server.agent.computer, "owner", "library-test", {
    model: () => undefined,
    artifact: async (id) => {
      attached.push(id);
    },
  });
  type Results = {
    search_saved_files: Awaited<ReturnType<FileLibrary["search"]>>;
    read_saved_file: Awaited<ReturnType<FileLibrary["read"]>>;
    attach_saved_file: Awaited<ReturnType<FileLibrary["attach"]>>;
  };
  const call = async <N extends keyof Results>(
    name: N,
    args: unknown,
  ): Promise<Results[N] & { error?: string }> => {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool?.execute, `Missing harness tool: ${name}`);
    return (tool.execute as (args: unknown) => Promise<Results[N] & { error?: string }>)(args);
  };
  for (const query of ["trilha cursos ia", "trilha", "trlia cursos", "TRILHA CURSOS IA"]) {
    const found = await call("search_saved_files", { query });
    assert.equal(found.total, 1);
    assert.equal(found.files[0].fileId, pdf.id);
    assert.ok(found.files[0].match);
  }
  assert.deepEqual(attached, [], "search must not publish every match as an attachment");
  const read = await call("read_saved_file", { fileId: pdf.id, limit: 25 });
  assert.equal(read.attachment, false);
  assert.ok(read.nextOffset !== null && read.nextOffset > 0);
  const rest = await call("read_saved_file", { fileId: pdf.id, offset: read.nextOffset });
  assert.match(read.text + rest.text, /Plano\s+de quatro semanas/);
  assert.deepEqual(attached, [], "reading must not imply delivery");
  const delivered = await call("attach_saved_file", { fileId: pdf.id });
  assert.equal(delivered.attachment, true);
  assert.equal(delivered.fileId, pdf.id);
  assert.equal(delivered.size, bytes.length);
  assert.match(delivered.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(attached, [pdf.id]);
  assert.equal((await server.files.list("owner")).length, 1, "redelivery must not duplicate files");
  assert.ok((await call("attach_saved_file", { fileId: old.id })).error);
  const [foreign] = await server.files.list("other-owner");
  assert.ok((await call("read_saved_file", { fileId: foreign.id })).error);
});

test("a computer file export rejects the workspace directory before native dispatch", async (t) => {
  const server = await taskRuntime(t);
  let reads = 0;
  t.mock.method(server.agent.computer, "fileBytes", async () => {
    reads++;
    throw new Error("Native read must not be reached for a known directory");
  });
  const tool = computerTools(server.agent.computer, server.files, "owner", "invalid-path").find(
    (entry) => entry.name === "export_computer_file",
  );
  assert.ok(tool?.execute);
  const call = tool.execute as (args: unknown) => Promise<{ error?: string }>;
  for (const path of ["/workspace", "/workspace/", "/workspace/./"])
    assert.match((await call({ path })).error ?? "", /file path|arquivo|directory/i);
  assert.equal(reads, 0);
  assert.equal((await server.files.list("owner")).length, 0);
});

test("the harness can inspect a scanned PDF as pixels without delivering its private preview", async (t) => {
  const server = await taskRuntime(t);
  const doc = await PDFDocument.create();
  doc.addPage().drawRectangle({ x: 20, y: 20, width: 100, height: 100 });
  doc.addPage();
  const pdf = await server.files.import("owner", "scanned.pdf", await doc.save(), "Uploaded scan");
  const attachments: string[] = [];
  const tool = mediaTools(server.agent.media, server.agent.computer, "owner", "scan-test", {
    model: () => undefined,
    artifact: async (id) => {
      attachments.push(id);
    },
  }).find((entry) => entry.name === "view_file");
  assert.ok(tool?.execute);
  const result = await (tool.execute as (args: unknown) => Promise<Record<string, unknown>>)({
    fileId: pdf.id,
    startPage: 2,
    pageCount: 1,
  });
  assert.equal(result.fileImage, true);
  assert.equal(result.attachment, false);
  assert.equal(result.documentFileId, pdf.id);
  assert.deepEqual(result.pages, [2]);
  assert.equal(result.nextPage, null);
  assert.ok(await server.files.imageContent("owner", String(result.fileId)));
  assert.deepEqual(attachments, []);
  assert.equal((await server.files.list("owner")).length, 1);
});

test("saved-file pagination and negative search never fabricate matching files", async (t) => {
  const server = await taskRuntime(t);
  for (let i = 0; i < 4; i++)
    await server.files.importAttachment(
      "owner",
      `Relatório ${i}.txt`,
      Buffer.from(`Real content ${i}`),
      "Reports",
      "text/plain",
    );
  const tools = mediaTools(server.agent.media, server.agent.computer, "owner", "paging", {
    model: () => undefined,
  });
  const tool = tools.find((entry) => entry.name === "search_saved_files");
  assert.ok(tool?.execute);
  const call = tool.execute as (
    args: unknown,
  ) => Promise<Awaited<ReturnType<FileLibrary["search"]>>>;
  const first = await call({ query: "relatorio", limit: 2 });
  assert.equal(first.total, 4);
  assert.equal(first.nextOffset, 2);
  const next = await call({ query: "relatorio", limit: 2, offset: first.nextOffset });
  assert.equal(new Set([...first.files, ...next.files].map((f) => f.fileId)).size, 4);
  assert.equal(next.nextOffset, null);
  assert.equal((await call({ query: "nenhum documento conhecido" })).total, 0);
});

test("saved-file search identifies a delivered document through its original task and ranks it before a newer draft", async (t) => {
  const server = await taskRuntime(t);
  const file = await server.files.importAttachment(
    "owner",
    "report.txt",
    Buffer.from("Original final report"),
    "Generated document",
    "text/plain",
  );
  const draft = await server.files.importAttachment(
    "owner",
    "report.txt",
    Buffer.from("Unfinished draft"),
    "Generated document",
    "text/plain",
  );
  const task = await server.agent.createTask("owner", {
    title: "Trilha de cursos de IA",
    prompt: "Organize minha trilha de cursos de IA",
  });
  await server.db.put("owner", "tasks", { ...task, status: "succeeded", artifactIds: [file.id] });
  const tools = mediaTools(server.agent.media, server.agent.computer, "owner", "origin", {
    model: () => undefined,
  });
  const tool = tools.find((entry) => entry.name === "search_saved_files");
  assert.ok(tool?.execute);
  type Search = {
    files: { fileId: string; previouslyDelivered: boolean; origins: { title: string }[] }[];
  };
  const call = tool.execute as (args: unknown) => Promise<Search>;
  const identified = await call({ query: "trilha cursos" });
  assert.equal(identified.files[0]?.fileId, file.id);
  assert.equal(identified.files[0].previouslyDelivered, true);
  assert.equal(identified.files[0].origins[0].title, task.title);
  const candidates = await call({ query: "report" });
  assert.deepEqual(
    candidates.files.map((f) => f.fileId),
    [file.id, draft.id],
  );
});
