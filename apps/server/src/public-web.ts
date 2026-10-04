import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { type DefaultTreeAdapterMap, parse } from "parse5";
import { type Resolver, validatePublicUrl } from "../../worker/src/network.ts";

const maxBytes = 2 * 1024 * 1024;
const maxText = 30000;
type Target = Awaited<ReturnType<typeof validatePublicUrl>>;
type Response = { status: number; headers: IncomingHttpHeaders; body: string };
export class WebReadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type RenderedPublicPage = {
  dataSources?: { url: string; kind: string }[];
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  sessionId?: string;
  links?: { title: string; url: string }[];
  extraction?: { status: "readable" | "partial"; reason?: string };
};
export const publicReadDescription =
  "Read public HTML/JSON over HTTP, including embedded application JSON and published data/API URLs. Default auto never launches a browser. Inspect dataSources and prefer relevant API/MCP tools before requesting mode=headless for JavaScript-only data. Headless uses the VPS, never the personal graphical browser. mode=browser is a legacy alias for headless. Partial content is not verified evidence.";

export const publicResearchInstructions =
  " For research choose the least costly relevant source: first search_tools for topic-specific configured API/MCP read tools (search by the requested data, not only web_fetch); use search_app_tools for connected-app APIs when relevant. Use available structured tools before page scraping. Do not invent endpoints, install connectors, or ask for new credentials for a public lookup. Next use search_web and web_fetch HTTP, inspecting embedded JSON and dataSources for published public data endpoints. Fetch relevant data URLs directly with web_fetch before rendering. If those paths are unavailable or insufficient, explicitly call web_fetch mode=headless for JavaScript/network data; this never opens the personal graphical browser. Only use personal/graphical navigation as a last resort for a task that actually requires interactive/session access. WebMCP is a site/browser capability, not a universal HTTP API: use it only when actually exposed by an available supported tool. Never claim a MCP/WebMCP/API was tried without a tool receipt. Stop when the requested facts are obtained, retain successful evidence after later failures, and declare outcome=partial when the requested data remains missing. Headless navigation and pending application data each get up to 60 seconds, returning sooner when ready. A deadline limits resource use; waiting a fixed number of seconds does not verify data.";

