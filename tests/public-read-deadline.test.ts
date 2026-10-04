import assert from "node:assert/strict";
import test from "node:test";
import { readPublicContent } from "../apps/worker/src/public-read.ts";

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
