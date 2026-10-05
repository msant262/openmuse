import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventType } from "@ag-ui/core";
import { defineTool } from "@copilotkit/runtime/v2";
import { lastValueFrom, toArray } from "rxjs";
import { z } from "zod";
import { openclawAgent } from "../apps/server/src/engine/openclaw-agent.ts";
import { completedMessages } from "../apps/server/src/engine/task-history.ts";
import { modelFixture, richChatFixtureProviders } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("ordinary chat follow-ups retain the original native session entries", async (t) => {
  await modelFixture(t, () => undefined, { text: () => "Recorded answer." });
  const f = await taskRuntime(t);
  const threadId = randomUUID();
  const agent = openclawAgent({
    dataDir: f.directory,
    compaction: { db: f.db, owner: "owner", scope: threadId },
    model: "openai/fixture",
    providers: richChatFixtureProviders(f.directory),
    prompt: "Answer directly.",
    tools: [],
  });
  const first = { id: randomUUID(), role: "user" as const, content: "First request." };
  const run = async (messages: Parameters<typeof agent.run>[0]["messages"]) => {
    const events = await lastValueFrom(
      agent
        .run({ threadId, runId: randomUUID(), messages, tools: [], context: [], state: {} })
        .pipe(toArray()),
    );
    assert.ok(!events.some((event) => event.type === EventType.RUN_ERROR));
    return (
      await f.db.list<{ id: string; entries: { id: string; type: string }[] }>(
        "owner",
        "harness-sessions",
      )
    )[0];
  };
  const before = await run([first]);
  assert.ok(before.entries.length >= 2);
  const after = await run([
    first,
    { id: randomUUID(), role: "assistant", content: "Recorded answer." },
    { id: randomUUID(), role: "user", content: "Follow-up request." },
  ]);
  const ids = new Set(after.entries.map((entry) => entry.id));
  assert.ok(
    before.entries.some((entry) => entry.type === "session"),
    "the original versioned header must accompany the session tree",
  );
  assert.ok(
    before.entries
      .filter(
        (entry) =>
          entry.type === "session" || entry.type === "message" || entry.type === "compaction",
      )
      .every((entry) => ids.has(entry.id)),
    "a follow-up must restore its native session tree rather than migrate all prior entries again",
  );
});

test("the copied OpenClaw executor continues beyond the former per-turn tool limit", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "okami-harness-test-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const fixture = await modelFixture(
    t,
    (index) =>
      index < 25
        ? {
            name: "tool_call",
            arguments: { id: "okami_lookup", input: { query: `source-${index}` } },
          }
        : undefined,
    { text: (index) => (index === 25 ? "Finished all 25 sources." : undefined) },
  );
  const dispatches: string[] = [];
  const checkpoints: number[] = [];
  const agent = openclawAgent({
    dataDir,
    model: "openai/fixture",
    providers: richChatFixtureProviders(dataDir),
    prompt: "Complete the accepted research using available tools.",
    tools: [
      defineTool({
        name: "lookup",
        description: "Read an independent source",
        parameters: z.object({ query: z.string() }),
        execute: async ({ query }) => {
          dispatches.push(query);
          return { source: query, verified: true };
        },
      }),
    ],
    onMessages: async (messages) => {
      checkpoints.push(messages.filter((message) => message.role === "tool").length);
    },
  });
  const events = await lastValueFrom(
    agent
      .run({
        threadId: randomUUID(),
        runId: randomUUID(),
        messages: [
          { id: randomUUID(), role: "user", content: "Research the question completely." },
        ],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  assert.deepEqual(
    events.filter((event) => event.type === EventType.RUN_ERROR),
    [],
  );
  assert.equal(dispatches.length, 25);
  assert.equal(fixture.requests.length, 26);
  assert.equal(checkpoints.at(-1), 25);
  assert.equal(events.filter((event) => event.type === EventType.TOOL_CALL_RESULT).length, 25);
  assert.ok(
    events.some((event) => event.type === EventType.CUSTOM && event.name === "okami.harness"),
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === EventType.TEXT_MESSAGE_CONTENT &&
        typeof event.delta === "string" &&
        event.delta.includes("Finished all 25"),
    ),
  );
});

