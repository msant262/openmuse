import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventType } from "@ag-ui/core";
import { defineTool } from "@copilotkit/runtime/v2";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { lastValueFrom, toArray } from "rxjs";
import { z } from "zod";
import {
  nativeContextOverflow,
  openclawAgent,
  openclawContextEstimator,
} from "../apps/server/src/engine/openclaw-agent.ts";
import { completedMessages } from "../apps/server/src/engine/task-history.ts";
import type { ProviderContinuationCheckpoint } from "../apps/server/src/providers/models.ts";
import { modelFixture, richChatFixtureProviders } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("the copied model reasoning contract reaches the actual provider request", async (t) => {
  const fixture = await modelFixture(t, () => undefined, {
    text: () => "Ready.",
    errorStatus: (index) => (index === 2 ? 503 : undefined),
  });
  const f = await taskRuntime(t);
  for (const [index, model] of [
    "openai/gpt-6-luna",
    "openai/fixture",
    "openai/gpt-6-luna",
  ].entries()) {
    const agent = openclawAgent({
      dataDir: f.directory,
      model,
      fallbacks: index === 2 ? ["openai/fixture"] : [],
      providers: richChatFixtureProviders(f.directory, ["openai/gpt-6-luna", "openai/fixture"]),
      prompt: "Answer the request.",
      tools: [],
    });
    const events = await lastValueFrom(
      agent
        .run({
          threadId: randomUUID(),
          runId: randomUUID(),
          messages: [{ id: randomUUID(), role: "user", content: "Ready?" }],
          tools: [],
          context: [],
          state: {},
        })
        .pipe(toArray()),
    );
    assert.ok(!events.some((event) => event.type === EventType.RUN_ERROR), JSON.stringify(events));
  }
  assert.equal(JSON.parse(fixture.requests[0].body).reasoning.effort, "medium");
  assert.equal(
    JSON.parse(fixture.requests[1].body).reasoning,
    undefined,
    "unknown model routes must keep their own provider defaults",
  );
  assert.equal(JSON.parse(fixture.requests[2].body).reasoning.effort, "medium");
  assert.equal(
    JSON.parse(fixture.requests[3].body).reasoning,
    undefined,
    "a fallback receives its own supported parameters, not the primary model's contract",
  );
});

test("tool turns keep the admitted clock prefix stable while session status still reads the live time", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-06T02:15:00Z") });
  const fixture = await modelFixture(t, (index) => {
    if (index !== 0) return undefined;
    t.mock.timers.setTime(Date.parse("2026-10-06T02:16:00Z"));
    return { name: "session_status", arguments: {} };
  });
  const f = await taskRuntime(t);
  const agent = openclawAgent({
    dataDir: f.directory,
    model: "openai/fixture",
    providers: richChatFixtureProviders(f.directory),
    toolSearch: false,
    prompt: "Resolve the current time with session status when needed.",
    tools: [],
  });
  const events = await lastValueFrom(
    agent
      .run({
        threadId: randomUUID(),
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: "user", content: "Check the time." }],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  assert.ok(!events.some((event) => event.type === EventType.RUN_ERROR));
  assert.equal(fixture.requests.length, 2);
  const [first, second] = fixture.requests.map((request) => JSON.parse(request.body));
  assert.equal(
    second.instructions,
    first.instructions,
    "a minute rollover must not rewrite the prefix before the entire tool history",
  );
  const receipt = second.input.find(
    (item: { type: string }) => item.type === "function_call_output",
  );
  assert.match(receipt.output, /Reference UTC: 2026-10-06 02:16 UTC/);
});

