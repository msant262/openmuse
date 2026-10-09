import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { taskRuntime } from "./helpers/task-runtime.ts";

const resolve = async () => [{ address: "93.184.216.34", family: 4 }];

test("a course article with a static logo placeholder stays readable over HTTP", async () => {
  const { PublicWeb, readablePage } = await import("../apps/server/src/public-web.ts");
  const web = new PublicWeb({
    resolve,
    request: async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: '<title>Course</title><main><h1>Generative AI</h1><p>The full course is free. Duration: 4 hours.</p><span class="skillup-meta__logo-placeholder">Included with</span></main>',
    }),
  });
  const page = await web.read("https://courses.example/course");
  assert.equal(page.extraction.status, "readable");
  assert.equal(readablePage(page), true);
});

test("the production reader keeps native Markdown links with their context and filters hidden content", async (t) => {
  const f = await taskRuntime(t);
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: '<article><h1>Regional results</h1><p>For the requested category, read <a href="/presidential">Presidential results</a>.</p><p><a href="/votes"><img alt="Candidate votes" src="/photo.png"></a>: 52%</p><p style="display:none">HIDDEN-UNTRUSTED-INSTRUCTION</p><a href="javascript:steal()">Bad link</a></article>',
  }));
  const page = await f.agent.web.read("https://results.example/index");
  assert.match(page.text, /# Regional results/);
  assert.match(page.text, /\[Presidential results\]\(https:\/\/results\.example\/presidential\)/);
  assert.match(page.text, /\[Candidate votes\]\(https:\/\/results\.example\/votes\): 52%/);
  assert.doesNotMatch(page.text, /HIDDEN-UNTRUSTED-INSTRUCTION|javascript:steal/);
  assert.equal(page.provenance.backend, "http");
});

test("headless public reading retains the observed link beside its label without guessing ambiguous links", async () => {
  const { PublicWeb } = await import("../apps/server/src/public-web.ts");
  const web = new PublicWeb({ resolve });
  const page = await web.read("https://news.example/overview", undefined, {
    mode: "headless",
    render: async (url) => ({
      url,
      title: "Results",
      text: "Regional overview\nPresidential results\nOther results\nMore\nUnsafe",
      truncated: false,
      links: [
        { title: "Presidential results", url: "https://news.example/presidential" },
        { title: "More", url: "https://news.example/one" },
        { title: "More", url: "https://news.example/two" },
        { title: "Unsafe", url: "javascript:alert(1)" },
      ],
    }),
  });
  assert.match(
    page.text,
    /Regional overview\n\[Presidential results\]\(https:\/\/news\.example\/presidential\)/,
  );
  assert.match(page.text, /Other results\nMore\nUnsafe/);
  assert.doesNotMatch(page.text, /javascript:|news\.example\/(?:one|two)/);
});

test("public reading identifies pending content and explicitly renders it before returning evidence", async () => {
  const { PublicWeb, readablePage } = await import("../apps/server/src/public-web.ts");
  const web = new PublicWeb({
    resolve,
    request: async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body:
        '<title>Live results</title><main><h1>Results</h1><div class="results-placeholder">Location 0 '.repeat(
          1,
        ) +
        'View results</div><p>Source and explanatory notes.</p><script src="/app.js"></script></main>',
    }),
  });
  const raw = await web.read("https://news.example/live");
  assert.equal(readablePage(raw), false, "a loading shell must not count as observed data");
  const page = await web.read("https://news.example/live", undefined, {
    mode: "headless",
    render: async (url) => ({
      url,
      title: "Live results",
      text: "Candidate A: 52% of 12345 votes.",
      truncated: false,
    }),
  });
  assert.match(page.text, /12345 votes/);
  assert.equal(page.provenance.backend, "browser");
  assert.equal(readablePage(page), true);
});

