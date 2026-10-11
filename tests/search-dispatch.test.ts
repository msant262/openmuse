import assert from "node:assert/strict";
import test from "node:test";
import type { SearchContext } from "../apps/server/src/search.ts";
import type { SearchInput, SearchResult } from "../packages/domain/src/search.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

for (const dispatch of ["direct", "execute_code"] as const)
  test(`actual copied task executor preserves mixed search arguments through ${dispatch} and canonical evidence`, async (t) => {
    const args = {
      query: "IBM SkillsBuild",
      queries: [" Google Skills ", "Microsoft Learn", "IBM SkillsBuild"],
      limit: 5,
    };
    const fixture = await modelFixture(t, (index) =>
      index === 0
        ? dispatch === "direct"
          ? { name: "search_web", arguments: args }
          : {
              name: "execute_code",
              arguments: { code: `return await search_web(${JSON.stringify(args)});` },
            }
        : index === 1
          ? {
              name: "finish_task",
              arguments: {
                summary: "Found primary source leads. These are index results, not read pages.",
              },
            }
          : undefined,
    );
    const f = await taskRuntime(t, {
      agentBackend: "model",
      model: "openai/fixture",
      researchReviewEnabled: false,
    });
    const dispatched: string[] = [];
    t.mock.method(f.agent.search, "search", async (input: SearchInput, context: SearchContext) => {
      assert.equal(input.limit, 5);
      assert.equal(context.owner, "owner");
      assert.ok(context.taskId);
      dispatched.push(input.query);
      return {
        query: input.query,
        status: "ok",
        sources: [
          {
            title: input.query,
            url: `https://example.org/${encodeURIComponent(input.query)}`,
            snippet: "Unverified index lead",
          },
        ],
        observedAt: new Date().toISOString(),
        truncated: false,
        provenance: {
          backend: "http",
          provider: "bing-rss",
          searchUrl: `https://www.bing.com/search?q=${encodeURIComponent(input.query)}`,
          fullPagesRead: false,
        },
      } satisfies SearchResult;
    });
    const task = await f.agent.createTask("owner", {
      prompt: "Find primary source links for IBM, Google and Microsoft generative AI courses.",
    });
    await f.agent.worker.tick();
    assert.deepEqual(dispatched, ["IBM SkillsBuild", "Google Skills", "Microsoft Learn"]);
    const operations = await f.agent.journal.operations("owner", task.id);
    const search = operations.filter((op) => op.toolName === "search_web");
    assert.equal(search.length, 1, "one host call has one canonical parent operation");
    assert.equal(search[0].status, "succeeded");
    const receipt = search[0].receipt as { searches: SearchResult[] };
    assert.deepEqual(
      receipt.searches.map((r) => r.query),
      dispatched,
    );
    const saved = await f.agent.getTask("owner", task.id);
    assert.deepEqual(
      saved.evidence.filter((e) => e.title.startsWith("Search index:")).map((e) => e.title),
      dispatched.map((query) => `Search index: ${query}`),
    );
    assert.ok(
      fixture.requests.some(
        (r) =>
          r.body.includes("Google Skills") &&
          r.body.includes("Microsoft Learn") &&
          r.body.includes("fullPagesRead"),
      ),
      "all index receipts reach the actual next provider turn",
    );
  });
