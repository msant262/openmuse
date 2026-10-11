import { createHash } from "node:crypto";
import type { Files } from "../files.ts";
import { resolveLiveToolResultMaxChars } from "./openclaw/tool-result-limits.ts";
import type { JournalOperation } from "./task-journal.ts";

/** Expand only byte-verified public sources from this owner's recorded reads.
 * This is an ephemeral review projection: no journal, network or file writes. */
function sourceRecovery(files: Files, owner: string, contextTokens: number) {
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
  return recover;
}

async function recoverToolResult(
  toolName: string,
  value: unknown,
  recover: (value: unknown) => Promise<unknown>,
) {
  const receipt = value as Record<string, unknown> | undefined;
  if (toolName === "web_extract" && Array.isArray(receipt?.pages)) {
    const pages = [];
    for (const page of receipt.pages) pages.push(await recover(page));
    return { ...receipt, pages };
  }
  if (["web_fetch", "read_web", "browser_research"].includes(toolName)) return recover(value);
  return value;
}

/** A batch repeats its source bodies in the aggregate and in each search.
 * Index only this inference view; preserve ordering, query provenance and every
 * distinct snippet, including alternate evidence from the same URL. */
function indexedSearchSources(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const receipt = value as Record<string, unknown>;
  const source = (item: unknown): item is Record<string, unknown> =>
    Boolean(
      item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof (item as Record<string, unknown>).url === "string" &&
        typeof (item as Record<string, unknown>).title === "string" &&
        typeof (item as Record<string, unknown>).snippet === "string",
    );
  if (
    Object.hasOwn(receipt, "_contextProjection") ||
    !Array.isArray(receipt.sources) ||
    !receipt.sources.every(source) ||
    !Array.isArray(receipt.searches) ||
    !receipt.searches.every(
      (search) =>
        search &&
        typeof search === "object" &&
        !Array.isArray(search) &&
        !Object.hasOwn(search, "sourceIndices") &&
        Array.isArray(search.sources) &&
        search.sources.every(source),
    )
  )
    return value;
  const sources: Record<string, unknown>[] = [...receipt.sources];
  const indices = new Map(sources.map((item, index) => [JSON.stringify(item), index]));
  const searches = receipt.searches.map(({ sources: found, ...search }) => ({
    ...search,
    sourceIndices: (found as Record<string, unknown>[]).map((item) => {
      const key = JSON.stringify(item);
      let index = indices.get(key);
      if (index === undefined) {
        index = sources.length;
        sources.push(item);
        indices.set(key, index);
      }
      return index;
    }),
  }));
  const projected = {
    ...receipt,
    sources,
    searches,
    _contextProjection: {
      kind: "indexed_search_sources",
      note: "Each search.sourceIndices lists zero-based entries in sources, in its original order. All distinct titles/snippets and query provenance are preserved. These are search leads, not page reads. Canonical output remains available with read_tool_output.",
    },
  };
  return JSON.stringify(projected).length < JSON.stringify(value).length ? projected : value;
}

/** The executor sees already-read, verified sources without changing the tool's
 * requested excerpt or issuing another network read. Oversized sources retain
 * their original excerpt and read_web_source reference. */
export async function recoverResearchToolResult(
  files: Files,
  owner: string,
  toolName: string,
  value: unknown,
  contextTokens: number,
) {
  if (toolName === "search_web") return indexedSearchSources(value);
  const characters = resolveLiveToolResultMaxChars({ contextWindowTokens: contextTokens });
  return recoverToolResult(toolName, value, sourceRecovery(files, owner, characters / 4));
}

export async function recoverResearchSources(
  files: Files,
  owner: string,
  operations: JournalOperation[],
  contextTokens: number,
): Promise<JournalOperation[]> {
  const recover = sourceRecovery(files, owner, contextTokens);
  const result: JournalOperation[] = [];
  for (const op of operations) {
    if (op.status !== "succeeded") {
      result.push(op);
      continue;
    }
    result.push({ ...op, receipt: await recoverToolResult(op.toolName, op.receipt, recover) });
  }
  return result;
}
