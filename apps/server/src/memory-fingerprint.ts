import { createHash } from "node:crypto";
import { bindingHash } from "./conversation-inbox.ts";

// Keep case folding in one runtime: PostgreSQL lower() has different Unicode semantics.
export const memoryFingerprint = (text: string) =>
  bindingHash(text.normalize("NFKC").trim().toLowerCase());

/** Byte binding lets SQL detect legacy/raw edits without reimplementing case folding. */
export function memoryFingerprintFields(text: string) {
  const fingerprint = memoryFingerprint(text);
  return {
    fingerprint,
    fingerprintVersion: "js-v1",
    fingerprintBinding: createHash("sha256").update(`${fingerprint}:${text}`).digest("hex"),
  };
}
