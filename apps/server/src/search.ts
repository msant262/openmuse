import { DOMParser } from "@xmldom/xmldom";
import { parse } from "parse5";
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
import { htmlAttribute, htmlNodes, htmlText, type PublicWeb } from "./public-web.ts";

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
        undefined,
        undefined,
        context.signal,
        true,
        async (id) => {
          await context.observed?.(id);
          return this.browser.search(context.owner, id, input, context.signal);
        },
        context.before,
        context.trackResourceLeases,
        {
          taskId: `search:${context.taskId ?? "chat"}`,
          operationClass: "public_read",
          artifactVersions: [],
        },
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

/** Public discovery does not acquire a graphical desktop or browser profile. */
export class HttpSearchBackend implements SearchBackend {
  private preferredProvider?: SearchResult["provenance"]["provider"];
  constructor(private readonly web: PublicWeb) {}
  async search(input: SearchInput, context: SearchContext): Promise<SearchResult> {
    const signal = AbortSignal.any([
      ...(context.signal ? [context.signal] : []),
      AbortSignal.timeout(30000),
    ]);
    const endpoints = [
      { url: "https://www.bing.com/search?format=rss", provider: "bing-rss" as const },
      { url: "https://lite.duckduckgo.com/lite/", provider: "duckduckgo-lite" as const },
      { url: defaultSearchEndpoint, provider: "duckduckgo-html" as const },
    ].sort(
      (a, b) =>
        Number(b.provider === this.preferredProvider) -
        Number(a.provider === this.preferredProvider),
    );
    let code = "SEARCH_UNAVAILABLE";
    let provenance: SearchResult["provenance"] = {
      backend: "http",
      provider: endpoints[0].provider,
      searchUrl: endpoints[0].url,
      fullPagesRead: false,
    };
    const result = (
      status: SearchResult["status"],
      sources: SearchResult["sources"] = [],
      truncated = false,
    ): SearchResult => ({
      query: input.query,
      status,
      sources,
      truncated,
      observedAt: new Date().toISOString(),
      provenance,
      ...(status === "error" || status === "cancelled"
        ? { code: signal.aborted ? "SEARCH_CANCELLED" : code }
        : {}),
    });
    if (signal.aborted) return result("cancelled");
    await context.before?.();
    for (const endpoint of endpoints) {
      if (signal.aborted) return result("cancelled");
      const attempt = AbortSignal.any([signal, AbortSignal.timeout(9000)]);
      const url = new URL(endpoint.url);
      url.searchParams.set("q", input.query);
      provenance = { ...provenance, provider: endpoint.provider, searchUrl: url.href };
      try {
        const page = await this.web.document(url.href, attempt);
        let entries: { title: string; url: string; snippet: string }[];
        let recognized = false;
        if (endpoint.provider === "bing-rss") {
          if (/<!DOCTYPE/i.test(page.body)) throw new Error("Unexpected search feed declaration");
          const document = new DOMParser({ onError: () => {} }).parseFromString(
            page.body,
            "application/xml",
          );
          recognized = Boolean(document.getElementsByTagName("channel").length);
          entries = Array.from(document.getElementsByTagName("item"))
            .slice(0, 51)
            .map((item) => ({
              title: item.getElementsByTagName("title")[0]?.textContent ?? "",
              url: item.getElementsByTagName("link")[0]?.textContent ?? "",
              snippet: item.getElementsByTagName("description")[0]?.textContent ?? "",
            }));
        } else {
          const root = parse(page.body);
          const hasClass = (node: Parameters<typeof htmlText>[0], name: string) =>
            (htmlAttribute(node, "class") ?? "").split(/\s+/).includes(name);
          const anchors = htmlNodes(
            root,
            (node) => hasClass(node, "result-link") || hasClass(node, "result__a"),
          ).slice(0, 51);
          recognized =
            anchors.length > 0 ||
            htmlNodes(root, (node) => hasClass(node, "no-results")).length > 0;
          entries = anchors.map((anchor) => {
            let container = anchor;
            while (
              "parentNode" in container &&
              container.parentNode &&
              !hasClass(container, "result") &&
              container.nodeName !== "tr"
            )
              container = container.parentNode;
            let snippet = htmlNodes(container, (node) => hasClass(node, "result__snippet"))[0];
            if (
              !snippet &&
              container.nodeName === "tr" &&
              "parentNode" in container &&
              container.parentNode &&
              "childNodes" in container.parentNode
            ) {
              const siblings = container.parentNode.childNodes;
              for (let index = siblings.indexOf(container) + 1; index < siblings.length; index++) {
                const sibling = siblings[index];
                if (htmlNodes(sibling, (node) => hasClass(node, "result-link")).length) break;
                snippet = htmlNodes(sibling, (node) => hasClass(node, "result-snippet"))[0];
                if (snippet) break;
              }
            }
            return {
              title: htmlText(anchor),
              url: htmlAttribute(anchor, "href") ?? "",
              snippet: snippet ? htmlText(snippet) : "",
            };
          });
        }
        if (!recognized) {
          code = "SEARCH_UNAVAILABLE";
          continue;
        }
        if (endpoint.provider === "bing-rss") {
          const normalize = (value: string) =>
            value
              .normalize("NFD")
              .replace(/\p{M}/gu, "")
              .toLowerCase()
              .replace(/make[ -]+up/g, "makeup");
          const stop = new Set([
            "make",
            "up",
            "the",
            "and",
            "for",
            "in",
            "de",
            "en",
            "site",
            "com",
            "www",
            "of",
            "on",
            "at",
            "to",
            "best",
            "top",
            "current",
            "latest",
            "deals",
            "offers",
            "sale",
            "discounts",
            "angebote",
            "rabatt",
            "aktuell",
            "deutschland",
            "germany",
            "alemanha",
            "promocoes",
            "ofertas",
          ]);
          const terms = [
            ...new Set(
              (normalize(input.query).match(/[\p{L}]+/gu) ?? []).filter(
                (term) => term.length > 2 && !stop.has(term),
              ),
            ),
          ];
          if (terms.length)
            entries = entries.filter((entry) => {
              const words = new Set(
                normalize(`${entry.title} ${entry.snippet} ${entry.url}`).match(/\p{L}+/gu) ?? [],
              );
              // One ambiguous acronym must not drown a multi-topic query in
              // unrelated results. Short/single-topic queries still need one match.
              return terms.filter((term) => words.has(term)).length >= (terms.length >= 3 ? 2 : 1);
            });
          if (!entries.length) {
            code = "SEARCH_NO_RELEVANT_SOURCES";
            continue;
          }
        }
        const sources: SearchResult["sources"] = [],
          seen = new Set<string>();
        for (const entry of entries) {
          attempt.throwIfAborted();
          try {
            const link = new URL(entry.url, page.url);
            const target =
              /(^|\.)duckduckgo\.com$/.test(link.hostname) && link.searchParams.has("uddg")
                ? link.searchParams.get("uddg")!
                : link.href;
            if (target.length > 4096) continue;
            const checked = await this.web.validate(target, attempt);
            const title = entry.title.trim().slice(0, 300);
            if (!title || seen.has(checked.url.href)) continue;
            seen.add(checked.url.href);
            sources.push({
              title,
              url: checked.url.href,
              snippet: entry.snippet.trim().slice(0, 1000),
            });
            if (sources.length === input.limit) break;
          } catch {
            attempt.throwIfAborted();
            /* Unsafe links never become sources. */
          }
        }
        attempt.throwIfAborted();
        provenance = { ...provenance, searchUrl: page.url };
        this.preferredProvider = endpoint.provider;
        return result(sources.length ? "ok" : "no_results", sources, entries.length > input.limit);
      } catch (error) {
        code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "SEARCH_UNAVAILABLE";
      }
    }
    return result(signal.aborted ? "cancelled" : "error");
  }
}