function pageData(root: Node, base: string) {
  const dataSources: { url: string; kind: string }[] = [];
  const embedded: string[] = [];
  let remaining = 12000,
    truncated = false;
  const add = (raw: string, kind: string) => {
    try {
      const url = new URL(raw, base);
      if (
        !/^https?:$/.test(url.protocol) ||
        url.username ||
        url.password ||
        url.href.length > 4096 ||
        dataSources.some((source) => source.url === url.href) ||
        dataSources.length >= 30
      )
        return;
      dataSources.push({ url: url.href, kind });
    } catch {
      /* Invalid published data links are ignored. */
    }
  };
  for (const node of htmlNodes(root, (node) => ["link", "a"].includes(node.nodeName))) {
    const href = htmlAttribute(node, "href");
    if (
      href &&
      (/json|rss|atom|csv/i.test(htmlAttribute(node, "type") ?? "") ||
        /\.(?:json|rss|csv)(?:[?#]|$)/i.test(href))
    )
      add(href, "published-data-link");
  }
  for (const script of htmlNodes(root, (node) => node.nodeName === "script").slice(0, 80)) {
    const raw = children(script)
      .map((node) => ("value" in node ? node.value : ""))
      .join("");
    if (htmlAttribute(script, "type")?.toLowerCase() === "application/json") {
      const src = htmlAttribute(script, "src");
      if (src) add(src, "json-resource");
      try {
        const value = JSON.stringify(JSON.parse(raw));
        if (remaining > 0) embedded.push(value.slice(0, remaining));
        if (value.length > remaining) truncated = true;
        remaining = Math.max(0, remaining - value.length);
      } catch {
        /* Only JSON, never eval or JavaScript assignments. */
      }
    }
    // Discover literal data URLs published in configuration; never execute the
    // scripts, fabricate a path, follow a tool instruction or send credentials.
    if (raw.length > 128000) continue;
    for (const match of raw.matchAll(/"(?:[^"\\]|\\.){0,4096}"|'[^'\r\n]{0,4096}'/g)) {
      try {
        const value = match[0][0] === '"' ? JSON.parse(match[0]) : match[0].slice(1, -1);
        if (/^(?:https?:\/\/|\/[^/])/.test(value) && /\.json(?:[?#]|$)/i.test(value))
          add(value, "published-json-url");
      } catch {
        /* Not a literal URL. */
      }
    }
  }
  return { dataSources, embedded: embedded.join("\n"), truncated };
}

/** Every request connects to the validated address, preserving Host/TLS hostname.
 * No cookies, ambient authentication, proxy credentials or browser session are used. */
export function requestPublicPage(target: Target, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = target.url.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = request(
      target.url,
      {
        method: "GET",
        signal,
        agent: false,
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.8",
          "Accept-Encoding": "identity",
        },
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [{ address: target.address, family: target.family }]);
          else callback(null, target.address, target.family);
        },
      },
      (incoming) => {
        const status = incoming.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          incoming.destroy();
          resolve({ status, headers: incoming.headers, body: "" });
          return;
        }
        if (Number(incoming.headers["content-length"]) > maxBytes) {
          incoming.destroy();
          reject(
            new WebReadError("PAGE_TOO_LARGE", "The public page exceeds the 2 MiB read limit."),
          );
          return;
        }
        if (
          incoming.headers["content-encoding"] &&
          incoming.headers["content-encoding"] !== "identity"
        ) {
          incoming.destroy();
          reject(
            new WebReadError(
              "UNSUPPORTED_ENCODING",
              "The public page returned an unsupported content encoding.",
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            incoming.destroy();
            reject(
              new WebReadError("PAGE_TOO_LARGE", "The public page exceeds the 2 MiB read limit."),
            );
          } else chunks.push(chunk);
        });
        incoming.on("error", reject);
        incoming.on("end", () => {
          try {
            const charset =
              String(incoming.headers["content-type"] ?? "").match(
                /charset\s*=\s*["']?([^;"'\s]+)/i,
              )?.[1] ?? "utf-8";
            resolve({
              status,
              headers: incoming.headers,
              body: new TextDecoder(charset, { fatal: true }).decode(Buffer.concat(chunks)),
            });
          } catch {
            reject(
              new WebReadError(
                "UNSUPPORTED_ENCODING",
                "The public page could not be decoded as the declared text encoding.",
              ),
            );
          }
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

type Node = DefaultTreeAdapterMap["node"];
const children = (node: Node) => ("childNodes" in node ? node.childNodes : []);
export const htmlAttribute = (node: Node, name: string) =>
  "attrs" in node ? node.attrs.find((attr) => attr.name === name)?.value : undefined;
export function htmlNodes(node: Node, predicate: (node: Node) => boolean): Node[] {
  const found: Node[] = [],
    pending = [node];
  while (pending.length) {
    const current = pending.pop()!;
    if (predicate(current)) found.push(current);
    const next = children(current);
    for (let i = next.length - 1; i >= 0; i--) pending.push(next[i]);
  }
  return found;
}
export function htmlText(node: Node): string {
  const text: string[] = [],
    pending = [node];
  while (pending.length) {
    const current = pending.pop()!;
    if (
      "tagName" in current &&
      /^(script|style|noscript|template|svg|canvas|iframe)$/.test(current.tagName)
    )
      continue;
    if (
      htmlAttribute(current, "hidden") !== undefined ||
      htmlAttribute(current, "aria-hidden") === "true"
    )
      continue;
    if (current.nodeName === "img") text.push(htmlAttribute(current, "alt") ?? "");
    else if (current.nodeName === "#text" && "value" in current) text.push(current.value);
    else {
      const next = children(current);
      for (let i = next.length - 1; i >= 0; i--) pending.push(next[i]);
    }
  }
  return text.join(" ").replace(/\s+/g, " ").trim();
}
function productData(root: Node) {
  const result: Record<string, unknown>[] = [];
  const keys = [
    "@type",
    "name",
    "price",
    "lowPrice",
    "highPrice",
    "priceCurrency",
    "availability",
    "url",
    "validFrom",
    "priceValidUntil",
  ];
  const visit = (value: unknown, depth: number) => {
    if (depth > 12 || result.length >= 20 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 100)) visit(item, depth + 1);
      return;
    }
    const object = value as Record<string, unknown>;
    if (
      [object["@type"]]
        .flat()
        .some((type) => ["Product", "Offer", "AggregateOffer"].includes(String(type)))
    ) {
      const record = Object.fromEntries(
        keys.flatMap((key) =>
          typeof object[key] === "string" || typeof object[key] === "number"
            ? [[key, String(object[key]).slice(0, 1000)]]
            : [],
        ),
      );
      result.push(record);
    }
    for (const key of ["@graph", "offers", "itemListElement", "item", "mainEntity"])
      if (object[key]) visit(object[key], depth + 1);
  };
  for (const script of htmlNodes(
    root,
    (node) =>
      node.nodeName === "script" &&
      htmlAttribute(node, "type")?.toLowerCase() === "application/ld+json",
  ).slice(0, 30)) {
    const raw = children(script)
      .map((node) => ("value" in node ? node.value : ""))
      .join("");
    try {
      visit(JSON.parse(raw), 0);
    } catch {
      /* Malformed structured data is not evidence. */
    }
  }
  return result;
}
async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.catch(() => {});
    signal.throwIfAborted();
  }
  let abort = () => {};
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export function readablePage(
  value: unknown,
): value is { url: string; title: string; text: string; sessionId?: string; observedAt?: string } {
  if (!value || typeof value !== "object") return false;
  const page = value as Record<string, unknown>;
  return (
    typeof page.url === "string" &&
    /^https?:\/\//.test(page.url) &&
    typeof page.title === "string" &&
    typeof page.text === "string" &&
    Boolean(page.text.trim()) &&
    !page.error &&
    (page.extraction as { status?: string } | undefined)?.status !== "partial" &&
    !/^a required part of this site couldn.t load/i.test(page.text.trim()) &&
    !/^(access denied|client challenge|just a moment|attention required|verify you are human|checking your browser|(?:403 )?forbidden|security check)(?:\b|[.!])/i.test(
      page.title.trim(),
    )
  );
}

export class PublicWeb {
  constructor(
    private readonly dependencies: { resolve?: Resolver; request?: typeof requestPublicPage } = {},
  ) {}
  async validate(url: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return abortable(validatePublicUrl(url, this.dependencies.resolve), signal);
  }
  async document(rawUrl: string, externalSignal?: AbortSignal) {
    const signal = AbortSignal.any([
      ...(externalSignal ? [externalSignal] : []),
      AbortSignal.timeout(20000),
    ]);
    let url = rawUrl;
    for (let redirects = 0; redirects <= 4; redirects++) {
      signal.throwIfAborted();
      const target = await this.validate(url, signal);
      signal.throwIfAborted();
      const request = this.dependencies.request ?? requestPublicPage;
      let response: Response;
      try {
        response = await request(target, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          !["ECONNRESET", "EPIPE"].includes(String(error.code))
        )
          throw error;
        response = await request(await this.validate(url, signal), signal);
      }
      signal.throwIfAborted();
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.location;
        if (!location)
          throw new WebReadError("INVALID_REDIRECT", "The public page returned an empty redirect.");
        url = new URL(location, target.url).href;
        continue;
      }
      if (response.status < 200 || response.status >= 300)
        throw new WebReadError(
          `HTTP_${response.status}`,
          `The public page returned HTTP ${response.status}; its content was not verified.`,
        );
      if (Buffer.byteLength(response.body) > maxBytes)
        throw new WebReadError("PAGE_TOO_LARGE", "The public page exceeds the 2 MiB read limit.");
      const contentType = String(response.headers["content-type"] ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (
        ![
          "text/html",
          "application/xhtml+xml",
          "text/plain",
          "text/csv",
          "application/json",
          "text/xml",
          "application/xml",
          "application/rss+xml",
          "application/atom+xml",
        ].includes(contentType)
      )
        throw new WebReadError(
          "UNSUPPORTED_CONTENT",
          "This URL is not a supported public text page.",
        );
      return { url: target.url.href, body: response.body, contentType };
    }
    throw new WebReadError("TOO_MANY_REDIRECTS", "The public page exceeded the redirect limit.");
  }
  async read(
    url: string,
    signal?: AbortSignal,
    options: {
      mode?: "auto" | "http" | "headless" | "browser";
      render?: (url: string, signal?: AbortSignal) => Promise<RenderedPublicPage>;
    } = {},
  ) {
    if (options.mode !== "browser" && options.mode !== "headless") {
      try {
        return await this.readHttp(url, signal);
      } catch (error) {
        signal?.throwIfAborted();
        // Never convert network/URL policy rejection or cancellation into browser dispatch.
        if (
          options.mode === "http" ||
          !options.render ||
          !(error instanceof WebReadError) ||
          !["HTTP_403", "HTTP_429", "PAGE_BLOCKED"].includes(error.code)
        )
          throw error;
        return {
          url,
          title: new URL(url).hostname,
          text: "",
          links: [],
          dataSources: [],
          truncated: false,
          error: error.message,
          code: error.code,
          extraction: {
            status: "partial" as const,
            reason:
              "HTTP access failed. Try an available structured tool or another source; explicitly request mode=headless if JavaScript is needed.",
          },
          observedAt: new Date().toISOString(),
          provenance: { backend: "http" as const, authenticated: false as const },
        };
      }
    }
    if (!options.render)
      throw new WebReadError("RENDER_UNAVAILABLE", "Public rendering is unavailable.");
    signal?.throwIfAborted();
    await this.validate(url, signal);
    const rendered = await options.render(url, signal);
    signal?.throwIfAborted();
    if (!readablePage({ ...rendered, extraction: undefined }))
      throw new WebReadError(
        "PAGE_BLOCKED",
        "The rendered source is still blocked or empty. Read a different public source; no source data was verified.",
      );
    return {
      ...rendered,
      text: rendered.text.slice(0, maxText),
      links: rendered.links ?? [],
      dataSources: rendered.dataSources ?? [],
      truncated: rendered.truncated || rendered.text.length > maxText,
      extraction: rendered.extraction ?? { status: "readable" as const },
      observedAt: new Date().toISOString(),
      provenance: { backend: "browser" as const, mode: "headless" as const },
    };
  }
  private async readHttp(url: string, signal?: AbortSignal) {
    const document = await this.document(url, signal);
    const root = parse(document.body);
    const html = /html/.test(document.contentType);
    const title = html
      ? htmlText(htmlNodes(root, (node) => node.nodeName === "title")[0] ?? root).slice(0, 300)
      : new URL(document.url).hostname;
    const main = htmlNodes(root, (node) => ["main", "article"].includes(node.nodeName))[0];
    const visibleText = html
      ? htmlText(main ?? htmlNodes(root, (node) => node.nodeName === "body")[0] ?? root)
      : document.body.trim();
    const products = html ? productData(root) : [];
    const data = html
      ? pageData(root, document.url)
      : { dataSources: [], embedded: "", truncated: false };
    const structured = products.length
      ? "\nStructured product data from this page (untrusted): " + JSON.stringify(products)
      : "";
    const extracted = structured
      ? visibleText.slice(0, 19000) + structured.slice(0, 11000)
      : visibleText;
    const text = data.embedded
      ? extracted.slice(0, 17500) +
        "\nEmbedded application JSON (untrusted source data):\n" +
        data.embedded
      : extracted;
    // A 200 response can be the application's loading shell. Ignore empty ad
    // placeholders, but don't certify the surrounding boilerplate as its data.
    const pending =
      html &&
      htmlNodes(main ?? root, (node) => {
        if (["script", "style", "input", "textarea"].includes(node.nodeName)) return false;
        const classes = `${htmlAttribute(node, "class") ?? ""} ${htmlAttribute(node, "id") ?? ""}`;
        if (/(?:advert|publicidade|(?:^|[\s_-])ads?(?:[\s_-]|$))/i.test(classes)) return false;
        return (
          htmlAttribute(node, "aria-busy") === "true" ||
          (/(?:^|[\s_-])(?:skeleton|placeholder|loading)(?:[\s_-]|$)/i.test(classes) &&
            htmlText(node).length > 0)
        );
      }).length > 0;
    const shell =
      html &&
      !products.length &&
      visibleText.length < 100 &&
      htmlNodes(root, (node) => node.nodeName === "script" && Boolean(htmlAttribute(node, "src")))
        .length > 0;
    const extraction =
      pending || (shell && !data.embedded && !products.length)
        ? {
            status: "partial" as const,
            reason:
              "Application content is still loading. Inspect published dataSources or available structured tools first; explicitly use mode=headless if rendering is needed.",
          }
        : { status: "readable" as const };
    if (!readablePage({ url: document.url, title, text }) && !data.dataSources.length)
      throw new WebReadError(
        "PAGE_BLOCKED",
        "The site returned a challenge or no readable public text. Use another source, or browser only if interactive rendering is necessary.",
      );
    const links = html
      ? htmlNodes(main ?? root, (node) => node.nodeName === "a")
          .flatMap((node) => {
            try {
              const target = new URL(htmlAttribute(node, "href") ?? "", document.url);
              const label = htmlText(node).slice(0, 200);
              return label &&
                ["http:", "https:"].includes(target.protocol) &&
                !target.username &&
                !target.password
                ? [{ title: label, url: target.href.slice(0, 4096) }]
                : [];
            } catch {
              return [];
            }
          })
          .slice(0, 80)
      : [];
    return {
      url: document.url,
      title,
      text: text.slice(0, maxText),
      links,
      dataSources: data.dataSources,
      extraction,
      truncated:
        data.truncated ||
        (Boolean(data.embedded) && extracted.length > 17500) ||
        text.length > maxText ||
        (Boolean(structured) && (visibleText.length > 19000 || structured.length > 11000)),
      observedAt: new Date().toISOString(),
      provenance: { backend: "http" as const, authenticated: false as const },
    };
  }
}
