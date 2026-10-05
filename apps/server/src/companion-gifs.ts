import { parse } from "parse5";
import { htmlAttribute, htmlNodes, type PublicWeb } from "./public-web.ts";
import type { SearchBackend } from "./search.ts";

/** Resolve actual media advertised by GIF pages; search snippets alone cannot
 * supply image URLs. No API key, guessed URL, or unbounded crawl is required. */
export async function findConversationGifs(
  search: SearchBackend,
  web: PublicWeb,
  owner: string,
  query: string,
  signal?: AbortSignal,
) {
  const gifs: { url: string; alt: string; sourceUrl: string }[] = [];
  const words = [...new Set(query.split(/\s+/).filter((word) => !/^gifs?$/i.test(word)))];
  const queries = [...new Set([words.slice(0, 4).join(" "), words.slice(0, 2).join(" ")])];
  for (const terms of queries) {
    const results = await search.search(
      { query: `${terms} gif site:tenor.com/view`, limit: 3 },
      { owner, signal },
    );
    for (const source of results.sources) {
      signal?.throwIfAborted();
      try {
        const page = await web.document(source.url, signal);
        const root = parse(page.body);
        for (const node of htmlNodes(root, (node) => node.nodeName === "meta")) {
          const key = htmlAttribute(node, "property") ?? htmlAttribute(node, "name");
          if (!["og:image", "og:image:secure_url", "twitter:image"].includes(key ?? "")) continue;
          const raw = htmlAttribute(node, "content");
          if (!raw) continue;
          const url = new URL(raw, page.url);
          if (
            url.protocol !== "https:" ||
            !/\.gif(?:$|\?)/i.test(url.href) ||
            gifs.some((g) => g.url === url.href)
          )
            continue;
          await web.validate(url.href, signal);
          gifs.push({ url: url.href, alt: source.title, sourceUrl: page.url });
        }
      } catch {
        signal?.throwIfAborted();
      }
      if (gifs.length >= 3) break;
    }
    if (gifs.length) break;
  }
  return {
    gifs: gifs.slice(0, 3),
    instruction: gifs.length
      ? "Use send_gif with one of these verified image URLs and a description in the user's language."
      : "No usable GIF media was found. An animated companion sticker is available; do not invent a URL.",
  };
}
