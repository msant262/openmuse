import type { ResourceLease } from "../../../packages/domain/src/runtime.ts";
import {
  defaultSearchEndpoint,
  type SearchInput,
  type SearchResult,
} from "../../../packages/domain/src/search.ts";
import type { BrowserService } from "./browser.ts";
import { BrowserError } from "./browser-contract.ts";
import { ResourceBusyError } from "./engine/resource-leases.ts";
import { RuntimePausedError } from "./engine/runtime-pause.ts";

export interface SearchContext {
  owner: string;
  taskId?: string;
  sessionId?: string;
  signal?: AbortSignal;
  before?: () => Promise<void>;
  observed?: (id: string) => Promise<void>;
  paused?: (id: string) => Promise<void>;
  trackResourceLeases?: (leases: ResourceLease[]) => void;
}
export interface SearchBackend {
  search(input: SearchInput, context: SearchContext): Promise<SearchResult>;
}

/** Source discovery is independent of read_web and shares the browser's M3/M4
 * authority. It has no crawler, secret API key, scheduler, or second journal. */
export class BrowserSearchBackend implements SearchBackend {
  constructor(private readonly browser: BrowserService) {}
  async search(input: SearchInput, context: SearchContext): Promise<SearchResult> {
    const empty = (status: "error" | "cancelled", code: string): SearchResult => ({
      query: input.query,
      status,
      code,
      sources: [],
      truncated: false,
      observedAt: new Date().toISOString(),
      provenance: {
        backend: "browser",
        provider: "duckduckgo-html",
        searchUrl: defaultSearchEndpoint,
        fullPagesRead: false,
      },
    });
    if (context.signal?.aborted) return empty("cancelled", "SEARCH_CANCELLED");
    await context.before?.();
    try {
      return await this.browser.runAutomated(
        context.owner,
        context.taskId,
        context.sessionId,
        undefined,
        context.signal,
        true,
        async (id) => {
          await context.observed?.(id);
          return this.browser.search(context.owner, id, input, context.signal);
        },
        context.before,
        context.trackResourceLeases,
      );
    } catch (error) {
      // Loss of a lease/pause/unknown native dispatch is control flow owned by
      // the task worker. Turning it into an ordinary search error loses holds.
      if (
        error instanceof RuntimePausedError ||
        error instanceof ResourceBusyError ||
        (error instanceof Error && error.name === "LostLeaseError") ||
        (error instanceof BrowserError && error.code === "OUTCOME_UNKNOWN") ||
        (error &&
          typeof error === "object" &&
          "outcomeUnknown" in error &&
          error.outcomeUnknown === true)
      )
        throw error;
      if (error instanceof BrowserError && error.code === "BROWSER_CONTROLLED" && error.sessionId)
        await context.paused?.(error.sessionId);
      if (context.signal?.aborted) return empty("cancelled", "SEARCH_CANCELLED");
      return empty("error", error instanceof BrowserError ? error.code : "SEARCH_UNAVAILABLE");
    }
  }
}
