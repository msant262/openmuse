import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { recoverResearchSources } from "../apps/server/src/engine/research-source-recovery.ts";
import type { JournalOperation } from "../apps/server/src/engine/task-journal.ts";
import { preservePublicSource } from "../apps/server/src/public-web.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const operation = (receipt: unknown, toolName = "web_fetch") =>
  ({ toolName, status: "succeeded", args: {}, receipt }) as JournalOperation;

test("preserved research is owner, source and byte bound, immutable and sized by the real context", async (t) => {
  const f = await taskRuntime(t);
  const url = "https://academy.example/course";
  const text = `Course entry. ${"Review with Unicode: ação. ".repeat(8000)}\nCourse FAQ: free lessons, paid certificate.`;
  const spill = await preservePublicSource(f.files, "owner")({ url, text, mimeType: "text/plain" });
  const receipt = {
    url,
    text: text.slice(0, 6000),
    spill,
    truncated: true,
    sourceLength: text.length,
    observedAt: "2026-10-09T09:00:00.000Z",
    provenance: { backend: "http", authenticated: false },
    extraction: { status: "readable" },
  };
  const recorded = [operation(receipt), operation(receipt)];
  const original = structuredClone(recorded);
  const bytes = t.mock.method(f.files, "bytes", f.files.bytes.bind(f.files));
  const recovered = await recoverResearchSources(f.files, "owner", recorded, 100_000);
  const result = recovered[0].receipt as typeof receipt & {
    sourceRecovery: { networkRead: boolean };
  };
  assert.equal(
    result.text,
    text,
    "a source above 200k characters is retained when it fits this model",
  );
  assert.equal(result.truncated, false);
  assert.equal(result.observedAt, receipt.observedAt);
  assert.deepEqual(result.provenance, receipt.provenance);
  assert.equal(result.sourceRecovery.networkRead, false);
  assert.equal(
    bytes.mock.callCount(),
    1,
    "identical recorded sources read their bytes once per projection",
  );
  assert.deepEqual(recorded, original);
  assert.deepEqual(
    (await recoverResearchSources(f.files, "other-owner", recorded, 100_000))[0].receipt,
    receipt,
  );
  const count = bytes.mock.callCount();
  assert.deepEqual(
    (await recoverResearchSources(f.files, "owner", recorded, 1000))[0].receipt,
    receipt,
  );
  assert.equal(
    bytes.mock.callCount(),
    count,
    "a source exceeding actual context is not loaded blindly",
  );
  for (const changed of [
    { url: "https://another.example/course" },
    { text: "not the recorded prefix" },
    { sourceLength: text.length + 1 },
    { spill: { ...spill, fileId: "missing" } },
    { spill: { ...spill, sha256: "a".repeat(64) } },
    { spill: { ...spill, size: spill.size + 1 } },
    { spill: { ...spill, chars: spill.chars - 1 }, sourceLength: spill.chars - 1 },
    { spill: { ...spill, truncated: undefined } },
    { error: "Read failed" },
  ]) {
    const invalid = { ...receipt, ...changed };
    assert.deepEqual(
      (await recoverResearchSources(f.files, "owner", [operation(invalid)], 100_000))[0].receipt,
      invalid,
    );
  }
  const failed = { ...operation(receipt), status: "failed" as const };
  assert.deepEqual(await recoverResearchSources(f.files, "owner", [failed], 100_000), [failed]);
});

test("batch recovery retains partial extraction, failed pages and exact negative query semantics", async (t) => {
  const f = await taskRuntime(t);
  const url = "https://academy.example/course";
  const text = "Observed page text. ".repeat(300);
  const spill = await preservePublicSource(f.files, "owner")({ url, text, mimeType: "text/plain" });
  const partial = {
    url,
    text: text.slice(0, 100),
    spill: { ...spill, truncated: true },
    truncated: true,
    extraction: { status: "partial", reason: "Embedded data omitted upstream" },
  };
  const failed = { url: "https://academy.example/blocked", text: "", error: "Blocked" };
  const miss = {
    url,
    fileId: spill.fileId,
    text: "",
    query: "English",
    found: false,
    matchOffset: null,
    sha256: spill.sha256,
    provenance: { backend: "preserved_source", networkRead: false },
  };
  const records = [
    operation({ pages: [partial, failed] }, "web_extract"),
    operation(miss, "read_web_source"),
  ];
  const original = structuredClone(records);
  const recovered = await recoverResearchSources(f.files, "owner", records, 100_000);
  const pages = (recovered[0].receipt as { pages: (typeof partial)[] }).pages;
  assert.equal(pages[0].text, text);
  assert.equal(
    pages[0].truncated,
    true,
    "recovering the saved remainder does not repair upstream omission",
  );
  assert.deepEqual(pages[0].extraction, partial.extraction);
  assert.deepEqual(pages[1], failed);
  assert.deepEqual(
    recovered[1],
    records[1],
    "a phrase miss cannot become a whole-page absence claim",
  );
  assert.deepEqual(records, original);
});

test("arbitrary attachments and malformed cached UTF-8 cannot become recovered public evidence", async (t) => {
  const f = await taskRuntime(t);
  const url = "https://academy.example/course";
  const raw = Buffer.from("Prefix. Some more text from a private file.");
  for (const [source, internal, bytes, mime] of [
    ["private document", true, raw, "text/plain"],
    [`web_fetch:${url}`, false, raw, "text/plain"],
    [`web_fetch:${url}`, true, raw, "application/octet-stream"],
    [`web_fetch:${url}`, true, Buffer.from([65, 66, 0xff]), "text/plain"],
  ] as const) {
    const file = await f.files.importAttachment(
      "owner",
      mime === "application/octet-stream" ? "source.bin" : "source.txt",
      bytes,
      source,
      mime,
      undefined,
      internal,
    );
    assert.equal(file.mimeType, mime, "the fixture uses the actual stored MIME type");
    const receipt = {
      url,
      text: "",
      spill: {
        fileId: file.id,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        chars: raw.length,
        truncated: false,
      },
      truncated: true,
    };
    assert.deepEqual(
      (await recoverResearchSources(f.files, "owner", [operation(receipt)], 100_000))[0].receipt,
      receipt,
    );
  }
});
