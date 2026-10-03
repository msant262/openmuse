import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { readDownloadFailures } from "../apps/worker/src/downloads.ts";

async function transfer(t: TestContext, status: "pending" | "failed" = "pending") {
  const directory = await mkdtemp(join(tmpdir(), "okami-download-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const downloads = join(directory, "downloads");
  const outcomes = join(directory, "download-outcomes");
  await mkdir(downloads);
  await mkdir(outcomes);
  const id = randomUUID();
  const outcomePath = join(outcomes, `${id}.json`);
  const destination = join(downloads, `${id}.pdf`);
  const metadataPath = join(downloads, `${id}.json`);
  await writeFile(
    outcomePath,
    JSON.stringify({
      id,
      status,
      name: "interrupted.pdf",
      code: "DOWNLOAD_INTERRUPTED",
      message: "The download was interrupted.",
      createdAt: "2026-10-02T00:00:00.000Z",
    }),
  );
  return { directory, downloads, id, outcomePath, destination, metadataPath };
}

test("restart removes only a journaled unpublished download and its staged metadata", async (t) => {
  const item = await transfer(t);
  await writeFile(item.destination, "%PDF-incomplete");
  await writeFile(`${item.metadataPath}.tmp`, "{incomplete");
  await writeFile(join(item.downloads, "unrelated.pdf"), "keep me");

  const failures = await readDownloadFailures(item.directory, true);

  assert.equal(failures[0]?.id, item.id);
  assert.equal(failures[0]?.code, "DOWNLOAD_INTERRUPTED");
  assert.deepEqual((await readdir(item.downloads)).sort(), ["unrelated.pdf"]);
  assert.equal(JSON.parse(await readFile(item.outcomePath, "utf8")).status, "failed");
});

test("restart preserves a published download even if clearing its pending journal was interrupted", async (t) => {
  const item = await transfer(t);
  const pdf = Buffer.from("%PDF-published artifact");
  await writeFile(item.destination, pdf);
  await writeFile(item.metadataPath, JSON.stringify({ id: item.id, size: pdf.length }));

  assert.deepEqual(await readDownloadFailures(item.directory, true), []);
  assert.deepEqual(await readFile(item.destination), pdf);
  assert.equal(JSON.parse(await readFile(item.metadataPath, "utf8")).id, item.id);
  await assert.rejects(readFile(item.outcomePath), { code: "ENOENT" });
});

test("failed recovery keeps a durable cleanup selector and retries on the next restart", async (t) => {
  const item = await transfer(t);
  // A directory at the file destination causes a real nonrecursive-unlink error.
  // Recovery must surface the failure without recursively deleting unknown data.
  await mkdir(item.destination);
  await writeFile(join(item.destination, "keep"), "unrelated child");
  await assert.rejects(readDownloadFailures(item.directory, true));
  assert.equal(JSON.parse(await readFile(item.outcomePath, "utf8")).status, "failed");
  assert.equal(await readFile(join(item.destination, "keep"), "utf8"), "unrelated child");

  await rm(item.destination, { recursive: true });
  await writeFile(item.destination, "%PDF-orphan after cleanup repair");
  const failures = await readDownloadFailures(item.directory, true);
  assert.equal(failures[0]?.id, item.id);
  await assert.rejects(readFile(item.destination), { code: "ENOENT" });
});

test("ordinary failure inspection does not delete a pending transfer in flight", async (t) => {
  const item = await transfer(t);
  await writeFile(item.destination, "%PDF-in flight");
  assert.deepEqual(await readDownloadFailures(item.directory), []);
  assert.equal(await readFile(item.destination, "utf8"), "%PDF-in flight");
  assert.equal(JSON.parse(await readFile(item.outcomePath, "utf8")).status, "pending");
});