test("large batched receipts stay valid and recoverable through native discovery and checkpoints", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "okami-harness-receipts-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const result = {
    pages: Array.from({ length: 4 }, (_, i) => ({
      url: `https://source.example/state-${i}`,
      text: `State ${i} data. `.repeat(2500),
      values: { candidateA: 51 + i, candidateB: 49 - i },
    })),
  };
  const fixture = await modelFixture(
    t,
    (index) =>
      index === 0
        ? {
            name: "tool_call",
            arguments: { id: "okami_lookup", args: {} },
          }
        : undefined,
    { text: (index) => (index ? "Read the sources." : undefined) },
  );
  let canonical: string | undefined;
  const agent = openclawAgent({
    dataDir,
    model: "openai/fixture",
    providers: richChatFixtureProviders(dataDir),
    prompt: "Read all four source results.",
    tools: [
      defineTool({
        name: "lookup",
        description: "Read sources",
        parameters: z.object({}),
        execute: async () => result,
      }),
    ],
    onMessages: async (messages) => {
      canonical = messages.find((m) => m.role === "tool")?.content as string | undefined;
    },
  });
  const events = await lastValueFrom(
    agent
      .run({
        threadId: randomUUID(),
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: "user", content: "Compare all four states." }],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  assert.ok(!events.some((e) => e.type === EventType.RUN_ERROR));
  assert.deepEqual(
    JSON.parse(canonical ?? "null"),
    result,
    "checkpoints retain complete canonical receipts",
  );
  const wire = JSON.parse(fixture.requests[1].body);
  const output = wire.input.find((item: { type: string }) => item.type === "function_call_output");
  const projected = JSON.parse(output.output);
  assert.deepEqual(
    projected.pages.map((page: { values: unknown }) => page.values),
    result.pages.map((page) => page.values),
  );
  assert.match(output.output, /read_tool_output/);
  const checkpoint = completedMessages([
    {
      id: "call",
      role: "assistant",
      content: "",
      toolCalls: [{ id: "batch", type: "function", function: { name: "lookup", arguments: "{}" } }],
    },
    { id: "receipt", role: "tool", toolCallId: "batch", content: JSON.stringify(result) },
  ]);
  const saved = JSON.parse(String(checkpoint[1].content));
  assert.equal(saved.pages.length, 4);
  assert.deepEqual(
    saved.pages.map((page: { values: unknown }) => page.values),
    result.pages.map((page) => page.values),
  );
});

test("host instructions that fit the native context reach the provider without being duplicated", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "okami-harness-context-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const fixture = await modelFixture(t, () => undefined, { text: () => "Verified answer." });
  const agent = openclawAgent({
    dataDir,
    model: "openai/fixture",
    providers: richChatFixtureProviders(dataDir),
    contextModel: () => ({ id: "fixture", contextTokens: 131072, outputReserveTokens: 4096 }),
    prompt: "Use verified source data and preserve the user's actual objective.\n".repeat(4500),
    tools: [],
  });
  const events = await lastValueFrom(
    agent
      .run({
        threadId: randomUUID(),
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: "user", content: "Report the verified finding." }],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  assert.deepEqual(
    events.filter((event) => event.type === EventType.RUN_ERROR),
    [],
  );
  assert.equal(fixture.requests.length, 1);
  assert.ok(
    events.some(
      (event) =>
        event.type === EventType.TEXT_MESSAGE_CONTENT && event.delta === "Verified answer.",
    ),
  );
});

test("strict-provider null placeholders omit optional fields while explicit nullable values survive native validation", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "okami-harness-null-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const fixture = await modelFixture(
    t,
    (index) =>
      index === 0
        ? {
            name: "accept_work",
            arguments: { timing: { dueAt: null, timezone: null, priority: "high" }, reset: null },
          }
        : undefined,
    { text: (index) => (index ? "Accepted." : undefined) },
  );
  const accepted: unknown[] = [];
  const agent = openclawAgent({
    dataDir,
    model: "openai/fixture",
    providers: richChatFixtureProviders(dataDir),
    toolSearch: false,
    prompt: "Accept this work.",
    tools: [
      defineTool({
        name: "accept_work",
        description: "Accept work",
        parameters: z.object({
          timing: z.object({
            dueAt: z.iso.datetime().optional(),
            timezone: z.string().min(1).optional(),
            priority: z.enum(["high", "normal"]),
          }),
          reset: z.string().nullable(),
        }),
        execute: async (args) => {
          accepted.push(args);
          return { accepted: true };
        },
      }),
    ],
  });
  const events = await lastValueFrom(
    agent
      .run({
        threadId: randomUUID(),
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: "user", content: "Do this work without a deadline." }],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  assert.ok(!events.some((event) => event.type === EventType.RUN_ERROR));
  assert.deepEqual(accepted, [{ timing: { priority: "high" }, reset: null }]);
  assert.equal(fixture.requests.length, 2);
});

test("basic research, data and image tools are immediately callable without hiding the rest of the catalog", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "okami-harness-core-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const fixture = await modelFixture(t, () => undefined, { text: () => "Ready." });
  const agent = openclawAgent({
    dataDir,
    model: "openai/fixture",
    providers: richChatFixtureProviders(dataDir),
    prompt: "Use the available tools.",
    tools: ["search_web", "read_web_data", "generate_image", "remote_operation"].map((name) =>
      defineTool({
        name,
        description: name,
        parameters: z.object({}),
        execute: async () => ({ ok: true }),
      }),
    ),
  });
  await lastValueFrom(
    agent
      .run({
        threadId: randomUUID(),
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: "user", content: "Research and make an image." }],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  const body = JSON.parse(fixture.requests[0].body);
  const names = body.tools.flatMap(
    (tool: { name?: string; tools?: { name: string }[] }) =>
      tool.tools?.map((child) => child.name) ?? [tool.name],
  );
  for (const name of [
    "search_web",
    "read_web_data",
    "generate_image",
    "read_tool_output",
    "tool_search",
    "tool_call",
  ])
    assert.ok(names.includes(name), `${name} is hidden behind a discovery round trip`);
  assert.ok(!names.includes("remote_operation"));
});
