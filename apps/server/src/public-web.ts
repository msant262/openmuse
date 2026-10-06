import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { type DefaultTreeAdapterMap, parse, serialize } from "parse5";
import { type Resolver, validatePublicUrl } from "../../worker/src/network.ts";
import { type PublicDataQuery, selectPublicData } from "./public-data.ts";

const maxBytes = 2 * 1024 * 1024;
const maxDataBytes = 16 * 1024 * 1024;
const maxText = 30000;
const compactJson = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** Some public feeds use compact JWS despite an application/json header.
 * Decode source data only: this is never a signature or identity verifier. */
function publicJson(body: string) {
  if (!compactJson.test(body.trim()))
    return {
      data: JSON.parse(body) as unknown,
      encoding: "json" as const,
      signatureVerified: undefined,
    };
  const [header, payload] = body.trim().split(".");
  const decode = (value: string) =>
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "base64url")));
  const metadata = decode(header);
  if (
    !metadata ||
    typeof metadata !== "object" ||
    typeof metadata.alg !== "string" ||
    metadata.b64 === false
  )
    throw new Error("Unsupported compact JSON encoding");
  return {
    data: decode(payload) as unknown,
    encoding: "jws" as const,
    signatureVerified: false as const,
  };
}
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
/** Keep observed anchor destinations beside their rendered labels, as in the
 * native HTTP Markdown reader. Ambiguous labels never acquire a guessed URL. */
export function renderedPublicText(page: RenderedPublicPage) {
  const links = new Map<string, string | null>();
  for (const link of page.links ?? []) {
    const title = link.title.trim();
    try {
      const url = new URL(link.url, page.url);
      if (!title || !/^https?:$/.test(url.protocol) || url.username || url.password) continue;
      const previous = links.get(title);
      links.set(title, previous === undefined || previous === url.href ? url.href : null);
    } catch {
      // Invalid observed metadata cannot create a link.
    }
  }
  return page.text
    .split("\n")
    .map((line) => {
      const title = line.trim(),
        url = links.get(title);
      return url
        ? `[${title.replace(/[[\]\\]/g, "\\$&")}](${url.replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29"))})`
        : line;
    })
    .join("\n");
}

export const publicReadDescription =
  "Read public HTML/JSON and discovered data URLs. Default auto uses HTTP; mode=headless renders JavaScript on the VPS. mode=browser is a legacy alias for headless. Inspect dataSources for published datasets. Truncated content does not establish that unread fields are absent.";

