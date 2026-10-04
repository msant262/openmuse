import assert from "node:assert/strict";
import test from "node:test";
import { PublicWeb, readablePage } from "../apps/server/src/public-web.ts";

const resolve = async () => [{ address: "93.184.216.34", family: 4 }];

test("published JSON endpoints survive empty configuration values and escaped URL slashes", async () => {
  const config = JSON.stringify({
    unused: "",
    results: "https://data.example/results.JSON",
  }).replaceAll("/", "\\/");
  const web = new PublicWeb({
    resolve,
    request: async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<title>Count</title><main>Results</main><script>globalThis.config=${config}</script>`,
    }),
  });
  assert.ok(
    (await web.read("https://news.example/")).dataSources.some(
      (source) => source.url === "https://data.example/results.JSON",
    ),
  );
});

test("HTTP discovery returns published data URLs without silently starting a browser", async () => {
  const requests: string[] = [];
  const web = new PublicWeb({
    resolve,
    request: async (target) => {
      requests.push(target.url.href);
      return {
        status: 200,
        headers: { "content-type": "text/html" },
        body: `<title>Live count</title><main class="loading">Loading results</main><script>globalThis.config={"results":"https://data.example/results.json"};window.untrustedExecuted=true;</script><link rel="alternate" type="application/json" href="/api/count"></link>`,
      };
    },
  });
  const page = await web.read("https://news.example/live", undefined, {
    render: async () => {
      throw new Error("Must inspect data sources before rendering");
    },
  });
  assert.equal(readablePage(page), false);
  assert.ok(page.dataSources.some((s) => s.url === "https://data.example/results.json"));
  assert.ok(page.dataSources.some((s) => s.url === "https://news.example/api/count"));
  assert.deepEqual(requests, ["https://news.example/live"]);
  assert.equal((globalThis as Record<string, unknown>).untrustedExecuted, undefined);
});

test("HTTP exposes embedded application JSON without executing JavaScript", async () => {
  const web = new PublicWeb({
    resolve,
    request: async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: '<title>Offers</title><main>Offers</main><script id="__NEXT_DATA__" type="application/json">{"props":{"products":[{"name":"Velvet","price":12,"currency":"EUR"}]}}</script>',
    }),
  });
  const page = await web.read("https://shop.example/");
  assert.match(page.text, /Velvet/);
  assert.match(page.text, /"price":12/);
  assert.equal(page.provenance.backend, "http");
});

test("headless mode is explicit after an HTTP block and still rejects private targets", async () => {
  const web = new PublicWeb({
    resolve,
    request: async () => ({ status: 403, headers: {}, body: "Denied" }),
  });
  let renders = 0;
  const render = async (url: string) => {
    renders++;
    return { url, title: "Results", text: "Useful observed results", truncated: false };
  };
  const failed = await web.read("https://news.example/", undefined, { render });
  assert.equal(readablePage(failed), false);
  assert.equal(renders, 0);
  const page = await web.read("https://news.example/", undefined, { mode: "headless", render });
  assert.match(page.text, /Useful observed/);
  assert.equal(renders, 1);
  await assert.rejects(web.read("http://127.0.0.1/", undefined, { mode: "headless", render }), {
    code: "BLOCKED_URL",
  });
});