test("ordinary articles with advertising skeletons stay on HTTP", async () => {
  const { PublicWeb } = await import("../apps/server/src/public-web.ts");
  const web = new PublicWeb({
    resolve,
    request: async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: '<title>Report</title><article><div class="advertisement skeleton"></div><h1>Report</h1><p>Complete article text.</p></article>',
    }),
  });
  const page = await web.read("https://news.example/article", undefined, {
    render: async () => {
      throw new Error("Unnecessary browser dispatch");
    },
  });
  assert.equal(page.provenance.backend, "http");
});

test("a populated form select with placeholder styling is not a loading application", async () => {
  const { PublicWeb, readablePage } = await import("../apps/server/src/public-web.ts");
  const web = new PublicWeb({
    resolve,
    request: async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: '<title>Course</title><main><h1>Generative AI course</h1><p>The full course is free to study.</p><form><select class="hs-input is-placeholder"><option>Please Select</option><option>Brazil</option></select></form></main>',
    }),
  });
  const page = await web.read("https://courses.example/course");
  assert.equal(page.extraction.status, "readable");
  assert.equal(readablePage(page), true);
});

test("rendering that remains incomplete cannot become evidence and cancellation cannot trigger another read", async () => {
  const { PublicWeb, readablePage } = await import("../apps/server/src/public-web.ts");
  const web = new PublicWeb({
    resolve,
    request: async () => ({ status: 403, headers: {}, body: "Denied" }),
  });
  const partial = await web.read("https://news.example/live", undefined, {
    mode: "headless",
    render: async (url) => ({
      url,
      title: "Live results",
      text: "Loading results",
      truncated: false,
      extraction: { status: "partial" },
    }),
  });
  assert.equal(readablePage(partial), false);
  const controller = new AbortController();
  await assert.rejects(
    web.read("https://news.example/live", controller.signal, {
      mode: "headless",
      render: async (url) => {
        controller.abort(new Error("Read cancelled"));
        return { url, title: "Live results", text: "Result", truncated: false };
      },
    }),
    /Read cancelled/,
  );
});

test("explicit headless reading recovers a blocked source but never retries unsafe URLs", async () => {
  const { PublicWeb } = await import("../apps/server/src/public-web.ts");
  const web = new PublicWeb({
    resolve,
    request: async () => ({ status: 403, headers: {}, body: "Denied" }),
  });
  let calls = 0;
  const render = async (url: string) => {
    calls++;
    return { url, title: "Store", text: "Lipstick: €12, available.", truncated: false };
  };
  const page = await web.read("https://shop.example/", undefined, { mode: "headless", render });
  assert.match(page.text, /Lipstick: €12/);
  await assert.rejects(web.read("http://127.0.0.1/", undefined, { mode: "headless", render }), {
    code: "BLOCKED_URL",
  });
  assert.equal(calls, 1);
});

test("a failed public renderer recovers through guarded HTTP without retrying private redirects or cancellation", async () => {
  const { PublicWeb } = await import("../apps/server/src/public-web.ts");
  let requests = 0;
  const web = new PublicWeb({
    resolve,
    request: async (target) => {
      requests++;
      return target.url.pathname === "/private-redirect"
        ? { status: 302, headers: { location: "http://169.254.169.254/" }, body: "" }
        : {
            status: 200,
            headers: { "content-type": "text/html" },
            body: "<title>Results</title><article>Published votes: 52% and 48%.</article>",
          };
    },
  });
  const render = async (): Promise<never> => {
    throw new Error("Renderer failed");
  };
  const page = await web.read("https://results.example/current", undefined, {
    mode: "headless",
    render,
  });
  assert.equal(page.provenance.backend, "http");
  assert.match(page.text, /52% and 48%/);
  assert.equal(requests, 1);
  await assert.rejects(
    web.read("https://results.example/private-redirect", undefined, { mode: "headless", render }),
    /Renderer failed/,
  );
  assert.equal(requests, 2, "a private redirect is never dispatched");
  await assert.rejects(web.read("http://127.0.0.1/", undefined, { mode: "headless", render }), {
    code: "BLOCKED_URL",
  });
  const controller = new AbortController();
  await assert.rejects(
    web.read("https://results.example/current", controller.signal, {
      mode: "headless",
      render: async () => {
        controller.abort(new Error("Read cancelled"));
        throw new Error("Renderer failed");
      },
    }),
    /Read cancelled/,
  );
  assert.equal(requests, 2, "cancellation never dispatches a fallback");
});

