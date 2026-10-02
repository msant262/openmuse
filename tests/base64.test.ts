import assert from "node:assert/strict";
import { test } from "node:test";
import { base64Limit, decodeBase64 } from "../apps/server/src/base64.ts";

test("strict base64 preserves the standard alphabet and all padding lengths within its byte limit", () => {
  const alphabet = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  for (let length = 0; length <= alphabet.length; length++) {
    const bytes = alphabet.subarray(0, length);
    const encoded = bytes.toString("base64");
    assert.ok(encoded.length <= base64Limit(length));
    assert.deepEqual(decodeBase64(encoded, length), bytes);
    if (length) assert.equal(decodeBase64(encoded, length - 1), undefined);
  }
  for (const malformed of [
    "A",
    "AA=",
    "A===",
    "AA=A",
    "=AAA",
    "AAAA====",
    "AA-_",
    "AA\n=",
    "AB==",
    "AAF=",
    "💡==",
  ]) {
    assert.equal(decodeBase64(malformed, 10), undefined, malformed);
  }
});