test("the copied temporal context reaches the model and rolls over without a host date prompt", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-05T23:59:00Z") });
  const fixture = await modelFixture(t, () => undefined, { text: () => "Recorded answer." });
  const f = await taskRuntime(t);
  const agent = openclawAgent({
    dataDir: f.directory,
    model: "openai/fixture",
    providers: richChatFixtureProviders(f.directory),
    prompt: "Answer using the current runtime date.",
    tools: [],
  });
  for (const [index, date] of ["2026-10-05", "2026-10-06"].entries()) {
    if (index) t.mock.timers.setTime(Date.parse("2026-10-06T00:01:00Z"));
    const events = await lastValueFrom(
      agent
        .run({
          threadId: randomUUID(),
          runId: randomUUID(),
          messages: [{ id: randomUUID(), role: "user", content: "What is today's date?" }],
          tools: [],
          context: [],
          state: {},
        })
        .pipe(toArray()),
    );
    assert.ok(!events.some((event) => event.type === EventType.RUN_ERROR));
    const instructions = JSON.parse(fixture.requests[index].body).instructions;
    assert.match(
      instructions,
      new RegExp(`## Temporal Context\\nCurrent date: ${date}\\nTime zone:`),
    );
    assert.ok(
      instructions.includes(`Reference UTC: ${date}`),
      "the original live-time formatter reaches the model",
    );
    assert.ok(
      !instructions.includes("Current UTC date and time:"),
      "the native temporal section owns the date",
    );
  }
});

for (const toolSearch of [false, true]) {
  test(`the original session status reads the live clock in a detached host session with discovery=${toolSearch}`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-06T02:15:00Z") });
    const fixture = await modelFixture(t, (index) =>
      index === 0
        ? toolSearch
          ? { name: "tool_call", arguments: { id: "session_status", args: {} } }
          : { name: "session_status", arguments: {} }
        : undefined,
    );
    const f = await taskRuntime(t);
    const agent = openclawAgent({
      dataDir: f.directory,
      model: "openai/fixture",
      providers: richChatFixtureProviders(f.directory),
      toolSearch,
      prompt: "Use session_status to resolve the current date.",
      tools: [],
    });
    await lastValueFrom(
      agent
        .run({
          threadId: randomUUID(),
          runId: randomUUID(),
          messages: [{ id: randomUUID(), role: "user", content: "Check the current date." }],
          tools: [],
          context: [],
          state: {},
        })
        .pipe(toArray()),
    );
    assert.equal(fixture.requests.length, 2);
    const receipt = JSON.parse(fixture.requests[1].body).input.find(
      (item: { type: string }) => item.type === "function_call_output",
    );
    assert.ok(receipt, "the original tool returns a model-visible receipt");
    assert.match(receipt.output, /Reference UTC: 2026-10-06 02:15 UTC/);
    assert.doesNotMatch(receipt.output, /Unknown session|not found|sessionKey required/);
  });
}

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