export const publicResearchInstructions =
  " Search with search_web and read relevant pages with web_fetch or web_extract (up to four URLs together). Snippets are leads, not full source reads. Prefer HTTP; use headless for JavaScript content. Follow relevant page links before treating missing facts as unavailable: Match the subject, metric, category and date of each data record to the request; dataSources can include unrelated analytics or datasets for other subjects. A page listing other subjects is a lead to follow, not the requested comparison. Every reported number must appear in a relevant source read or a computation from its data; never fill missing values from memory. Use observed URLs or published URL templates, never invented endpoints. Use run_computer_command for complex datasets and batches; discover read_web_data when its structured queries help. Do not page thousands of records to compute a summary. Truncated excerpts and missing fields are not absence of data. Use the live runtime date. Attribute a reputable publisher's data honestly when direct primary-source access is unavailable. Public research needs no new credentials. Once the requested facts are sufficient, produce the requested deliverable. Report partial results only after relevant available paths are exhausted.";

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
export function requestPublicPage(
  target: Target,
  signal: AbortSignal,
  byteLimit = maxBytes,
): Promise<Response> {
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
        if (Number(incoming.headers["content-length"]) > byteLimit) {
          incoming.destroy();
          reject(
            new WebReadError(
              "PAGE_TOO_LARGE",
              `The public page exceeds the ${byteLimit / 1024 / 1024} MiB read limit. Use read_web_data for a large published JSON dataset.`,
            ),
          );
          return;
        }
        const encoding = String(incoming.headers["content-encoding"] ?? "identity")
          .trim()
          .toLowerCase();
        const decoder =
          encoding === "gzip"
            ? createGunzip()
            : encoding === "deflate"
              ? createInflate()
              : encoding === "br"
                ? createBrotliDecompress()
                : undefined;
        if (encoding !== "identity" && !decoder) {
          incoming.destroy();
          reject(
            new WebReadError(
              "UNSUPPORTED_ENCODING",
              "The public page returned an unsupported content encoding.",
            ),
          );
          return;
        }
        const content = decoder ?? incoming;
        if (decoder) {
          const abort = () => {
            decoder.destroy();
            incoming.destroy();
            reject(signal.reason ?? new Error("Read aborted"));
          };
          signal.addEventListener("abort", abort, { once: true });
          decoder.once("close", () => signal.removeEventListener("abort", abort));
          incoming.on("error", (error) => decoder.destroy(error));
          incoming.on("aborted", () => decoder.destroy(new Error("Public response interrupted")));
          incoming.pipe(decoder);
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        content.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > byteLimit) {
            content.destroy();
            incoming.destroy();
            reject(
              new WebReadError(
                "PAGE_TOO_LARGE",
                `The public page exceeds the ${byteLimit / 1024 / 1024} MiB read limit. Use read_web_data for a large published JSON dataset.`,
              ),
            );
          } else chunks.push(chunk);
        });
        content.on("error", reject);
        content.on("end", () => {
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
export function htmlText(node: Node, excludedTags: readonly string[] = []): string {
  const text: string[] = [],
    pending = [node];
  while (pending.length) {
    const current = pending.pop()!;
    if (
      "tagName" in current &&
      (/^(script|style|noscript|template|svg|canvas|iframe)$/.test(current.tagName) ||
        excludedTags.includes(current.tagName))
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
    private readonly dependencies: {
      resolve?: Resolver;
      request?: typeof requestPublicPage;
      renderHtml?: (html: string) => Promise<string>;
    } = {},
  ) {}
  async readData(url: string, query: PublicDataQuery = {}, signal?: AbortSignal) {
    const document = await this.document(url, signal, maxDataBytes);
    let source: ReturnType<typeof publicJson>;
    try {
      source = publicJson(document.body);
    } catch {
      throw new WebReadError(
        "INVALID_JSON",
        "This source is not valid JSON; use web_fetch for an HTML page.",
      );
    }
    const result = selectPublicData(source.data, query);
    return {
      ...result,
      url: document.url,
      observedAt: new Date().toISOString(),
      bytes: Buffer.byteLength(document.body),
      encoding: source.encoding,
      signatureVerified: source.signatureVerified,
    };
  }
  async validate(url: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return abortable(validatePublicUrl(url, this.dependencies.resolve), signal);
  }
  async document(rawUrl: string, externalSignal?: AbortSignal, byteLimit = maxBytes) {
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
        response = await request(target, signal, byteLimit);
      } catch (error) {
        signal.throwIfAborted();
        if (
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          !["ECONNRESET", "EPIPE"].includes(String(error.code))
        )
          throw error;
        response = await request(await this.validate(url, signal), signal, byteLimit);
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
      if (Buffer.byteLength(response.body) > byteLimit)
        throw new WebReadError(
          "PAGE_TOO_LARGE",
          `The public page exceeds the ${byteLimit / 1024 / 1024} MiB limit. Use read_web_data for a large published JSON dataset.`,
        );
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
          "application/jose",
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
    let rendered: RenderedPublicPage;
    try {
      rendered = await options.render(url, signal);
      signal?.throwIfAborted();
      if (!readablePage({ ...rendered, extraction: undefined }))
        throw new WebReadError(
          "PAGE_BLOCKED",
          "The rendered source is still blocked or empty. Read a different public source; no source data was verified.",
        );
    } catch (error) {
      signal?.throwIfAborted();
      // Rendering and public HTTP have independent transports. A renderer failure
      // does not establish that the source is unavailable through HTTP. The HTTP
      // reader validates and pins every destination and redirect independently.
      try {
        const page = await this.readHttp(url, signal);
        if (readablePage(page)) return page;
      } catch {
        signal?.throwIfAborted();
      }
      throw error;
    }
    const text = renderedPublicText(rendered);
    return {
      ...rendered,
      text: text.slice(0, maxText),
      links: rendered.links ?? [],
      dataSources: rendered.dataSources ?? [],
      truncated: rendered.truncated || text.length > maxText,
      extraction: rendered.extraction ?? { status: "readable" as const },
      observedAt: new Date().toISOString(),
      provenance: { backend: "browser" as const, mode: "headless" as const },
    };
  }
  private async readHttp(url: string, signal?: AbortSignal) {
    const target = new URL(url);
    const publishedData =
      /\.(?:json|jws)$/i.test(target.pathname) ||
      target.searchParams.get("format")?.toLowerCase() === "json";
    // Published datasets use the same bounded transfer as readData. A model
    // should receive their values/shape and paging guidance, not a page-size
    // error that makes an accessible dataset look unavailable.
    const document = await this.document(url, signal, publishedData ? maxDataBytes : maxBytes);
    if (
      (/json/.test(document.contentType) && document.body.length > maxText) ||
      compactJson.test(document.body.trim())
    ) {
      let source: ReturnType<typeof publicJson>;
      try {
        source = publicJson(document.body);
      } catch {
        throw new WebReadError("INVALID_JSON", "This source is not valid JSON.");
      }
      const projection = selectPublicData(source.data);
      // Match the upstream JSON reader: preserve source values in its text,
      // rather than replacing a large root object with an empty query result.
      const text = JSON.stringify(source.data, null, 2);
      return {
        url: document.url,
        title: new URL(document.url).hostname,
        text: text.slice(0, maxText),
        structure: projection.structure,
        links: [],
        dataSources: [{ url: document.url, kind: "published-data-link" }],
        extraction: {
          status: "partial" as const,
          reason:
            "This is a source JSON excerpt; unread fields remain available at this URL. Use run_computer_command to read and compute the complete dataset, or discover read_web_data for selected fields and aggregation. Do not infer absence from this excerpt or page thousands of rows to compute a summary.",
        },
        truncated: true,
        observedAt: new Date().toISOString(),
        provenance: {
          backend: "http" as const,
          authenticated: false as const,
          encoding: source.encoding,
          signatureVerified: source.signatureVerified,
        },
      };
    }
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
    let readableText = visibleText;
    if (html && this.dependencies.renderHtml) {
      // Preserve accessible image labels before the native text renderer drops images.
      for (const node of htmlNodes(root, (node) => node.nodeName === "img")) {
        if (!("tagName" in node)) continue;
        const label = htmlAttribute(node, "alt") ?? "";
        node.nodeName = node.tagName = "span";
        node.childNodes = [{ nodeName: "#text", value: label, parentNode: node }];
      }
      for (const node of htmlNodes(root, (node) => node.nodeName === "a")) {
        if (!("attrs" in node)) continue;
        const href = node.attrs.find((attr) => attr.name === "href");
        if (!href) continue;
        try {
          const url = new URL(href.value, document.url);
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.href.length > 4096
          )
            throw new Error("Unsupported public link");
          href.value = url.href;
        } catch {
          node.attrs = node.attrs.filter((attr) => attr !== href);
        }
      }
      const content = main ?? htmlNodes(root, (node) => node.nodeName === "body")[0] ?? root;
      readableText = await this.dependencies.renderHtml(
        serialize("childNodes" in content ? content : root),
      );
    }
    const extracted = structured
      ? readableText.slice(0, 19000) + structured.slice(0, 11000)
      : readableText;
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
    const hasScripts = htmlNodes(root, (node) => node.nodeName === "script").length > 0;
    // Live widgets can contain substantial article text while their data is
    // still a template. Default zero counts beside unresolved fields are not
    // observed results. Code examples remain ordinary readable content.
    const unresolvedBindings =
      html &&
      hasScripts &&
      new Set(
        htmlText(main ?? root, ["code", "pre"]).match(/\{\{?\s*[A-Za-z_$][\w.$-]*\s*\}?\}/g) ?? [],
      ).size >= 2;
    const shell =
      html &&
      !products.length &&
      visibleText.length < 100 &&
      htmlNodes(root, (node) => node.nodeName === "script" && Boolean(htmlAttribute(node, "src")))
        .length > 0;
    const extraction =
      pending || unresolvedBindings || (shell && !data.embedded && !products.length)
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
        (Boolean(structured) && (readableText.length > 19000 || structured.length > 11000)),
      observedAt: new Date().toISOString(),
      provenance: { backend: "http" as const, authenticated: false as const },
    };
  }
}
