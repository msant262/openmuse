import type { Page } from "playwright";
import type { SearchInput, SearchResult } from "../../../packages/domain/src/search.ts";
import { WorkerError } from "./errors.ts";
import { validatePublicUrl } from "./network.ts";

/** Fixed extraction of index entries. Page text and snippets remain untrusted;
 * extraction neither visits sources nor accepts executable page instructions. */
export async function extractSearch(page: Page, input: SearchInput): Promise<SearchResult> {
  const extracted = await page.evaluate(() => {
    const containers = Array.from(document.querySelectorAll(".result")).slice(0, 51);
    return {
      recognized: containers.length > 0 || Boolean(document.querySelector(".no-results")),
      entries: containers.map((item) => {
        const anchor = item.querySelector<HTMLAnchorElement>(".result__a");
        const snippet = item.querySelector(".result__snippet");
        return {
          title: (anchor?.textContent ?? "").trim().slice(0, 301),
          url: (anchor?.href ?? "").slice(0, 8193),
          snippet: (snippet?.textContent ?? "").trim().slice(0, 1001),
          date: item.querySelector("time")?.getAttribute("datetime")?.slice(0, 80),
        };
      }),
    };
  });
  if (!extracted.recognized)
    throw new WorkerError(
      "SEARCH_UNAVAILABLE",
      "The search index did not return recognizable results; it may require a human challenge.",
      502,
    );
  const sources: SearchResult["sources"] = [];
  let truncated = extracted.entries.length > input.limit;
  const seen = new Set<string>();
  for (const entry of extracted.entries) {
    if (!entry.title || !entry.url || entry.url.length > 8192) continue;
    try {
      const redirect = new URL(entry.url);
      const target =
        (redirect.hostname === "duckduckgo.com" || redirect.hostname.endsWith(".duckduckgo.com")) &&
        redirect.searchParams.has("uddg")
          ? (redirect.searchParams.get("uddg") ?? "")
          : entry.url;
      if (target.length > 4096) {
        truncated = true;
        continue;
      }
      const checked = await validatePublicUrl(target);
      const url = checked.url.href;
      if (seen.has(url)) continue;
      seen.add(url);
      if (sources.length === input.limit) {
        truncated = true;
        continue;
      }
      truncated ||= entry.title.length > 300 || entry.snippet.length > 1000;
      sources.push({
        title: entry.title.slice(0, 300),
        url,
        snippet: entry.snippet.slice(0, 1000),
        ...(entry.date ? { date: entry.date } : {}),
      });
    } catch {
      /* Non-public/malformed destinations never become source links. */
    }
  }
  return {
    query: input.query,
    status: sources.length ? "ok" : "no_results",
    sources,
    observedAt: new Date().toISOString(),
    truncated,
    provenance: {
      backend: "browser",
      provider: "duckduckgo-html",
      searchUrl: page.url(),
      fullPagesRead: false,
    },
  };
}