test("native discovery loads instructions only for the selected tools and dispatches the original call", async (t) => {
  const fixture = await modelFixture(
    t,
    (i) =>
      [
        { name: "tool_describe", arguments: { id: "okami_lookup" } },
        { name: "lookup", arguments: { query: "source" } },
      ][i],
  );
  const f = await taskRuntime(t);
  let calls = 0;
  const marker = "SELECTED_LOOKUP_INSTRUCTIONS";
  const agent = openclawAgent({
    dataDir: f.directory,
    model: "openai/fixture",
    providers: richChatFixtureProviders(f.directory),
    prompt: "Use native discovery to read the requested source.",
    promptContext: async (names = []) => (names.includes("lookup") ? marker : ""),
    tools: [
      defineTool({
        name: "lookup",
        description: "Read a source",
        parameters: z.object({ query: z.string() }),
        execute: async ({ query }) => {
          calls++;
          return { query, value: 52 };
        },
      }),
    ],
  });
  await lastValueFrom(
    agent
      .run({
        threadId: randomUUID(),
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: "user", content: "Read the source." }],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  assert.ok(!JSON.parse(fixture.requests[0].body).instructions.includes(marker));
  assert.ok(JSON.parse(fixture.requests[1].body).instructions.includes(marker));
  assert.equal(calls, 1);
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

test("the copied executor blocks identical direct calls while allowing a different approach", async (t) => {
  const f = await taskRuntime(t);
  await modelFixture(t, (index) =>
    index < 21
      ? { name: "lookup", arguments: { query: "same" } }
      : index === 21
        ? { name: "lookup", arguments: { query: "different" } }
        : undefined,
  );
  const dispatched: string[] = [];
  const agent = openclawAgent({
    dataDir: f.directory,
    model: "openai/fixture",
    providers: richChatFixtureProviders(f.directory),
    toolSearch: false,
    prompt: "Use available sources to complete the research.",
    tools: [
      defineTool({
        name: "lookup",
        description: "Read a source",
        parameters: z.object({ query: z.string() }),
        execute: async ({ query }) => {
          dispatched.push(query);
          return { result: query };
        },
      }),
    ],
  });
  await lastValueFrom(
    agent
      .run({
        threadId: randomUUID(),
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: "user", content: "Research the question." }],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  assert.ok(
    dispatched.filter((query) => query === "same").length < 21,
    "a repeated call must be vetoed before host dispatch",
  );
  assert.equal(dispatched.at(-1), "different", "a new source remains available after the veto");
});

test("the copied executor blocks identical discovered calls while allowing a different approach", async (t) => {
  const f = await taskRuntime(t);
  await modelFixture(t, (index) =>
    index < 21
      ? { name: "lookup", arguments: { query: "same" } }
      : index === 21
        ? { name: "lookup", arguments: { query: "different" } }
        : undefined,
  );
  const dispatched: string[] = [];
  const agent = openclawAgent({
    dataDir: f.directory,
    model: "openai/fixture",
    providers: richChatFixtureProviders(f.directory),
    prompt: "Use available sources to complete the research.",
    tools: [
      defineTool({
        name: "lookup",
        description: "Read a source",
        parameters: z.object({ query: z.string() }),
        execute: async ({ query }) => {
          dispatched.push(query);
          return { result: query };
        },
      }),
    ],
  });
  await lastValueFrom(
    agent
      .run({
        threadId: randomUUID(),
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: "user", content: "Research the question." }],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  assert.ok(
    dispatched.filter((query) => query === "same").length < 21,
    "a repeated call must be vetoed before host dispatch",
  );
  assert.equal(dispatched.at(-1), "different", "a new source remains available after the veto");
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

test("native tool discovery can recover the latest rejected document draft by producing tool name", async (t) => {
  const f = await taskRuntime(t);
  const content = "Preserved original draft. ".repeat(500);
  let writes = 0;
  const fixture = await modelFixture(
    t,
    (i) => {
      if (i === 0) return { name: "create_document", arguments: { content } };
      if (i === 1)
        return {
          name: "read_tool_output",
          arguments: {
            tool: "create_document",
            part: "arguments",
            pointer: "/content",
            offset: 0,
            limit: 16000,
          },
        };
      if (i === 2) {
        const input = JSON.parse(fixture.requests[i].body).input;
        const recovered = JSON.parse(
          input.findLast((item: { type: string }) => item.type === "function_call_output").output,
        );
        assert.equal(recovered.error, undefined, JSON.stringify(recovered));
        assert.equal(recovered.content, content);
        assert.equal(recovered.selectedByTool, "create_document");
        assert.ok(recovered.toolCallId);
        assert.equal(recovered.nextOffset, null);
      }
      return undefined;
    },
    { text: (i) => (i === 2 ? "Draft recovered." : undefined) },
  );
  const agent = openclawAgent({
    dataDir: f.directory,
    model: "openai/fixture",
    providers: richChatFixtureProviders(f.directory),
    prompt: "Recover the rejected draft without rendering another file.",
    tools: [
      defineTool({
        name: "create_document",
        description: "Propose a document",
        parameters: z.object({ content: z.string() }),
        execute: async () => {
          writes++;
          return {
            attachment: false,
            rendered: false,
            repairable: true,
            missing: ["Correct wording in the draft"],
          };
        },
      }),
    ],
  });
  const events = await lastValueFrom(
    agent
      .run({
        threadId: randomUUID(),
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: "user", content: "Recover the original draft." }],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  assert.ok(!events.some((event) => event.type === EventType.RUN_ERROR));
  assert.equal(fixture.requests.length, 3);
  assert.equal(writes, 1);
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

test("host context admission lets the original harness compact and retry rather than report missing capabilities", async (t) => {
  const f = await taskRuntime(t);
  const fixture = await modelFixture(t, () => undefined, {
    text: () => "Retained verified result: Source A reports 52%. Completed the request.",
  });
  const providers = richChatFixtureProviders(f.directory);
  providers.routing!.capabilities["openai/fixture"].contextTokens = 100000;
  providers.routing!.maxAttempts = 1;
  const interruptions: unknown[] = [];
  const agent = openclawAgent({
    dataDir: f.directory,
    compaction: { db: f.db, owner: "owner", scope: "context-recovery" },
    model: "openai/fixture",
    providers,
    contextModel: () => ({ id: "fixture", contextTokens: 131072, outputReserveTokens: 8192 }),
    prompt: "Use the recorded sources to answer the current request. Preserve verified facts.",
    tools: [],
    onProviderInterrupted: (checkpoint) => {
      interruptions.push(checkpoint);
    },
  });
  const messages = Array.from({ length: 40 }, (_, i) => ({
    id: randomUUID(),
    role: i % 2 ? ("assistant" as const) : ("user" as const),
    content:
      `Historical record ${i}. Source A reports 52%. ` +
      "Detailed observation from the source. ".repeat(220),
  }));
  messages.push({ id: randomUUID(), role: "user", content: "Complete the recorded research." });
  const events = await lastValueFrom(
    agent
      .run({
        threadId: "context-recovery",
        runId: randomUUID(),
        messages,
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  assert.deepEqual(
    events.filter((event) => event.type === EventType.RUN_ERROR),
    [],
    "an oversized host request must reach the copied context-overflow recovery",
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === EventType.TEXT_MESSAGE_CONTENT && String(event.delta).includes("52%"),
    ),
  );
  assert.ok(
    fixture.requests.length >= 2,
    "the original compaction summary and recovered execution both reach the provider",
  );
  assert.equal(interruptions.length, 0, "recoverable context admission is not a provider outage");
  const saved = (await f.db.list<{ entries: { type: string }[] }>("owner", "harness-sessions"))[0];
  assert.ok(
    saved.entries.some((entry) => entry.type === "compaction"),
    "the recovered native tree is persisted",
  );
});

test("the native executor uses a declared 1.05M window without a hidden 128k ceiling", async (t) => {
  const f = await taskRuntime(t);
  const fixture = await modelFixture(t, () => undefined, {
    text: () => "Retained the full context.",
  });
  const providers = richChatFixtureProviders(f.directory);
  providers.routing!.capabilities["openai/fixture"].contextTokens = 1050000;
  const messages = Array.from({ length: 90 }, (_, i) => ({
    id: randomUUID(),
    role: i % 2 ? ("assistant" as const) : ("user" as const),
    content: `HISTORICAL_MARKER_${i}. ` + "Detailed observation from the source. ".repeat(300),
  }));
  messages.push({ id: randomUUID(), role: "user", content: "Answer using all retained records." });
  const estimate = await openclawContextEstimator(f.directory);
  const cost = estimate({
    logger: resolveDebugOption(false),
    model: "openai/fixture",
    messages,
    tools: [],
    systemPrompts: ["Answer directly."],
  });
  assert.ok(cost > 200000 && cost < 1050000, `expected a request above 200k, observed ${cost}`);
  const agent = openclawAgent({
    dataDir: f.directory,
    model: "openai/fixture",
    providers,
    prompt: "Answer directly.",
    tools: [],
    compaction: { db: f.db, owner: "owner", scope: "large-window" },
  });
  const events = await lastValueFrom(
    agent
      .run({
        threadId: "large-window",
        runId: randomUUID(),
        messages,
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
  assert.equal(
    fixture.requests.length,
    1,
    "do not prematurely compact a request that fits the model",
  );
  for (const i of [0, 44, 89])
    assert.ok(fixture.requests[0].body.includes(`HISTORICAL_MARKER_${i}.`));
  const offered = JSON.parse(fixture.requests[0].body).tools.flatMap(
    (tool: { tools?: unknown[] }) => tool.tools ?? [tool],
  );
  const reader = offered.find((tool: { name?: string; function?: { name?: string } }) =>
    ["okami_read_tool_output", "read_tool_output"].includes((tool.function ?? tool).name ?? ""),
  );
  assert.ok(reader, "canonical tool receipts remain recoverable");
  assert.ok(
    (reader.function ?? reader).parameters.properties.limit.maximum >= 50000,
    "large-window source recovery must not retain the 128k profile's smaller read limit",
  );
  const saved = (await f.db.list<{ entries: { type: string }[] }>("owner", "harness-sessions"))[0];
  assert.ok(!saved.entries.some((entry) => entry.type === "compaction"));
});

test("context recovery preserves genuine capability, authentication and explicit floor failures", () => {
  const providers = richChatFixtureProviders("/var/tmp/context-admission");
  const checkpoint: ProviderContinuationCheckpoint = {
    version: 1,
    messages: [],
    partialText: "",
    rejectedModel: "local/fixture",
    accepted: false,
    code: "MODEL_CAPABILITY_UNAVAILABLE",
    admission: {
      stage: "provider_dispatch",
      requirements: { tools: true, vision: true, structuredOutput: false, contextTokens: 150000 },
      candidates: [
        {
          model: "local/fixture",
          capabilities: {
            tools: true,
            vision: true,
            structuredOutput: true,
            contextTokens: 131072,
          },
          capabilitySource: "declared",
          eligible: false,
          considered: false,
          cooldownUntil: 0,
        },
      ],
    },
  };
  assert.equal(
    nativeContextOverflow(checkpoint, providers),
    "prompt is too long: 150000 tokens > 131072 maximum",
  );
  assert.equal(nativeContextOverflow({ ...checkpoint, accepted: true }, providers), undefined);
  assert.equal(
    nativeContextOverflow({ ...checkpoint, code: "MODEL_PROVIDER_INTERRUPTED" }, providers),
    undefined,
  );
  assert.equal(nativeContextOverflow(checkpoint, providers, 150000), undefined);
  assert.equal(nativeContextOverflow(checkpoint, providers, 140000), undefined);
  const candidate = checkpoint.admission!.candidates[0];
  for (const changes of [{ vision: false }, { tools: false }, { contextTokens: 200000 }]) {
    assert.equal(
      nativeContextOverflow(
        {
          ...checkpoint,
          admission: {
            ...checkpoint.admission!,
            candidates: [{ ...candidate, capabilities: { ...candidate.capabilities, ...changes } }],
          },
        },
        providers,
      ),
      undefined,
    );
  }
  assert.equal(
    nativeContextOverflow(
      {
        ...checkpoint,
        admission: {
          ...checkpoint.admission!,
          candidates: [{ ...candidate, model: "mimo/not-configured" }],
        },
      },
      providers,
    ),
    undefined,
    "compaction cannot supply absent provider credentials",
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

for (const computerConfigured of [false, true]) {
  test(`core research and image tools stay visible, with configured computer=${computerConfigured}`, async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), "okami-harness-core-"));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const fixture = await modelFixture(t, () => undefined, { text: () => "Ready." });
    const agent = openclawAgent({
      dataDir,
      model: "openai/fixture",
      providers: richChatFixtureProviders(dataDir),
      prompt: "Use the available tools.",
      directToolNames: computerConfigured ? ["run_computer_command"] : [],
      tools: [
        "search_web",
        "read_web_data",
        "generate_image",
        "run_computer_command",
        "remote_operation",
      ].map((name) =>
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
      "generate_image",
      "read_tool_output",
      "tool_search",
      "tool_call",
    ])
      assert.ok(names.includes(name), `${name} is hidden behind a discovery round trip`);
    assert.ok(!names.includes("remote_operation"));
    assert.ok(!names.includes("read_web_data"), "complex data queries remain discoverable");
    assert.equal(names.includes("run_computer_command"), computerConfigured);
  });
}
