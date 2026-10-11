import assert from "node:assert/strict";
import test from "node:test";
import { PublicWeb } from "../apps/server/src/public-web.ts";
import {
  HttpSearchBackend,
  type SearchBackend,
  type SearchContext,
} from "../apps/server/src/search.ts";
import { searchTools } from "../apps/server/src/search-tools.ts";
import {
  type SearchResult,
  searchInputSchema,
  searchResultSchema,
} from "../packages/domain/src/search.ts";

function execute(tool: ReturnType<typeof searchTools>[number], raw: unknown) {
  assert.ok(tool.execute);
  return tool.execute(tool.parameters.parse(raw));
}

function result(query: string, status: SearchResult["status"] = "ok"): SearchResult {
  return {
    query,
    status,
    sources:
      status === "ok"
        ? [{ title: query, url: `https://example.org/${query}`, snippet: "Unverified index lead" }]
        : [],
    observedAt: new Date().toISOString(),
    truncated: false,
    provenance: {
      backend: "http",
      provider: "bing-rss",
      searchUrl: `https://www.bing.com/search?q=${query}`,
      fullPagesRead: false,
    },
    ...(status === "error" ? { code: "SEARCH_UNAVAILABLE" } : {}),
  };
}

test("independent HTTP queries overlap but evidence callbacks retain requested order and owner", async () => {
  let resolve!: () => void;
  const barrier = new Promise<void>((r) => {
    resolve = r;
  });
  const dispatched: string[] = [],
    saved: string[] = [],
    contexts: SearchContext[] = [];
  const backend = {
    parallelSearches: true,
    async search(input: { query: string; limit: number }, context: SearchContext) {
      dispatched.push(input.query);
      contexts.push(context);
      if (dispatched.length === 3) resolve();
      await barrier;
      return result(input.query);
    },
  };
  const tool = searchTools(backend, "owner", {
    taskId: "task",
    result: async (r) => {
      saved.push(r.query);
    },
  })[0];
  const args = tool.parameters.parse({ queries: ["alpha", "beta", "gamma"], limit: 5 });
  const receipt = (await execute(tool, args)) as {
    status: string;
    searches: SearchResult[];
    sources: SearchResult["sources"];
  };
  assert.equal(receipt.status, "ok");
  assert.deepEqual(dispatched, ["alpha", "beta", "gamma"]);
  assert.deepEqual(saved, dispatched);
  assert.deepEqual(
    receipt.searches.map((r) => r.query),
    dispatched,
  );
  assert.equal(receipt.sources.length, 3);
  assert.ok(receipt.searches.every((r) => r.provenance.fullPagesRead === false));
  assert.ok(contexts.every((c) => c.owner === "owner" && c.taskId === "task"));
});

test("partial batch keeps each failed query distinct from genuine absence and retains successful leads", async () => {
  const backend: SearchBackend = {
    search: async ({ query }) =>
      result(query, query === "blocked" ? "error" : query === "empty" ? "no_results" : "ok"),
  };
  const tool = searchTools(backend, "owner")[0];
  const receipt = (await execute(tool, { queries: ["good", "blocked", "empty"] })) as {
    status: string;
    searches: SearchResult[];
    sources: SearchResult["sources"];
  };
  assert.equal(receipt.status, "partial");
  assert.deepEqual(
    receipt.searches.map((r) => r.status),
    ["ok", "error", "no_results"],
  );
  assert.equal(receipt.searches[1].code, "SEARCH_UNAVAILABLE");
  assert.deepEqual(
    receipt.sources.map((s) => s.title),
    ["good"],
  );
});

test("profile-backed batches remain serial and stopped tasks dispatch no searches", async () => {
  let active = 0,
    max = 0,
    calls = 0;
  const backend: SearchBackend = {
    async search({ query }) {
      calls++;
      active++;
      max = Math.max(max, active);
      await Promise.resolve();
      active--;
      return result(query);
    },
  };
  const tool = searchTools(backend, "owner")[0];
  await execute(tool, { queries: ["alpha", "beta"] });
  assert.equal(max, 1);
  const stopped = searchTools(backend, "owner", { stopped: () => true })[0];
  const receipt = (await execute(stopped, { queries: ["gamma", "delta"] })) as {
    status: string;
    dispatched: boolean;
  };
  assert.equal(receipt.status, "cancelled");
  assert.equal(receipt.dispatched, false);
  assert.equal(calls, 2);
});

test("single-query result stays identical and invalid mixed input cannot dispatch", async () => {
  const expected = result("alpha");
  let calls = 0;
  const tool = searchTools(
    {
      search: async () => {
        calls++;
        return expected;
      },
    },
    "owner",
  )[0];
  assert.deepEqual(await execute(tool, { query: "alpha" }), expected);
  assert.throws(() => tool.parameters.parse({ query: "alpha", queries: ["beta"] }));
  assert.throws(() => tool.parameters.parse({ queries: [] }));
  assert.throws(() => tool.parameters.parse({}));
  assert.equal(calls, 1);
});

test("search can return seventy actual safe RSS leads with accurate truncation instead of the old ten/fifty caps", async () => {
  const web = new PublicWeb();
  web.document = async (url) => ({
    url,
    contentType: "text/xml",
    body: `<rss><channel>${Array.from({ length: 75 }, (_, i) => `<item><title>Course ${i}</title><link>https://example.org/course/${i}</link><description>Course index ${i}</description></item>`).join("")}</channel></rss>`,
  });
  web.validate = async (url) => ({ url: new URL(url), address: "93.184.216.34", family: 4 });
  const backend = new HttpSearchBackend(web);
  const input = searchInputSchema.parse({ query: "course", limit: 70 });
  const receipt = searchResultSchema.parse(await backend.search(input, { owner: "owner" }));
  assert.equal(receipt.sources.length, 70);
  assert.equal(receipt.truncated, true);
  assert.equal(receipt.sources.at(-1)?.url, "https://example.org/course/69");
  assert.equal(receipt.provenance.fullPagesRead, false);
});
