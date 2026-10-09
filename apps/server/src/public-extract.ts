import {
  type PublicReadOptions,
  type PublicWeb,
  type RenderedPublicPage,
  readablePage,
  WebReadError,
} from "./public-web.ts";

export type ExtractedPage = RenderedPublicPage & {
  error?: string;
  code?: string;
  observedAt?: string;
};

/** Recover exact discovered links after a model rewrites a slug and gets 404.
 * These are unread leads, not an automatic fetch or verified source content. */
export function observedSourceAlternatives(failedUrl: string, observed: string[]) {
  const origin = new URL(failedUrl).origin;
  return [...new Set(observed)].filter((url) => {
    try {
      return url !== failedUrl && new URL(url).origin === origin;
    } catch {
      return false;
    }
  });
}

/** Return exact URLs already discovered by this task, excluding attempted
 * reads. This is navigation metadata, never a claim that the targets were read. */
export function unreadSourceLinks(
  observations: { toolName: string; status: string; args?: unknown; receipt?: unknown }[],
) {
  const normalize = (raw: string) => {
    const url = new URL(raw);
    url.hash = "";
    for (const key of [...url.searchParams.keys()])
      if (/^(?:utm_|nocache)/i.test(key)) url.searchParams.delete(key);
    return url.href;
  };
  const tried = new Set<string>();
  for (const op of observations) {
    if (op.toolName === "search_web") continue;
    const args = op.args as { url?: string; urls?: string[] } | undefined;
    const receipt = op.receipt as { url?: string } | undefined;
    for (const raw of [args?.url, receipt?.url, ...(args?.urls ?? [])]) {
      try {
        if (typeof raw === "string") tried.add(normalize(raw));
      } catch {
        /* Invalid metadata is not a read. */
      }
    }
  }
  const selected = new Map<string, { title?: string; url: string }>();
  for (const op of observations.toReversed()) {
    if (op.status !== "succeeded") continue;
    const receipt = op.receipt as
      | {
          error?: unknown;
          links?: { title?: string; url: string }[];
          dataSources?: { url: string }[];
          sources?: { title?: string; url: string }[];
        }
      | undefined;
    if (!receipt || receipt.error) continue;
    for (const link of [
      ...(receipt.links ?? []),
      ...(receipt.dataSources ?? []),
      ...(receipt.sources ?? []),
    ]) {
      try {
        const url = new URL(link.url),
          key = normalize(link.url);
        if (
          !/^https?:$/.test(url.protocol) ||
          url.username ||
          url.password ||
          tried.has(key) ||
          selected.has(key)
        )
          continue;
        selected.set(key, link);
      } catch {
        /* Invalid metadata cannot create a source lead. */
      }
    }
  }
  return [...selected.values()];
}

/** Port of Hermes tools/web_tools_extract.py::_merge_in_order (MIT).
 * Source 1298c8e74baa73e1a2b90124228d017261ac6bc4; see third_party/hermes-learning.
 * Successful entries keep their source identity when only failed positions are rescued. */
export function mergeExtractResults(
  total: number,
  fixed: Map<number, ExtractedPage>,
  positions: number[],
  urls: string[],
  results: ExtractedPage[],
) {
  const merged = new Map(fixed);
  positions.forEach((position, index) => {
    merged.set(
      position,
      results[index] ?? {
        url: urls[index],
        title: "",
        text: "",
        truncated: false,
        error: "Extract backend returned no result for this URL",
      },
    );
  });
  return Array.from({ length: total }, (_, index) => merged.get(index)!);
}

/** Bounded batch extraction with Hermes-style per-call rescue and ordered outcomes.
 * Our configured backends are public HTTP and the isolated VPS renderer. Policy
 * failures and cancellation never enter fallback; one source cannot erase the rest. */
export async function extractPublicSources(
  web: PublicWeb,
  urls: string[],
  signal?: AbortSignal,
  render?: (url: string, signal?: AbortSignal) => Promise<RenderedPublicPage>,
  options: PublicReadOptions = {},
): Promise<ExtractedPage[]> {
  signal?.throwIfAborted();
  const fixed = new Map<number, ExtractedPage>();
  const positions: number[] = [],
    fallbackUrls: string[] = [];
  const failures = new Map<number, ExtractedPage>();
  const requested = urls.slice(0, 4);
  const reads = await Promise.all(
    requested.map(async (url) => {
      signal?.throwIfAborted();
      try {
        const page = await web.read(url, signal, { ...options, mode: "auto", render });
        return {
          page,
          fallback:
            Boolean(render) &&
            !readablePage(page) &&
            !("spill" in page && page.spill && !page.spill.truncated),
        };
      } catch (error) {
        signal?.throwIfAborted();
        return {
          page: {
            url,
            title: "",
            text: "",
            truncated: false,
            error: String(error),
            code: error instanceof WebReadError ? error.code : undefined,
          },
          // Network/URL policy failures never become browser work.
          fallback:
            Boolean(render) &&
            error instanceof WebReadError &&
            ["HTTP_403", "HTTP_429", "PAGE_BLOCKED", "PAGE_TOO_LARGE"].includes(error.code),
        };
      }
    }),
  );
  signal?.throwIfAborted();
  for (const [index, { page, fallback }] of reads.entries()) {
    if (fallback) {
      positions.push(index);
      fallbackUrls.push(requested[index]);
      failures.set(index, page);
    } else fixed.set(index, page);
  }
  const rescued: ExtractedPage[] = [];
  // Browser profile leases are exclusive; HTTP reads above are independent.
  for (const [index, url] of fallbackUrls.entries()) {
    signal?.throwIfAborted();
    try {
      rescued.push(await web.read(url, signal, { ...options, mode: "headless", render }));
    } catch (error) {
      signal?.throwIfAborted();
      rescued.push({
        ...failures.get(positions[index])!,
        error: `${failures.get(positions[index])?.error ?? "HTTP content incomplete"}; renderer: ${String(error)}`,
      });
    }
  }
  return mergeExtractResults(Math.min(urls.length, 4), fixed, positions, fallbackUrls, rescued);
}
