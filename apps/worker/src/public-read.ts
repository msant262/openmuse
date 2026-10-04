import type { Page, Request } from "playwright";

/** Observe already-issued public GET requests; never replay requests, headers or bodies. */
export function observePublicDataRequests(page: Page) {
  const pending = new Set<Request>();
  const sources = new Map<string, { url: string; kind: string }>();
  let generation = 0,
    saturated = false;
  page.on("request", (request) => {
    if (request.method() !== "GET" || !["xhr", "fetch"].includes(request.resourceType())) return;
    if (pending.size >= 64) {
      saturated = true;
      return;
    }
    pending.add(request);
  });
  page.on("requestfailed", (request) => pending.delete(request));
  page.on("requestfinished", (request) => {
    if (!pending.has(request)) return;
    const observedGeneration = generation;
    void (async () => {
      try {
        const response = await request.response();
        if (
          observedGeneration !== generation ||
          !response?.ok() ||
          sources.size >= 30 ||
          !/\b(?:application\/(?:[\w.-]+\+)?json|text\/csv)\b/i.test(
            response.headers()["content-type"] ?? "",
          )
        )
          return;
        const url = new URL(response.url());
        if (
          /^https?:$/.test(url.protocol) &&
          !url.username &&
          !url.password &&
          url.href.length <= 4096 &&
          ![...url.searchParams.keys()].some((key) =>
            /token|secret|password|api.?key|authorization/i.test(key),
          )
        )
          sources.set(url.href, { url: url.href, kind: "observed-data-request" });
      } catch {
        /* Failed responses are not data sources. */
      } finally {
        pending.delete(request);
      }
    })();
  });
  return {
    reset() {
      generation++;
      pending.clear();
      sources.clear();
      saturated = false;
    },
    snapshot() {
      return { pending: pending.size > 0 || saturated, sources: [...sources.values()] };
    },
  };
}

/** Fixed reader: no caller-supplied selectors or JavaScript, no clicks. */
export async function readPublicContent(
  page: Page,
  network?: ReturnType<typeof observePublicDataRequests>,
) {
  const sample = () =>
    page.evaluate(() => {
      const text = document.body?.innerText ?? "";
      const content = document.querySelector("main, article") ?? document.body;
      const pending = Array.from(content?.querySelectorAll('[class], [aria-busy="true"]') ?? [])
        .slice(0, 10_000)
        .some((node) => {
          if (
            !(node instanceof HTMLElement) ||
            !node.getClientRects().length ||
            node.closest(
              '[hidden], [aria-hidden="true"], [class*="advert"], [class*="publicidade"], [class~="ad"], [class~="ads"]',
            )
          )
            return false;
          if (node.getAttribute("aria-busy") === "true") return true;
          return (
            /(?:^|[\s_-])(?:skeleton|placeholder|loading)(?:[\s_-]|$)/i.test(node.className) &&
            node.innerText.trim().length > 0
          );
        });
      return {
        url: location.href,
        title: document.title.slice(0, 300),
        text: text.slice(0, 2_000_000),
        sourceLength: text.length,
        pending:
          pending ||
          document.readyState !== "complete" ||
          (!text.trim() && Boolean(document.querySelector("script[src]"))),
        structured: Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
          .slice(0, 20)
          .map((node) => (node.textContent ?? "").slice(0, 100_000)),
        links: Array.from(content?.querySelectorAll("a[href]") ?? [])
          .flatMap((node) => {
            const anchor = node as HTMLAnchorElement;
            try {
              const url = new URL(anchor.href);
              const title = (
                anchor.innerText ||
                anchor.getAttribute("aria-label") ||
                anchor.querySelector("img")?.alt ||
                ""
              )
                .trim()
                .slice(0, 200);
              return title && /^https?:$/.test(url.protocol) && !url.username && !url.password
                ? [{ title, url: url.href.slice(0, 4096) }]
                : [];
            } catch {
              return [];
            }
          })
          .slice(0, 80),
      };
    });
  const started = Date.now();
  let result = await sample();
  while (Date.now() - started < 60_000) {
    if (
      /^(access denied|client challenge|just a moment|attention required|verify you are human|(?:403 )?forbidden)\b/i.test(
        result.title,
      )
    )
      break;
    // Wait on loading state and actual data requests, not a minimum elapsed
    // sleep or whole-page networkidle (analytics/polling may never stop).
    if (!result.pending && !network?.snapshot().pending && result.text.trim()) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
    result = await sample();
  }
  const { pending, ...content } = result;
  return {
    ...content,
    dataSources: network?.snapshot().sources ?? [],
    extraction:
      pending || network?.snapshot().pending
        ? {
            status: "partial" as const,
            reason:
              "Application data did not finish loading within the read deadline. Follow a relevant source link or use another source.",
          }
        : { status: "readable" as const },
  };
}
