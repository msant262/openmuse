import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  nativeWebMarkdown,
  stopOpenclawHarness,
} from "../apps/server/src/engine/openclaw-agent.ts";
import { extractPublicSources } from "../apps/server/src/public-extract.ts";
import { PublicWeb } from "../apps/server/src/public-web.ts";

const directory = await mkdtemp(join(tmpdir(), "okami-question-source-"));
after(async () => {
  await stopOpenclawHarness(directory);
  await rm(directory, { recursive: true, force: true });
});

const url = "https://courses.example/introduction";
const missingHtml = `<title>Introduction</title><main>
<h1>Introduction to AI</h1><p>Enroll for free. Introductory course.</p>
<h2>Frequently asked questions</h2>
<h3>Can I preview this course?</h3><h3>Why can't I audit this course?</h3>
<p>Show all 6 frequently asked questions</p>
<h2>More questions</h2><p>Visit the help center.</p></main>`;
const fullText =
  "# Introduction to AI\n\n## Frequently asked questions\n\n### Can I preview this course?\n\nOnly the first lesson is available for preview.\n\n### Why can't I audit this course?\n\nFull access requires payment or financial aid.";
const dependencies = (html = missingHtml) => ({
  resolve: async () => [{ address: "93.184.216.34", family: 4 as const }],
  request: async () => ({ status: 200, headers: { "content-type": "text/html" }, body: html }),
  renderHtml: (source: string) => nativeWebMarkdown(source, directory),
});

test("HTTP mode preserves unanswered FAQ evidence as partial without dispatching another reader", async () => {
  const page = await new PublicWeb(dependencies()).read(url, undefined, {
    mode: "http",
    extract: async () => {
      throw new Error("HTTP mode must not call the provider");
    },
    render: async () => {
      throw new Error("HTTP mode must not open a browser");
    },
  });
  assert.match(page.text, /Enroll for free/);
  assert.match(page.text, /Why can't I audit this course\?/);
  assert.equal(page.extraction.status, "partial");
  assert.match(page.extraction.reason ?? "", /answer/i);
});

test("auto reading recovers FAQ answers through the configured extractor before accepting pricing claims", async () => {
  const page = await new PublicWeb(dependencies()).read(url, undefined, {
    extract: async (target) => {
      assert.equal(target, url);
      return { url: target, title: "Introduction", text: fullText, truncated: false };
    },
    render: async () => {
      throw new Error("Recovered provider answers require no browser");
    },
  });
  assert.equal(page.url, url);
  assert.match(page.text, /Full access requires payment or financial aid/);
  assert.equal(page.extraction.status, "readable");
});

test("batch extraction rescues missing FAQ answers even when the incomplete representation was cached in full", async () => {
  const html = missingHtml.replace("Introductory course.", "Introductory course. ".repeat(250));
  let preserved = "";
  const [page] = await extractPublicSources(
    new PublicWeb(dependencies(html)),
    [url],
    undefined,
    async (target) => ({ url: target, title: "Introduction", text: fullText, truncated: false }),
    {
      maxChars: 500,
      spill: async (source) => {
        preserved = source.text;
        return {
          fileId: "source-cache",
          chars: source.text.length,
          size: source.text.length,
          sha256: "fixture",
          truncated: false,
        };
      },
    },
  );
  assert.equal(page.url, url);
  assert.match(page.text, /Full access requires payment or financial aid/);
  assert.equal(page.provenance?.backend, "browser");
  assert.equal(page.extraction?.status, "readable");
  assert.ok(preserved.length > 500);
});

test("failed FAQ recovery keeps actual partial source text instead of certifying it as complete", async () => {
  const [page] = await extractPublicSources(
    new PublicWeb(dependencies()),
    [url],
    undefined,
    async () => {
      throw new Error("Renderer unavailable");
    },
  );
  assert.equal(page.url, url);
  assert.match(page.text, /Enroll for free/);
  assert.match(page.text, /Why can't I audit this course\?/);
  assert.equal(page.extraction?.status, "partial");
  assert.match(page.error ?? "", /Renderer unavailable/);
});

test("a complete HTTP FAQ remains a single read and retains its observed access restriction", async () => {
  const html = missingHtml.replace(
    "<h3>Why can't I audit this course?</h3>",
    "<p>Only the first lesson is available for preview.</p><h3>Why can't I audit this course?</h3><p>Full access requires payment or financial aid.</p>",
  );
  const page = await new PublicWeb(dependencies(html)).read(url, undefined, {
    extract: async () => {
      throw new Error("Complete FAQ must not need extraction rescue");
    },
    render: async () => {
      throw new Error("Complete FAQ must not need a browser");
    },
  });
  assert.match(page.text, /Full access requires payment or financial aid/);
  assert.equal(page.extraction.status, "readable");
});
