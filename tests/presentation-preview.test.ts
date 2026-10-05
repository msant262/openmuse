import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import pptxgen from "pptxgenjs";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("an authored PPTX opens as an owned PDF preview without the remote desktop", async (t) => {
  const f = await taskRuntime(t);
  const Pptx = pptxgen as unknown as typeof pptxgen.default;
  const deck = new Pptx();
  deck.addSlide().addText("Primeiro slide", { x: 1, y: 1, w: 5, h: 1 });
  deck.addSlide().addText("Segundo slide", { x: 1, y: 1, w: 5, h: 1 });
  const bytes = new Uint8Array((await deck.write({ outputType: "arraybuffer" })) as ArrayBuffer);
  const file = await f.files.importAttachment(
    "owner",
    "deck.pptx",
    bytes,
    "Generated presentation",
  );
  await f.db.put("owner", "document-generations", {
    id: "deck-generation",
    fileId: file.id,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    designVersion: 2,
  });
  const preview = await f.agent.media.previewDocument("owner", file.id);
  assert.equal(preview.mimeType, "application/pdf");
  assert.equal(preview.pageCount, 2);
  assert.match(
    Buffer.from(await f.files.bytes("owner", preview.id)).toString("ascii", 0, 8),
    /^%PDF-/,
  );
  assert.equal((await f.agent.media.previewDocument("owner", file.id)).id, preview.id);
  await assert.rejects(f.agent.media.previewDocument("another-owner", file.id));
  const imported = await f.files.importAttachment("owner", "external.pptx", bytes, "Upload");
  await assert.rejects(f.agent.media.previewDocument("owner", imported.id), /authored/);
});
