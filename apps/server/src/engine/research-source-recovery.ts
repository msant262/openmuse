import { createHash } from "node:crypto";
import type { Files } from "../files.ts";
import type { JournalOperation } from "./task-journal.ts";

/** Expand only byte-verified public sources from this owner's recorded reads.
 * This is an ephemeral review projection: no journal, network or file writes. */
export async function recoverResearchSources(
  files: Files,
  owner: string,
  operations: JournalOperation[],
  contextTokens: number,
): Promise<JournalOperation[]> {
  const maxCharacters = Math.max(0, Math.floor(contextTokens * 4));
  const loaded = new Map<string, Promise<string | undefined>>();
  const recover = async (value: unknown) => {
    if (!value || typeof value !== "object") return value;
    const receipt = value as Record<string, unknown>;
    const spill = receipt.spill as Record<string, unknown> | undefined;
    if (
      receipt.error ||
      typeof receipt.url !== "string" ||
      typeof receipt.text !== "string" ||
      !spill ||
      typeof spill.fileId !== "string" ||
      typeof spill.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(spill.sha256) ||
      !Number.isSafeInteger(spill.chars) ||
      !Number.isSafeInteger(spill.size) ||
      Number(spill.chars) <= receipt.text.length ||
      Number(spill.chars) > maxCharacters ||
      Number(spill.size) <= 0 ||
      Number(spill.size) > maxCharacters * 4 ||
      typeof spill.truncated !== "boolean" ||
      (receipt.sourceLength !== undefined && receipt.sourceLength !== spill.chars)
    )
      return value;
    try {
      const url = new URL(receipt.url);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return value;
    } catch {
      return value;
    }
    const key = JSON.stringify([receipt.url, spill.fileId, spill.sha256, spill.size, spill.chars]);
    if (!loaded.has(key))
      loaded.set(
        key,
        (async () => {
          try {
            const file = await files.get(owner, spill.fileId as string);
            if (
              !file.internal ||
              file.source !== `web_fetch:${receipt.url}` ||
              !["text/plain", "application/json"].includes(file.mimeType) ||
              file.size !== spill.size
            )
              return undefined;
            const bytes = await files.bytes(owner, file.id);
            if (
              bytes.length !== spill.size ||
              createHash("sha256").update(bytes).digest("hex") !== spill.sha256
            )
              return undefined;
            const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            return text.length === spill.chars ? text : undefined;
          } catch {
            // A missing, foreign or corrupt cache never becomes new page evidence.
            return undefined;
          }
        })(),
      );
    const text = await loaded.get(key);
    if (text === undefined || !text.startsWith(receipt.text)) return value;
    return {
      ...receipt,
      text,
      sourceLength: text.length,
      offset: 0,
      totalCharacters: text.length,
      nextOffset: null,
      // The spill retains upstream incompleteness separately from the excerpt.
      truncated: spill.truncated,
      sourceRecovery: {
        fileId: spill.fileId,
        sha256: spill.sha256,
        chars: text.length,
        originalExcerptCharacters: receipt.text.length,
        networkRead: false,
      },
    };
  };
  const result: JournalOperation[] = [];
  for (const op of operations) {
    if (op.status !== "succeeded") {
      result.push(op);
      continue;
    }
    const receipt = op.receipt as Record<string, unknown> | undefined;
    if (op.toolName === "web_extract" && Array.isArray(receipt?.pages)) {
      const pages = [];
      for (const page of receipt.pages) pages.push(await recover(page));
      result.push({ ...op, receipt: { ...receipt, pages } });
    } else if (["web_fetch", "read_web", "browser_research"].includes(op.toolName)) {
      result.push({ ...op, receipt: await recover(op.receipt) });
    } else result.push(op);
  }
  return result;
}
