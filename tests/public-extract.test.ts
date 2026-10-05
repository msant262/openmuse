import assert from "node:assert/strict";
import test from "node:test";
import { extractPublicSources } from "../apps/server/src/public-extract.ts";
import { PublicWeb } from "../apps/server/src/public-web.ts";

test("batch extraction preserves successes and rescues only blocked/loading pages in order", async () => {
  const renders: string[] = [];
  const web = new PublicWeb({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async (target) =>
      target.url.pathname === "/blocked"
        ? { status: 403, headers: {}, body: "Denied" }
        : {
            status: 200,
            headers: { "content-type": "text/html" },
            body: "<title>Live count</title><main>Candidate A: 51%, 12345 votes</main>",
          },
  });
  const pages = await extractPublicSources(
    web,
    ["https://news.example/live", "https://other.example/blocked", "http://127.0.0.1/private"],
    undefined,
    async (url) => {
      renders.push(url);
      return { url, title: "Other count", text: "Candidate A: 51%, 12345 votes", truncated: false };
    },
  );
  assert.equal(pages.length, 3);
  assert.match(pages[0].text, /12345/);
  assert.match(pages[1].text, /12345/);
  assert.ok(pages[2].error);
  assert.deepEqual(renders, ["https://other.example/blocked"]);
  assert.equal(pages[0].url, "https://news.example/live");
});

test("cancelled extraction never dispatches fallback reads", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(
    extractPublicSources(new PublicWeb(), ["https://example.com"], controller.signal, async () => {
      throw new Error("should not render");
    }),
    /cancelled/,
  );
});

test("unresolved live-widget templates trigger rendering instead of certifying default zero results", async () => {
  const web = new PublicWeb({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: '<title>Live results</title><main><p>The count started after polls closed. This article explains the contest and the voting schedule, while the interactive dashboard below retrieves its current numbers from a separate service.</p><section><span>0%</span><div>Updating in {time}</div><div>Data from {day}, {time}</div></section></main><script src="/widget.js"></script>',
    }),
  });
  let renders = 0;
  const [page] = await extractPublicSources(
    web,
    ["https://news.example/live"],
    undefined,
    async (url) => {
      renders++;
      return {
        url,
        title: "Live results",
        text: "Candidate A: 52%, 12345 votes",
        truncated: false,
      };
    },
  );
  assert.equal(renders, 1);
  assert.match(page.text, /12345 votes/);
  assert.doesNotMatch(page.text, /\{time\}/);
});

test("documented code templates do not force a page through the renderer", async () => {
  const web = new PublicWeb({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: '<title>Template guide</title><main><p>Use these two fields in the template. They are literal examples for developers reading this documentation, not an interactive dashboard waiting for application data to arrive from a service:</p><pre>{day}</pre><code>{time}</code></main><script src="/site.js"></script>',
    }),
  });
  const [page] = await extractPublicSources(
    web,
    ["https://docs.example/guide"],
    undefined,
    async () => {
      throw new Error("Code examples are not a pending widget");
    },
  );
  assert.equal(page.extraction?.status, "readable");
  assert.match(page.text, /\{day\}/);
});
