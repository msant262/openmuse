import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { EventType } from "@ag-ui/core";
import { defineTool } from "@copilotkit/runtime/v2";
import { lastValueFrom, toArray } from "rxjs";
import { z } from "zod";
import { openclawAgent } from "../apps/server/src/engine/openclaw-agent.ts";
import { modelFixture, richChatFixtureProviders } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("original Code Mode batches real host reads and records each child through the normal dispatch boundary", async (t) => {
  const fixture = await modelFixture(t, (index) =>
    index === 0
      ? {
          name: "tool_call",
          arguments: {
            id: "okami_execute_code",
            args: {
              code: 'const a = await read_sample({key:"first"}); const b = await read_sample({key:"second"}); return {sum:a.value+b.value, process:typeof process, require:typeof require};',
            },
          },
        }
      : undefined,
  );
  const f = await taskRuntime(t);
  const calls: Array<{ name: string; args: unknown }> = [];
  const agent = openclawAgent({
    dataDir: f.directory,
    model: "openai/fixture",
    providers: richChatFixtureProviders(f.directory),
    prompt: "Calculate using available tools.",
    executeTool: async (call, execute) => {
      calls.push(call);
      return execute();
    },
    tools: [
      defineTool({
        name: "read_sample",
        description: "Read an observed value.",
        parameters: z.object({ key: z.enum(["first", "second"]) }),
        execute: async ({ key }) => ({ value: key === "first" ? 17 : 25 }),
      }),
    ],
  });
  const events = await lastValueFrom(
    agent
      .run({
        threadId: randomUUID(),
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: "user", content: "Add the two values." }],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  assert.ok(!events.some((event) => event.type === EventType.RUN_ERROR), JSON.stringify(events));
  const result = events.find(
    (event) => event.type === EventType.TOOL_CALL_RESULT && String(event.content).includes('"sum"'),
  );
  assert.ok(result, JSON.stringify(events));
  assert.deepEqual(JSON.parse(String(result.content)).value, {
    sum: 42,
    process: "undefined",
    require: "undefined",
  });
  assert.deepEqual(
    calls.map((call) => call.name),
    ["execute_code", "read_sample", "read_sample"],
  );
  assert.deepEqual(
    calls.slice(1).map((call) => call.args),
    [{ key: "first" }, { key: "second" }],
  );
  assert.equal(fixture.requests.length, 2);
});

test("Code Mode exposes only run-scoped reads and stops child dispatch after a terminal outcome", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? {
          name: "tool_call",
          arguments: {
            id: "okami_execute_code",
            args: { code: "await read_sample({}); return await read_sample({});" },
          },
        }
      : undefined,
  );
  const f = await taskRuntime(t);
  let reads = 0;
  const agent = openclawAgent({
    dataDir: f.directory,
    model: "openai/fixture",
    providers: richChatFixtureProviders(f.directory),
    prompt: "Calculate.",
    shouldContinue: () => reads === 0,
    tools: [
      defineTool({
        name: "read_sample",
        description: "Read one value",
        parameters: z.object({}),
        execute: async () => {
          reads++;
          return { value: 12 };
        },
      }),
    ],
  });
  const events = await lastValueFrom(
    agent
      .run({
        threadId: randomUUID(),
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: "user", content: "Read values." }],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  assert.equal(reads, 1, JSON.stringify(events));
});

test("a Code Mode script cannot invoke a write tool even when that tool exists in the agent catalog", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? {
          name: "tool_call",
          arguments: {
            id: "okami_execute_code",
            args: { code: 'return await delete_document({id:"another-owner"});' },
          },
        }
      : undefined,
  );
  const f = await taskRuntime(t);
  let writes = 0;
  const agent = openclawAgent({
    dataDir: f.directory,
    model: "openai/fixture",
    providers: richChatFixtureProviders(f.directory),
    prompt: "Inspect available tools.",
    tools: [
      defineTool({
        name: "delete_document",
        description: "Delete a document",
        parameters: z.object({ id: z.string() }),
        execute: async () => {
          writes++;
          return { deleted: true };
        },
      }),
    ],
  });
  const events = await lastValueFrom(
    agent
      .run({
        threadId: randomUUID(),
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: "user", content: "Inspect the tool catalog." }],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  assert.equal(writes, 0);
  assert.ok(
    events.some(
      (event) =>
        event.type === EventType.TOOL_CALL_RESULT &&
        String(event.content).includes('"status":"failed"'),
    ),
    JSON.stringify(events),
  );
});
