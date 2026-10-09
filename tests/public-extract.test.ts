import assert from "node:assert/strict";
import test from "node:test";
import { extractPublicSources } from "../apps/server/src/public-extract.ts";
import { PublicWeb } from "../apps/server/src/public-web.ts";

test("a readable article with an empty marketing journey card does not wait for the browser", async () => {
  const web = new PublicWeb({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: '<title>Artificial intelligence</title><main><article><h1>Artificial intelligence</h1><p>Artificial intelligence lets computers perform tasks such as recognizing patterns, learning from data and generating new content. Machine learning is a subset of artificial intelligence.</p><div class="ajo-journey-card" data-cmp-is="AjoJourneyCard" aria-busy="true"></div></article></main><script src="/marketing.js"></script>',
    }),
  });
  let renders = 0;
  const [page] = await extractPublicSources(
    web,
    ["https://article.example/ai"],
    undefined,
    async () => {
      renders++;
      throw new Error("A marketing card is not missing article data");
    },
  );
  assert.equal(renders, 0);
  assert.equal(page.extraction?.status, "readable");
  assert.match(page.text, /Machine learning is a subset/);
});

test("an actual busy results region still requires rendering despite surrounding article text", async () => {
  const web = new PublicWeb({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: '<title>Results</title><main><p>This article describes the election and the schedule of the count. Current results are shown in the region below after the data service returns the latest published votes.</p><section aria-label="Current results" aria-busy="true"></section></main><script src="/results.js"></script>',
    }),
  });
  let renders = 0;
  const [page] = await extractPublicSources(
    web,
    ["https://article.example/results"],
    undefined,
    async (url) => {
      renders++;
      return { url, title: "Results", text: "Candidate A: 12345 votes", truncated: false };
    },
  );
  assert.equal(renders, 1);
  assert.match(page.text, /12345 votes/);
});

test("independent HTTP sources start together and retain requested order", async () => {
  const started: string[] = [];
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const web = new PublicWeb({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async (target) => {
      started.push(target.url.pathname);
      if (started.length === 3) release();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Sources did not start concurrently")),
          1000,
        );
        ready.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      return {
        status: 200,
        headers: { "content-type": "text/html" },
        body: `<title>Source</title><main>Verified data for ${target.url.pathname}</main>`,
      };
    },
  });
  const pages = await extractPublicSources(
    web,
    ["https://sources.example/one", "https://sources.example/two", "https://sources.example/three"],
    AbortSignal.timeout(2000),
  );
  assert.deepEqual(started, ["/one", "/two", "/three"]);
  assert.deepEqual(
    pages.map((page) => new URL(page.url).pathname),
    started,
  );
  assert.ok(pages.every((page) => !page.error));
});

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
