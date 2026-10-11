import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { EventType } from "@ag-ui/core";
import { defineTool } from "@copilotkit/runtime/v2";
import type { ModelMessage } from "@tanstack/ai";
import { lastValueFrom, toArray } from "rxjs";
import { z } from "zod";
import { openclawAgent } from "../apps/server/src/engine/openclaw-agent.ts";
import { recoverResearchToolResult } from "../apps/server/src/engine/research-source-recovery.ts";
import { ToolOutputStore } from "../apps/server/src/engine/tool-output.ts";
import { preservePublicSource } from "../apps/server/src/public-web.ts";
import { modelFixture, richChatFixtureProviders } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("batch search context indexes repeated results without losing query evidence or alternate snippets", async (t) => {
  const f = await taskRuntime(t);
  const shared = {
    url: "https://academy.example/course",
    title: "Introductory course",
    snippet: "Observed search lead. ".repeat(40),
  };
  const alternate = { ...shared, snippet: "A different query matched this separate excerpt." };
  const other = {
    url: "https://academy.example/faq",
    title: "Course FAQ",
    snippet: "Certificate policy search lead. ".repeat(30),
  };
  const provenance = { backend: "http", fullPagesRead: false, observedAt: "2026-10-11T21:00:00Z" };
  const receipt = {
    status: "partial",
    queries: ["course language", "certificate cost", "duration"],
    sources: [shared, other],
    searches: [
      { status: "ok", query: "course language", sources: [shared, other], provenance },
      { status: "ok", query: "certificate cost", sources: [other, alternate], provenance },
      {
        status: "unavailable",
        query: "duration",
        sources: [],
        error: "Search provider unavailable",
        code: "SEARCH_UNAVAILABLE",
        provenance,
      },
    ],
    truncated: false,
    fullPagesRead: false,
  };
  const original = structuredClone(receipt);
  const view = (await recoverResearchToolResult(
    f.files,
    "owner",
    "search_web",
    receipt,
    1048576,
  )) as {
    sources: (typeof shared)[];
    searches: Array<Record<string, unknown> & { sourceIndices: number[] }>;
    _contextProjection: { kind: string };
  };
  assert.equal(view._contextProjection?.kind, "indexed_search_sources");
  assert.equal(view.sources.length, 3, "different snippets at one URL remain distinct evidence");
  const reconstructed = view.searches.map(({ sourceIndices, ...search }) => ({
    ...search,
    sources: sourceIndices.map((index) => view.sources[index]),
  }));
  assert.deepEqual(reconstructed, receipt.searches);
  assert.deepEqual(view.sources.slice(0, receipt.sources.length), receipt.sources);
  assert.equal((view as Record<string, unknown>).fullPagesRead, false);
  assert.equal((view as Record<string, unknown>).status, "partial");
  assert.deepEqual(receipt, original, "UI, canonical receipts and source evidence remain exact");
  assert.ok(JSON.stringify(view).length < JSON.stringify(receipt).length * 0.85);
  assert.deepEqual(
    await recoverResearchToolResult(f.files, "owner", "web_extract", receipt, 1048576),
    receipt,
    "the shape alone never changes another tool's result",
  );
});

