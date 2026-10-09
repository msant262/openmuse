import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { observePublicDataRequests, readPublicContent } from "../apps/worker/src/public-read.ts";

test("public reading ignores a hung TrustArc analytics collector while observing actual data", {
  timeout: 10_000,
}, async (t) => {
  const workerRequire = createRequire(resolve("apps/worker/package.json"));
  const { chromium }: typeof import("../apps/worker/node_modules/playwright/index.js") =
    workerRequire("playwright");
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const network = observePublicDataRequests(page);
  await page.setContent(
    "<main><h1>Complete course</h1><p>The complete curriculum is free.</p></main>",
  );
  let release!: () => Promise<void>;
  let intercepted!: () => void;
  const pending = new Promise<void>((resolve) => {
    intercepted = resolve;
  });
  await page.route("https://consent.trustarc.com/analytics*", async (route) => {
    release = () => route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
    intercepted();
  });
  await page.evaluate(() => {
    void fetch("https://consent.trustarc.com/analytics?event=shown").catch(() => {});
  });
  await pending;
  assert.equal(
    network.snapshot().pending,
    false,
    "a collection request is not missing article data",
  );
  const result = await readPublicContent(page, network);
  assert.equal(result.extraction.status, "readable");
  await release();
  let realRelease!: () => Promise<void>;
  let realIntercepted!: () => void;
  const realPending = new Promise<void>((resolve) => {
    realIntercepted = resolve;
  });
  await page.route("https://course.example/analytics", async (route) => {
    realRelease = () =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: '{"available":3}',
      });
    realIntercepted();
  });
  await page.evaluate(() => {
    void fetch("https://course.example/analytics").catch(() => {});
  });
  await realPending;
  assert.equal(
    network.snapshot().pending,
    true,
    "unrecognized business data must not be discarded by a generic analytics keyword",
  );
  await realRelease();
  const after = await readPublicContent(page, network);
  assert.equal(after.extraction.status, "readable");
  assert.ok(after.dataSources.some((source) => source.url === "https://course.example/analytics"));
});

test("a static logo placeholder does not hold a fully loaded course article for a minute", {
  timeout: 10_000,
}, async (t) => {
  const workerRequire = createRequire(resolve("apps/worker/package.json"));
  const { chromium }: typeof import("../apps/worker/node_modules/playwright/index.js") =
    workerRequire("playwright");
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    '<main><h1>Free Generative AI Course</h1><p>Full course access is free for 90 days. Duration: 4 hours.</p><span class="skillup-meta__logo-placeholder">Included with</span></main>',
  );
  const read = readPublicContent(page);
  void read.catch(() => {});
  const result = await Promise.race([
    read,
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () =>
          reject(new Error("Static decorative placeholder incorrectly blocked article reading")),
        2000,
      ),
    ),
  ]);
  assert.equal(result.extraction.status, "readable");
  assert.match(result.text, /Duration: 4 hours/);
});

test("the actual DOM reader returns a completed article with a styled country select immediately", {
  timeout: 10_000,
}, async (t) => {
  const workerRequire = createRequire(resolve("apps/worker/package.json"));
  const { chromium }: typeof import("../apps/worker/node_modules/playwright/index.js") =
    workerRequire("playwright");
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    '<main><h1>Generative AI course</h1><p>The full course is free to study.</p><form><select class="hs-input is-placeholder"><option>Please Select</option><option>Brazil</option></select></form></main>',
  );
  const read = readPublicContent(page);
  void read.catch(() => {});
  const result = await Promise.race([
    read,
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error("Completed article incorrectly waited for a country selection")),
        2000,
      ),
    ),
  ]);
  assert.equal(result.extraction.status, "readable");
  assert.match(result.text, /full course is free/);
});

test("an explicitly busy select remains pending until its real options arrive", {
  timeout: 10_000,
}, async (t) => {
  const workerRequire = createRequire(resolve("apps/worker/package.json"));
  const { chromium }: typeof import("../apps/worker/node_modules/playwright/index.js") =
    workerRequire("playwright");
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    '<main><p>Available courses</p><select class="is-placeholder" aria-busy="true"><option>Loading</option></select></main>',
  );
  await page.evaluate(() =>
    setTimeout(() => {
      const select = document.querySelector("select")!;
      select.innerHTML = "<option>Verified available course</option>";
      select.removeAttribute("aria-busy");
    }, 400),
  );
  const result = await readPublicContent(page);
  assert.equal(result.extraction.status, "readable");
  assert.match(result.text, /Verified available course/);
  assert.doesNotMatch(result.text, /Loading/);
});

for (const readyAt of [0, 58_000, Number.POSITIVE_INFINITY]) {
  test(`public reading gives pending data a full minute and returns early at ${readyAt}ms`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    const page = {
      evaluate: async () => ({
        url: "https://example.com/",
        title: "Live results",
        text: Date.now() >= readyAt ? "Votes: 12345" : "Loading results",
        pending: Date.now() < readyAt,
        sourceLength: 20,
        structured: [],
        links: [],
      }),
    } as unknown as Parameters<typeof readPublicContent>[0];
    let finishedAt: number | undefined;
    const reading = readPublicContent(page).then((result) => {
      finishedAt = Date.now();
      return result;
    });
    for (let elapsed = 0; elapsed <= 60_200 && finishedAt === undefined; elapsed += 200) {
      // Flush promises between timer ticks, as the real event loop does.
      for (let turn = 0; turn < 5; turn++) await Promise.resolve();
      if (finishedAt === undefined) t.mock.timers.tick(200);
    }
    const result = await reading;
    if (Number.isFinite(readyAt)) {
      assert.match(result.text, /12345/);
      assert.equal(result.extraction.status, "readable");
      assert.equal(finishedAt, readyAt);
    } else {
      assert.equal(result.extraction.status, "partial");
      assert.equal(finishedAt, 60_000);
    }
  });
}
