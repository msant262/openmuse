import type { Page } from "playwright";

/** Fixed reader: no caller-supplied selectors or JavaScript, no clicks. */
export async function readPublicContent(page: Page) {
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
        pending: pending || (!text.trim() && Boolean(document.querySelector("script[src]"))),
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
  let previous = "",
    stableSince = started,
    result = await sample();
  while (Date.now() - started < 6000) {
    if (
      /^(access denied|client challenge|just a moment|attention required|verify you are human|(?:403 )?forbidden)\b/i.test(
        result.title,
      )
    )
      break;
    const signature = `${result.url}\n${result.text}`;
    if (signature !== previous) {
      previous = signature;
      stableSince = Date.now();
    }
    // DOMContentLoaded precedes hydration. Wait for useful text to settle,
    // bounded independently of analytics/polling connections that never go idle.
    if (
      !result.pending &&
      result.text.trim() &&
      Date.now() - started >= 1000 &&
      Date.now() - stableSince >= 400
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 200));
    result = await sample();
  }
  const { pending, ...content } = result;
  return {
    ...content,
    extraction: pending
      ? {
          status: "partial" as const,
          reason:
            "Application data did not finish loading within the read deadline. Follow a relevant source link or use another source.",
        }
      : { status: "readable" as const },
  };
}
