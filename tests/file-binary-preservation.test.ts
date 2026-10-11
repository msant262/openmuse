import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { Auth } from "../apps/server/src/auth.ts";
import { createStore } from "../apps/server/src/db.ts";
import { Files } from "../apps/server/src/files.ts";
import { config as base } from "./helpers/computer.ts";

test("retrying a binary publication returns the recorded metadata and rejects changed bytes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "binary-file-replay-"));
  const db = await createStore();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const config = { ...base, dataDir: dir };
  const files = new Files(db, config, new Auth(db, config, "test-key"));
  const bytes = Buffer.from("Actual report");
  const first = await files.importBinaryAttachment(
    "owner",
    "report.txt",
    bytes,
    "Kanban",
    "text/plain",
    "stable-copy",
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await files.importBinaryAttachment(
    "owner",
    "report.txt",
    bytes,
    "Kanban",
    "text/plain",
    "stable-copy",
  );
  assert.equal(second.createdAt, first.createdAt);
  const { url: _url, ...metadata } = second;
  const { url: _storedUrl, ...stored } = await files.get("owner", second.id);
  assert.deepEqual(metadata, stored);
  assert.equal((await files.list("owner")).length, 1);
  await assert.rejects(
    files.importBinaryAttachment(
      "owner",
      "report.txt",
      Buffer.from("Different report"),
      "Kanban",
      "text/plain",
      "stable-copy",
    ),
    /different content/i,
  );
  assert.deepEqual(await files.bytes("owner", first.id), bytes);
});

test("a valid PDF above the separate parser limit is preserved byte-for-byte within the attachment limit", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "binary-file-pdf-"));
  const db = await createStore();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const config = { ...base, dataDir: dir };
  const files = new Files(db, config, new Auth(db, config, "test-key"));
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText("Actual PDF deliverable");
  const bytes = Buffer.concat([await pdf.save(), Buffer.from(`\n%${"padding".repeat(1600000)}\n`)]);
  assert.ok(bytes.length > 10 * 1024 * 1024 && bytes.length < 25 * 1024 * 1024);
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
  const file = await files.importBinaryAttachment(
    "owner",
    "deliverable.pdf",
    bytes,
    "Kanban",
    "application/pdf",
    "pdf-copy",
  );
  assert.equal(file.mimeType, "application/pdf");
  assert.deepEqual(await files.bytes("owner", file.id), bytes);
  await assert.rejects(
    files.importBinaryAttachment("owner", "fake.pdf", Buffer.from("Not PDF bytes"), "Kanban"),
    /does not match/i,
  );
  await assert.rejects(
    files.importBinaryAttachment(
      "owner",
      "large.bin",
      new Uint8Array(25 * 1024 * 1024 + 1),
      "Kanban",
    ),
    /25 MB/i,
  );
  assert.equal((await files.list("owner")).length, 1);
});