test("image-only product links retain their accessible name beside the observed price", async () => {
  const { PublicWeb } = await import("../apps/server/src/public-web.ts");
  const web = new PublicWeb({
    resolve,
    request: async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: '<title>Makeup</title><main><a href="/lipstick"><img alt="Velvet Lipstick" src="/p.jpg"></a><p>Current price: €12</p></main>',
    }),
  });
  const page = await web.read("https://shop.example/sale");
  assert.match(page.text, /Velvet Lipstick.*€12/);
  assert.deepEqual(page.links, [
    { title: "Velvet Lipstick", url: "https://shop.example/lipstick" },
  ]);
});

test("RSS discovery rejects acronym-only matches on an unrelated topic", async () => {
  const { PublicWeb } = await import("../apps/server/src/public-web.ts");
  const { HttpSearchBackend } = await import("../apps/server/src/search.ts");
  const web = new PublicWeb({
    resolve,
    request: async (target) => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: target.url.hostname.includes("bing")
        ? "<rss><channel><item><title>TSE kassensysteme</title><link>https://cash.example/tse</link><description>TSE Sicherheitseinrichtung</description></item><item><title>Eleições: apuração de votos</title><link>https://news.example/results</link><description>Resultados do Brasil</description></item></channel></rss>"
        : "<title>Challenge</title>",
    }),
  });
  const result = await new HttpSearchBackend(web).search(
    { query: "TSE eleições apuração resultados Brasil 2026", limit: 5 },
    { owner: "owner" },
  );
  assert.deepEqual(
    result.sources.map((source) => source.url),
    ["https://news.example/results"],
  );
});

test("public fetch reads useful HTML and links without opening a browser, with bounded text", async (t) => {
  const f = await taskRuntime(t);
  assert.ok(f.agent.web, "Public HTTP reading must be available without a browser");
  const { PublicWeb } = await import("../apps/server/src/public-web.ts");
  const web = new PublicWeb({
    resolve,
    request: async (target) => {
      assert.equal(target.address, "93.184.216.34");
      return {
        status: 200,
        headers: { "content-type": "text/html" },
        body: '<html><title>Make-up Sale</title><nav>Menu</nav><main><h1>Batom</h1><p>Preço €12 &amp; entrega local.</p><a href="/item">Ver produto</a><script>bad()</script></main></html>',
      };
    },
  });
  const page = await web.read("https://shop.example/sale");
  assert.equal(page.title, "Make-up Sale");
  assert.match(page.text, /Preço €12 & entrega local/);
  assert.doesNotMatch(page.text, /bad\(\)/);
  assert.ok(page.links.some((link) => link.url === "https://shop.example/item"));
  assert.equal(page.provenance.backend, "http");
  assert.equal((await f.db.list("owner", "browsers")).length, 0);
});

test("public fetch rejects private targets and private redirects before dispatch", async (t) => {
  const f = await taskRuntime(t);
  assert.ok(f.agent.web);
  const { PublicWeb } = await import("../apps/server/src/public-web.ts");
  let dispatched = 0;
  const web = new PublicWeb({
    resolve,
    request: async () => {
      dispatched++;
      return {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
        body: "",
      };
    },
  });
  for (const url of [
    "http://127.0.0.1/",
    "http://localhost/",
    "file:///etc/passwd",
    "https://user:secret@shop.example/",
  ])
    await assert.rejects(web.read(url), { code: "BLOCKED_URL" });
  assert.equal(dispatched, 0);
  await assert.rejects(web.read("https://shop.example/"), { code: "BLOCKED_URL" });
  assert.equal(dispatched, 1);
  const mixed = new PublicWeb({
    resolve: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ],
    request: async () => {
      throw new Error("must not dispatch");
    },
  });
  await assert.rejects(mixed.read("https://shop.example/"), { code: "BLOCKED_URL" });
});

