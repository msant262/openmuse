import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  nativeWebMarkdown,
  stopOpenclawHarness,
} from "../apps/server/src/engine/openclaw-agent.ts";
import { PublicWeb } from "../apps/server/src/public-web.ts";

const directory = await mkdtemp(join(tmpdir(), "okami-content-source-"));
after(async () => {
  await stopOpenclawHarness(directory);
  await rm(directory, { recursive: true, force: true });
});

function reader(body: string) {
  return new PublicWeb({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async () => ({ status: 200, headers: { "content-type": "text/html" }, body }),
    renderHtml: (html) => nativeWebMarkdown(html, directory),
  });
}

test("a repository article reaches the excerpt before its navigation and file listing", async () => {
  const page = await reader(
    `<title>Generative AI lessons</title><main><nav>${'<a href="/files">Repository file listing</a>'.repeat(100)}</nav><article><h1>Generative AI lessons</h1><p>21 lessons. Translations include Brazilian Portuguese.</p><p><a href="translations/pt-br">Read the Portuguese lessons</a></p><p>Examples can require a paid API; local alternatives are available.</p></article><aside>Repository statistics</aside></main>`,
  ).read("https://repository.example/course", undefined, { mode: "http", maxChars: 1000 });
  assert.match(page.text, /^# Generative AI lessons/);
  assert.match(page.text, /21 lessons\. Translations include Brazilian Portuguese/);
  assert.match(
    page.text,
    /\[Read the Portuguese lessons\]\(https:\/\/repository\.example\/translations\/pt-br\)/,
  );
  assert.doesNotMatch(page.text, /Repository file listing/);
  assert.deepEqual(page.links, [
    { title: "Read the Portuguese lessons", url: "https://repository.example/translations/pt-br" },
  ]);
  assert.equal(page.truncated, false);
  assert.equal(page.extraction?.status, "readable");
});

test("hidden articles cannot displace the visible source", async () => {
  for (const attribute of ["hidden", 'aria-hidden="true"', 'style="display:none"']) {
    const page = await reader(
      `<title>Course catalogue</title><div ${attribute}><article><h1>Hidden page</h1><p>HIDDEN-SOURCE</p></article></div><main><article><h1>Visible course</h1><p>Free lessons with a paid certificate.</p></article></main>`,
    ).read("https://courses.example/course", undefined, { mode: "http" });
    assert.match(page.text, /Visible course/);
    assert.match(page.text, /Free lessons with a paid certificate/);
    assert.doesNotMatch(page.text, /HIDDEN-SOURCE/);
  }
});

test("a main landmark retains all catalogue articles and their links", async () => {
  const page = await reader(
    '<title>Catalogue</title><header>GLOBAL-NAVIGATION</header><div role="main"><h1>Two courses</h1><article><h2>First course</h2><p>Free content, certificate costs €20.</p><a href="/first">First source</a></article><article><h2>Second course</h2><p>Free content and certificate.</p><a href="/second">Second source</a></article></div><footer>GLOBAL-FOOTER</footer>',
  ).read("https://courses.example/catalogue", undefined, { mode: "http" });
  assert.match(page.text, /Two courses/);
  assert.match(page.text, /First course/);
  assert.match(page.text, /certificate costs €20/);
  assert.match(page.text, /Second course/);
  assert.match(page.text, /Free content and certificate/);
  assert.doesNotMatch(page.text, /GLOBAL-NAVIGATION|GLOBAL-FOOTER/);
  assert.equal(page.links.length, 2);
});

test("prioritizing an article retains requested facts and live regions outside it", async () => {
  const page = await reader(
    '<title>Course</title><main><p>Duration: 45 minutes.</p><article><h1>Course contents</h1><p>Introduction to generative AI.</p></article><aside>Optional certificate: €20.</aside><section aria-busy="true">Available sessions are loading.</section><script src="/sessions.js"></script></main>',
  ).read("https://courses.example/course", undefined, { mode: "http" });
  assert.match(page.text, /^# Course contents/);
  assert.match(page.text, /Duration: 45 minutes/);
  assert.match(page.text, /Optional certificate: €20/);
  assert.equal(page.extraction?.status, "partial");
});

test("pages without article or main markup preserve the ordinary document body", async () => {
  const page = await reader(
    '<title>Course policy</title><body><h1>Course policy</h1><p>All lessons are free.</p><p><a href="/certificate">Optional certificate costs €20.</a></p></body>',
  ).read("https://courses.example/policy", undefined, { mode: "http" });
  assert.match(page.text, /All lessons are free/);
  assert.match(page.text, /Optional certificate costs €20/);
  assert.equal(page.links[0].url, "https://courses.example/certificate");
});
