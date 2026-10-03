import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBrowserManager } from "../src/browser.ts";
import { publicFixture } from "./public-fixture.ts";

test("real browser index extraction bounds snippets, drops private links and labels index provenance", async () => {
  const fixture = await publicFixture();
  const dataDir = await mkdtemp(join(tmpdir(), "okami-search-"));
  const browser = await createBrowserManager({
    dataDir,
    searchEndpoint: "https://browser.fixture.test/search",
  });
  const id = randomUUID();
  try {
    await browser.create(id, "https://browser.fixture.test/");
    const before = fixture.requests.length;
    const result = await browser.search(id, { query: "documents with spaces", limit: 2 });
    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.sources.map((s) => s.title),
      ["One", "Two"],
    );
    assert.equal(result.sources[0].date, "2026-10-03");
    assert.equal(result.sources[1].snippet.length, 1000);
    assert.equal(result.truncated, true);
    assert.equal(result.provenance.fullPagesRead, false);
    assert.equal(result.provenance.sessionId, id);
    assert.ok(
      fixture.requests
        .slice(before)
        .every((request) => request.path.startsWith("/search") || request.path === "/favicon.ico"),
    );
    assert.equal((await browser.search(id, { query: "empty", limit: 3 })).status, "no_results");
    await assert.rejects(browser.search(id, { query: "unavailable", limit: 3 }), {
      code: "SEARCH_UNAVAILABLE",
    });
    await assert.rejects(browser.search(id, { query: "x", limit: 11 }));
    await browser.setControl(id, "human");
    await assert.rejects(browser.search(id, { query: "blocked", limit: 1 }), {
      code: "BROWSER_CONTROLLED",
    });
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
    await fixture.close();
  }
});