test("public fetch identifies blocked or unsupported pages without claiming a read", async (t) => {
  const f = await taskRuntime(t);
  assert.ok(f.agent.web);
  const { PublicWeb } = await import("../apps/server/src/public-web.ts");
  for (const response of [
    { status: 403, headers: { "content-type": "text/html" }, body: "Denied" },
    {
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<title>Access Denied</title>Access Denied",
    },
    { status: 200, headers: { "content-type": "application/octet-stream" }, body: "binary" },
  ]) {
    const web = new PublicWeb({ resolve, request: async () => response });
    await assert.rejects(web.read("https://shop.example/"));
  }
});

test("HTTP search returns actual source links without launching browser work and labels index evidence", async (t) => {
  const f = await taskRuntime(t);
  assert.ok(f.agent.web);
  const { PublicWeb } = await import("../apps/server/src/public-web.ts");
  const { HttpSearchBackend } = await import("../apps/server/src/search.ts");
  const web = new PublicWeb({
    resolve,
    request: async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fshop.example%2Fsale">Make-up Sale</a><div class="result__snippet">Index mentions €12</div></div><div class="result"><a class="result__a" href="http://127.0.0.1/">Unsafe</a></div>',
    }),
  });
  const result = await new HttpSearchBackend(web).search(
    { query: "maquiagem Alemanha", limit: 5 },
    { owner: "owner" },
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(result.sources, [
    { title: "Make-up Sale", url: "https://shop.example/sale", snippet: "Index mentions €12" },
  ]);
  assert.equal(result.provenance.backend, "http");
  assert.equal(result.provenance.fullPagesRead, false);
});

test("HTTP transport pins the supplied address, sends no credentials and bounds streams", async (t) => {
  const { requestPublicPage } = await import("../apps/server/src/public-web.ts");
  const headers: object[] = [];
  const server = createServer((req, res) => {
    headers.push(req.headers);
    if (req.url === "/large") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("x".repeat(2 * 1024 * 1024 + 1));
    } else {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Real HTTP response");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = new URL(`http://must-not-resolve.invalid:${address.port}/`);
  const result = await requestPublicPage(
    { url, address: "127.0.0.1", family: 4 },
    AbortSignal.timeout(2000),
  );
  assert.equal(result.body, "Real HTTP response");
  assert.equal((headers[0] as { host: string }).host, `must-not-resolve.invalid:${address.port}`);
  assert.equal("authorization" in headers[0], false);
  assert.equal("cookie" in headers[0], false);
  url.pathname = "/large";
  await assert.rejects(
    requestPublicPage({ url, address: "127.0.0.1", family: 4 }, AbortSignal.timeout(2000)),
    { code: "PAGE_TOO_LARGE" },
  );
});

test("public fetch preserves structured product offers without executing page scripts", async () => {
  const { PublicWeb } = await import("../apps/server/src/public-web.ts");
  const web = new PublicWeb({
    resolve,
    request: async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: '<title>Sale</title><main>Produtos</main><script type="application/ld+json">{"@type":"Product","name":"Batom","offers":{"@type":"Offer","price":"12.00","priceCurrency":"EUR","availability":"https://schema.org/InStock"}}</script><script>stealCookies()</script>',
    }),
  });
  const page = await web.read("https://shop.example/sale");
  assert.match(page.text, /Batom/);
  assert.match(page.text, /12\.00/);
  assert.match(page.text, /EUR/);
  assert.doesNotMatch(page.text, /stealCookies/);
});

