import { z } from "zod";

export const searchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(512),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict();
export type SearchInput = z.infer<typeof searchInputSchema>;
export const searchResultSchema = z
  .object({
    query: z.string().max(512),
    status: z.enum(["ok", "no_results", "error", "cancelled"]),
    sources: z
      .array(
        z
          .object({
            title: z.string().min(1).max(300),
            url: z.url().max(4096),
            snippet: z.string().max(1000),
            date: z.string().max(80).optional(),
          })
          .strict(),
      )
      .max(10),
    observedAt: z.iso.datetime(),
    truncated: z.boolean(),
    provenance: z
      .object({
        backend: z.enum(["http", "browser"]),
        provider: z.enum(["duckduckgo-html", "duckduckgo-lite", "bing-rss", "tavily"]),
        searchUrl: z.url(),
        sessionId: z.uuid().optional(),
        fullPagesRead: z.literal(false),
      })
      .strict(),
    code: z.string().max(80).optional(),
  })
  .strict();
export type SearchResult = z.infer<typeof searchResultSchema>;
export const defaultSearchEndpoint = "https://html.duckduckgo.com/html/";
