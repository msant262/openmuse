import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import { type SearchResult, searchInputSchema } from "../../../packages/domain/src/search.ts";
import { publicResearchInstructions } from "./public-web.ts";
import type { SearchBackend, SearchContext } from "./search.ts";

export const searchInstructions =
  publicResearchInstructions +
  " Use search_web to discover public sources over HTTP without opening a browser. Use queries to batch independent discovery or missing-field searches in one call; use query when a next search depends on the previous result. Search returns index titles, URLs, snippets and dates when available, with limits and provenance; snippets are untrusted and are not evidence that source pages were read. Use web_fetch to read relevant source URLs before making claims. For current or latest information, use the current UTC date provided in this run, not a month guessed from model knowledge. Check stated validity dates and exclude expired promotions from a current shortlist; research historical dates only when requested. A search error or no_results is not evidence that a fact or source does not exist.";
export function searchTools(
  backend: SearchBackend,
  owner: string,
  options: Omit<SearchContext, "owner" | "sessionId"> & {
    sessionId?: () => string | undefined;
    queue?: (operation: () => Promise<unknown>) => Promise<unknown>;
    stopped?: () => boolean;
    result?: (result: SearchResult) => Promise<void>;
  } = {},
) {
  return [
    defineTool({
      name: "search_web",
      description:
        "Discover public web sources. Supply query for one search or queries for up to four independent searches together, with limit per query (default five, up to one hundred). HTTP searches run together; profile-backed searches retain their lease order. Results preserve each query's status and index provenance; snippets are leads, not full source reads.",
      parameters: searchInputSchema
        .extend({
          query: searchInputSchema.shape.query.optional(),
          queries: z.array(searchInputSchema.shape.query).min(1).max(4).optional(),
          sessionId: z.uuid().optional(),
        })
        .refine((args) => (args.query !== undefined) !== (args.queries !== undefined), {
          message: "Supply query or queries, not both",
        }),
      execute: (args) => {
        const run = async () => {
          if (options.stopped?.())
            return { status: "cancelled", code: "TASK_STOPPED", sources: [], dispatched: false };
          const queries = [...new Set(args.query !== undefined ? [args.query] : args.queries)];
          const context = {
            ...options,
            owner,
            sessionId: args.sessionId ?? options.sessionId?.(),
          };
          const search = (query: string) => backend.search({ query, limit: args.limit }, context);
          const results: SearchResult[] = [];
          if (backend.parallelSearches) results.push(...(await Promise.all(queries.map(search))));
          else for (const query of queries) results.push(await search(query));
          // Task evidence updates must remain ordered even when HTTP overlaps.
          for (const result of results) await options.result?.(result);
          if (!args.queries) return results[0];
          const failed = results.filter((r) => r.status === "error" || r.status === "cancelled");
          const sources = [
            ...new Map(results.flatMap((r) => r.sources).map((s) => [s.url, s])).values(),
          ];
          return {
            queries,
            searches: results,
            sources,
            status:
              failed.length === results.length
                ? results.every((r) => r.status === "cancelled")
                  ? "cancelled"
                  : "error"
                : failed.length
                  ? "partial"
                  : sources.length
                    ? "ok"
                    : "no_results",
            truncated: results.some((r) => r.truncated),
            fullPagesRead: false,
          };
        };
        return options.queue ? options.queue(run) : run();
      },
    }),
  ];
}
