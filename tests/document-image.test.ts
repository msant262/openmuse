import assert from "node:assert/strict";
import { test } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { documentImageSize } from "../packages/integrations/src/document-image.ts";

test("document image bounds are checked from encoded PNG and JPEG dimensions", () => {
  const canvas = createCanvas(32, 24);
  for (const bytes of [canvas.encodeSync("png"), canvas.encodeSync("jpeg")]) {
    assert.deepEqual(documentImageSize(bytes), { width: 32, height: 24 });
  }
  const oversized = canvas.encodeSync("png");
  oversized.writeUInt32BE(100000, 16);
  oversized.writeUInt32BE(100000, 20);
  assert.throws(() => documentImageSize(oversized), /16 million pixels/);
  assert.throws(() => documentImageSize(Buffer.from([255, 216, 255, 192, 0, 30])), /invalid/);
  assert.throws(() => documentImageSize(Buffer.alloc(24)), /invalid/);
});