test("the copied executor sends batch search evidence once while preserving full canonical output", async (t) => {
  const f = await taskRuntime(t);
  const sources = Array.from({ length: 8 }, (_, i) => ({
    url: `https://academy.example/course-${i}`,
    title: `Course ${i}`,
    snippet: `Search lead ${i}. ${"Observed syllabus snippet. ".repeat(32)}`,
  }));
  const receipt = {
    status: "ok",
    queries: ["introductory courses", "free certificates"],
    sources,
    searches: [
      {
        status: "ok",
        query: "introductory courses",
        sources,
        provenance: { fullPagesRead: false },
      },
      {
        status: "ok",
        query: "free certificates",
        sources: [...sources].reverse(),
        provenance: { fullPagesRead: false },
      },
    ],
    fullPagesRead: false,
    truncated: false,
  };
  const original = structuredClone(receipt);
  const fixture = await modelFixture(t, (index) =>
    index === 0 ? { name: "search_web", arguments: { query: "introductory courses" } } : undefined,
  );
  let canonical: ModelMessage[] = [];
  const agent = openclawAgent({
    dataDir: f.directory,
    model: "openai/fixture",
    providers: richChatFixtureProviders(f.directory),
    toolSearch: false,
    prompt: "Research introductory courses with the available search and reading tools.",
    tools: [
      defineTool({
        name: "search_web",
        description: "Search public course sources",
        parameters: z.object({ query: z.string() }),
        execute: async () => receipt,
      }),
    ],
    projectToolResult: (name, result, tokens) =>
      recoverResearchToolResult(f.files, "owner", name, result, tokens),
    onMessages: async (messages) => {
      canonical = messages;
    },
  });
  const events = await lastValueFrom(
    agent
      .run({
        threadId: randomUUID(),
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: "user", content: "Find introductory courses." }],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  assert.ok(!events.some((event) => event.type === EventType.RUN_ERROR), JSON.stringify(events));
  assert.equal(fixture.requests.length, 2);
  const next = JSON.parse(fixture.requests[1].body).input.find(
    (item: { type: string }) => item.type === "function_call_output",
  );
  const view = JSON.parse(next.output);
  assert.equal(view._contextProjection?.kind, "indexed_search_sources");
  assert.deepEqual(view.sources, sources);
  assert.deepEqual(view.searches[1].sourceIndices, [7, 6, 5, 4, 3, 2, 1, 0]);
  assert.ok(next.output.length < JSON.stringify(receipt).length * 0.5);
  assert.equal(view.fullPagesRead, false, "search snippets never become page-read evidence");
  assert.deepEqual(JSON.parse(String(canonical.find((m) => m.role === "tool")?.content)), original);
  const resultEvent = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.deepEqual(JSON.parse(String(resultEvent?.content)), original);
  assert.deepEqual(receipt, original);
});

for (const [contextTokens, paragraphs] of [
  [131072, 1300],
  [1048576, 10000],
]) {
  test(`the executor reads verified cached course conditions before drafting at ${contextTokens} tokens`, async (t) => {
    const f = await taskRuntime(t);
    const url = "https://academy.example/course";
    const full = `Course overview. ${"Public syllabus paragraph. ".repeat(paragraphs)}\nFAQ: lessons are free; the optional certificate costs 49 euros. Duration: 3 hours.`;
    const spill = await preservePublicSource(
      f.files,
      "owner",
    )({ url, text: full, mimeType: "text/plain" });
    const receipt = {
      url,
      text: full.slice(0, 6000),
      spill,
      truncated: true,
      sourceLength: full.length,
    };
    const original = structuredClone(receipt);
    let reads = 0;
    let canonical: ModelMessage[] = [];
    const fixture = await modelFixture(t, (index) =>
      index === 0 ? { name: "web_fetch", arguments: { url, maxChars: 6000 } } : undefined,
    );
    const providers = richChatFixtureProviders(f.directory);
    providers.routing!.capabilities["openai/fixture"].contextTokens = contextTokens;
    const agent = openclawAgent({
      dataDir: f.directory,
      model: "openai/fixture",
      providers,
      toolSearch: false,
      prompt: "Compare course conditions using the source you read.",
      tools: [
        defineTool({
          name: "web_fetch",
          description: "Read a public course page",
          parameters: z.object({ url: z.string(), maxChars: z.number() }),
          execute: async (args) => {
            assert.deepEqual(args, { url, maxChars: 6000 });
            reads++;
            return receipt;
          },
        }),
      ],
      projectToolResult: (toolName, result, tokens) =>
        recoverResearchToolResult(f.files, "owner", toolName, result, tokens),
      onMessages: async (messages) => {
        canonical = messages;
      },
    });
    const events = await lastValueFrom(
      agent
        .run({
          threadId: randomUUID(),
          runId: randomUUID(),
          messages: [
            {
              id: randomUUID(),
              role: "user",
              content: "Compare this course's access, certificate and duration.",
            },
          ],
          tools: [],
          context: [],
          state: {},
        })
        .pipe(toArray()),
    );
    assert.ok(!events.some((event) => event.type === EventType.RUN_ERROR), JSON.stringify(events));
    assert.equal(fixture.requests.length, 2);
    const next = JSON.parse(fixture.requests[1].body).input.find(
      (item: { type: string }) => item.type === "function_call_output",
    );
    const projected = JSON.parse(next.output);
    assert.ok(
      projected.text === full,
      "the next inference must already see the complete verified source, including middle and FAQ",
    );
    assert.equal(projected.truncated, false);
    assert.equal(projected.sourceRecovery.networkRead, false);
    assert.equal(reads, 1, "context recovery must not fetch the page again");
    assert.deepEqual(receipt, original);
    const canonicalTool = canonical.find((m) => m.role === "tool");
    const saved = JSON.parse(String(canonicalTool?.content));
    assert.equal(
      saved.text.length,
      6000,
      `canonical receipt ${canonicalTool?.toolCallId} must retain the requested excerpt`,
    );
    assert.deepEqual(saved, original);
    const event = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
    assert.ok(event);
    assert.deepEqual(
      JSON.parse(String(event.content)),
      original,
      "the UI receives the actual requested excerpt, not the reasoning projection",
    );
  });
}

test("a model with a million-token context receives a large tool observation without a fixed 64k ceiling", () => {
  const full = `Start. ${"Observed source paragraph. ".repeat(10000)} Middle and end must remain available.`;
  const messages: ModelMessage[] = [{ role: "tool", toolCallId: "large", content: full }];
  const outputs = new ToolOutputStore();
  outputs.observe(messages);
  assert.ok(outputs.live("large", 1048576) === full);
  assert.notEqual(
    outputs.live("large", 32768),
    full,
    "a smaller context still bounds oversized observations and supports read_tool_output",
  );
  assert.ok(
    outputs.read({ toolCallId: "large", offset: 0, limit: 1048576 }, 335544).content === full,
  );
});

test("an oversized recovered view falls back to the honest excerpt without changing canonical output", () => {
  const canonical = JSON.stringify({
    text: "Observed prefix.",
    truncated: true,
    spill: { fileId: "preserved-source" },
  });
  const recovered = JSON.stringify({
    text: `Observed prefix. ${"Complete cached text. ".repeat(1500)}`,
    truncated: false,
  });
  const outputs = new ToolOutputStore();
  const messages: ModelMessage[] = [{ role: "tool", toolCallId: "page", content: canonical }];
  outputs.observe(messages);
  assert.ok(outputs.live("page", 131072, recovered) === recovered);
  assert.equal(
    outputs.live("page", 10000, recovered),
    canonical,
    "cutting a recovered source must not falsely report a complete page",
  );
  assert.equal(outputs.restore([{ ...messages[0], content: recovered }])[0].content, canonical);
  assert.equal(outputs.read({ toolCallId: "page", offset: 0, limit: 10000 }).content, canonical);
});

test("a multilingual recovered page must fit the native weighted budget before claiming completeness", () => {
  const canonical = JSON.stringify({ text: "Observed prefix.", truncated: true });
  const recovered = JSON.stringify({
    text: `Observed prefix. ${"㐁".repeat(5000)}`,
    truncated: false,
  });
  const outputs = new ToolOutputStore();
  outputs.observe([{ role: "tool", toolCallId: "multilingual", content: canonical }]);
  assert.equal(
    outputs.live("multilingual", 131072, recovered),
    canonical,
    "rare CJK text costs more than its UTF-16 length; native guards must not cut the JSON",
  );
});