test("redirect response bodies are closed immediately instead of draining unbounded bytes", async (t) => {
  const { requestPublicPage } = await import("../apps/server/src/public-web.ts");
  let closed = false;
  const server = createServer((_req, res) => {
    res.writeHead(302, { Location: "https://shop.example/final" });
    const timer = setInterval(() => res.write("x".repeat(65536)), 5);
    res.on("close", () => {
      clearInterval(timer);
      closed = true;
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await requestPublicPage(
    { url: new URL(`http://test.invalid:${address.port}/`), address: "127.0.0.1", family: 4 },
    AbortSignal.timeout(2000),
  );
  assert.equal(response.status, 302);
  for (let i = 0; i < 20 && !closed; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(closed, true, "the redirect body must not keep streaming after returning headers");
});

test("fetch cancellation stops waiting for DNS and never dispatches late resolution", async () => {
  const { PublicWeb } = await import("../apps/server/src/public-web.ts");
  let release!: (value: { address: string; family: number }[]) => void;
  let dispatched = false;
  const web = new PublicWeb({
    resolve: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    request: async () => {
      dispatched = true;
      throw new Error("Unexpected request");
    },
  });
  const abort = new AbortController();
  const result = web.read("https://shop.example/", abort.signal);
  abort.abort(new Error("User cancelled"));
  await assert.rejects(result, /User cancelled/);
  release([{ address: "93.184.216.34", family: 4 }]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dispatched, false);
});

test("deep valid HTML stays readable and redirect loops stop after five requests", async () => {
  const { PublicWeb } = await import("../apps/server/src/public-web.ts");
  const web = new PublicWeb({
    resolve,
    request: async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<title>Offer</title>" + "<div>".repeat(8000) + "Batom €12" + "</div>".repeat(8000),
    }),
  });
  assert.match((await web.read("https://shop.example/")).text, /Batom €12/);
  let requests = 0;
  const loop = new PublicWeb({
    resolve,
    request: async () => {
      requests++;
      return { status: 302, headers: { location: "/loop" }, body: "" };
    },
  });
  await assert.rejects(loop.read("https://shop.example/"), { code: "TOO_MANY_REDIRECTS" });
  assert.equal(requests, 5);
});

test("HTTP search reads public RSS without first waiting on unavailable DuckDuckGo endpoints", async () => {
  const { PublicWeb } = await import("../apps/server/src/public-web.ts");
  const { HttpSearchBackend } = await import("../apps/server/src/search.ts");
  const urls: string[] = [];
  const web = new PublicWeb({
    resolve,
    request: async (target) => {
      urls.push(target.url.href);
      return target.url.hostname === "www.bing.com"
        ? {
            status: 200,
            headers: { "content-type": "text/xml; charset=utf-8" },
            body: '<?xml version="1.0"?><rss><channel><title>Search</title><item><title>Makeup discounts</title><link>https://shop.example/sale</link><description>Current offers</description></item></channel></rss>',
          }
        : { status: 503, headers: { "content-type": "text/html" }, body: "Unavailable" };
    },
  });
  const result = await new HttpSearchBackend(web).search(
    { query: "makeup deals", limit: 3 },
    { owner: "owner" },
  );
  assert.equal(result.status, "ok");
  assert.equal(result.provenance.provider, "bing-rss");
  assert.equal(result.sources[0].url, "https://shop.example/sale");
  assert.equal(result.sources[0].title, "Makeup discounts");
  assert.equal(urls.length, 1);
});

test("failed source reads recover exact observed URLs without inventing or claiming to read them", async () => {
  const { observedSourceAlternatives } = await import("../apps/server/src/public-extract.ts");
  assert.deepEqual(
    observedSourceAlternatives("https://news.example/results-shortened", [
      "https://news.example/results-as-published",
      "https://other.example/results",
      "https://news.example/results-as-published",
      "invalid",
      "https://news.example/results-shortened",
    ]),
    ["https://news.example/results-as-published"],
  );
});

test("subsequent searches use the available provider while retaining fallback and fresh query results", async () => {
  const { PublicWeb } = await import("../apps/server/src/public-web.ts");
  const { HttpSearchBackend } = await import("../apps/server/src/search.ts");
  const hosts: string[] = [];
  const web = new PublicWeb({
    resolve,
    request: async (target) => {
      hosts.push(target.url.hostname);
      return target.url.hostname === "www.bing.com"
        ? { status: 503, headers: { "content-type": "text/html" }, body: "Unavailable" }
        : {
            status: 200,
            headers: { "content-type": "text/html" },
            body: `<a class="result__a" href="https://shop.example/${target.url.searchParams.get("q")}">Available source</a>`,
          };
    },
  });
  const backend = new HttpSearchBackend(web);
  assert.equal(
    (await backend.search({ query: "first", limit: 1 }, { owner: "owner" })).status,
    "ok",
  );
  const second = await backend.search({ query: "second", limit: 1 }, { owner: "owner" });
  assert.equal(second.sources[0].url, "https://shop.example/second");
  assert.deepEqual(hosts, ["www.bing.com", "lite.duckduckgo.com", "lite.duckduckgo.com"]);
});

test("search snippets stay attached to their result when another result has no snippet", async () => {
  const { PublicWeb } = await import("../apps/server/src/public-web.ts");
  const { HttpSearchBackend } = await import("../apps/server/src/search.ts");
  for (const html of [
    '<div class="result"><a class="result__a" href="https://a.example/">Brand A</a></div><div class="result"><a class="result__a" href="https://b.example/">Brand B</a><div class="result__snippet">Brand B lipstick €9.99</div></div>',
    '<table><tr><td><a class="result-link" href="https://a.example/">Brand A</a></td></tr><tr><td><a class="result-link" href="https://b.example/">Brand B</a></td></tr><tr><td class="result-snippet">Brand B lipstick €9.99</td></tr></table>',
  ]) {
    const web = new PublicWeb({
      resolve,
      request: async () => ({ status: 200, headers: { "content-type": "text/html" }, body: html }),
    });
    const result = await new HttpSearchBackend(web).search(
      { query: "lipstick", limit: 5 },
      { owner: "owner" },
    );
    assert.equal(result.sources[0].snippet, "");
    assert.equal(result.sources[1].snippet, "Brand B lipstick €9.99");
  }
});

test("cancellation during source validation does not become an empty search result", async () => {
  const { PublicWeb } = await import("../apps/server/src/public-web.ts");
  const { HttpSearchBackend } = await import("../apps/server/src/search.ts");
  const controller = new AbortController();
  const web = new PublicWeb({
    resolve: async (host) => {
      if (host === "shop.example") controller.abort();
      return resolve();
    },
    request: async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: '<div class="result"><a class="result__a" href="https://shop.example/">Sale</a></div>',
    }),
  });
  const result = await new HttpSearchBackend(web).search(
    { query: "sale", limit: 5 },
    { owner: "owner", signal: controller.signal },
  );
  assert.equal(result.status, "cancelled");
  assert.equal(result.code, "SEARCH_CANCELLED");
});

test("a truncated JSON read preserves the complete owner-only source snapshot without browser rendering", async (t) => {
  const { extractPublicSources } = await import("../apps/server/src/public-extract.ts");
  const { preservePublicSource } = await import("../apps/server/src/public-web.ts");
  const f = await taskRuntime(t);
  const data = {
    rows: Array.from({ length: 800 }, (_, index) => ({
      region: `Region ${index}`,
      values: [51, 49],
      description: "x".repeat(80),
    })),
  };
  let reads = 0;
  t.mock.method(f.agent.web, "document", async (url: string) => {
    reads++;
    return { url, contentType: "application/json", body: JSON.stringify(data) };
  });
  const render = async () => {
    throw new Error("JSON must not be rendered");
  };
  const [page] = await extractPublicSources(
    f.agent.web,
    ["https://results.example/data.json"],
    undefined,
    render,
    { spill: preservePublicSource(f.files, "owner") },
  );
  assert.equal(reads, 1);
  assert.equal(page.truncated, true);
  assert.ok(page.spill);
  assert.equal(page.spill.truncated, false);
  assert.deepEqual(JSON.parse((await f.files.bytes("owner", page.spill.fileId)).toString()), data);
  await assert.rejects(f.files.bytes("other-owner", page.spill.fileId));
  assert.equal(
    (await f.files.list("owner")).length,
    0,
    "cached sources are not delivered attachments",
  );
  const full = await f.agent.web.read("https://results.example/data.json", undefined, {
    mode: "headless",
    maxChars: 300000,
    render,
  });
  assert.equal(full.truncated, false);
  assert.equal(full.extraction.status, "readable");
  assert.deepEqual(JSON.parse(full.text), data);
});
