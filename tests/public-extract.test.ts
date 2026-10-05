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
