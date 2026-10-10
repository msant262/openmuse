import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { EventType } from "@ag-ui/core";
import { defineTool } from "@copilotkit/runtime/v2";
import { lastValueFrom, toArray } from "rxjs";
import { z } from "zod";
import { ActionService } from "../apps/server/src/actions.ts";
import { openclawAgent } from "../apps/server/src/engine/openclaw-agent.ts";
import { modelFixture, richChatFixtureProviders } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("native Python selection retains the copied agent's ordinary host hook and exact programmatic tool data", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? {
          name: "tool_call",
          arguments: {
            id: "okami_execute_code",
            args: {
              language: "python",
              code: "from hermes_tools import read_sample\nprint(read_sample({}))",
              resetPython: true,
            },
          },
        }
      : undefined,
  );
  const f = await taskRuntime(t);
  const calls: string[] = [];
  let nativeRuns = 0;
  const agent = openclawAgent({
    dataDir: f.directory,
    model: "openai/fixture",
    providers: richChatFixtureProviders(f.directory),
    prompt: "Calculate from actual values.",
    codeToolEffects: true,
    executeTool: async (call, execute) => {
      calls.push(call.name);
      return execute();
    },
    projectToolResult: async (name, value) => (name === "read_sample" ? { value: 0 } : value),
    pythonRuntime: {
      execute: async (input) => {
        nativeRuns++;
        assert.equal(input.reset, true);
        assert.equal(input.wallClockMs, 300_000);
        assert.equal(input.maxToolCalls, 100);
        assert.equal(
          input.tools.some((tool) => ["finish_task", "execute_code"].includes(tool.name)),
          false,
        );
        const tool = input.tools.find((tool) => tool.name === "read_sample");
        assert.ok(tool);
        assert.deepEqual(await tool.execute("native-owned-call", {}, true), { value: 42 });
        return { command: { status: "succeeded" }, result: { stdout: "42\n" } };
      },
    },
    tools: [
      defineTool({
        name: "read_sample",
        description: "Read actual values.",
        parameters: z.object({}),
        execute: async () => ({ value: 42 }),
      }),
      defineTool({
        name: "finish_task",
        description: "Finish delivery.",
        parameters: z.object({}),
        execute: async () => assert.fail("cell cannot finish its still-running task"),
      }),
    ],
  });
  const events = await lastValueFrom(
    agent
      .run({
        threadId: randomUUID(),
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: "user", content: "Compute using Python." }],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  assert.ok(!events.some((event) => event.type === EventType.RUN_ERROR), JSON.stringify(events));
  assert.equal(nativeRuns, 1, JSON.stringify(events));
  assert.deepEqual(calls, ["execute_code", "read_sample"]);
});

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
  const projected: string[] = [];
  const agent = openclawAgent({
    dataDir: f.directory,
    model: "openai/fixture",
    providers: richChatFixtureProviders(f.directory),
    prompt: "Calculate using available tools.",
    executeTool: async (call, execute) => {
      calls.push(call);
      return execute();
    },
    projectToolResult: async (name, value) => {
      projected.push(name);
      return name === "read_sample" ? { value: 0 } : value;
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
  assert.ok(
    !projected.includes("read_sample"),
    "programmatic child calls must receive exact tool data, not the reasoning view",
  );
});

test("foreground Code Mode can read actual page-image metadata through normal host dispatch", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? {
          name: "tool_call",
          arguments: {
            id: "okami_execute_code",
            args: { code: "return await browser_get_images({offset:0,limit:2});" },
          },
        }
      : undefined,
  );
  const f = await taskRuntime(t);
  const calls: string[] = [];
  const image = { src: "https://example.com/cover.svg", alt: "Course cover" };
  const agent = openclawAgent({
    dataDir: f.directory,
    model: "openai/fixture",
    providers: richChatFixtureProviders(f.directory),
    prompt: "Describe page images.",
    executeTool: async (call, execute) => {
      calls.push(call.name);
      return execute();
    },
    tools: [
      defineTool({
        name: "browser_get_images",
        description: "Read page images",
        parameters: z.object({ offset: z.number(), limit: z.number() }),
        execute: async (args) => {
          assert.deepEqual(args, { offset: 0, limit: 2 });
          return { images: [image] };
        },
      }),
    ],
  });
  const events = await lastValueFrom(
    agent
      .run({
        threadId: randomUUID(),
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: "user", content: "Describe the images." }],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  assert.ok(!events.some((event) => event.type === EventType.RUN_ERROR), JSON.stringify(events));
  const result = events.find(
    (event) =>
      event.type === EventType.TOOL_CALL_RESULT &&
      String(event.content).includes('"value"') &&
      String(event.content).includes(image.src),
  );
  assert.ok(result, JSON.stringify(events));
  assert.deepEqual(JSON.parse(String(result.content)).value, { images: [image] });
  assert.deepEqual(calls, ["execute_code", "browser_get_images"]);
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

test("task Code Mode calls authorized writes through the normal host boundary and reads their actual result", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? {
          name: "tool_call",
          arguments: {
            id: "okami_execute_code",
            args: {
              code: 'await write_note({text:"owned note"}); return await read_note({});',
            },
          },
        }
      : undefined,
  );
  const f = await taskRuntime(t);
  const dispatched: string[] = [];
  const agent = openclawAgent({
    dataDir: f.directory,
    model: "openai/fixture",
    providers: richChatFixtureProviders(f.directory),
    prompt: "Save and read the authorized note.",
    codeToolEffects: true,
    executeTool: async (call, execute) => {
      dispatched.push(call.name);
      return execute();
    },
    tools: [
      defineTool({
        name: "write_note",
        description: "Write this owner's note",
        parameters: z.object({ text: z.string() }),
        execute: async ({ text }) => f.db.put("owner", "qa-notes", { id: "note", text }),
      }),
      defineTool({
        name: "read_note",
        description: "Read this owner's note",
        parameters: z.object({}),
        execute: async () => f.db.get("owner", "qa-notes", "note"),
      }),
    ],
  });
  const events = await lastValueFrom(
    agent
      .run({
        threadId: randomUUID(),
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: "user", content: "Save my note." }],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  assert.deepEqual(dispatched, ["execute_code", "write_note", "read_note"]);
  assert.ok(
    events.some(
      (event) =>
        event.type === EventType.TOOL_CALL_RESULT && String(event.content).includes('"owned note"'),
    ),
    JSON.stringify(events),
  );
  assert.equal(await f.db.get("other-owner", "qa-notes", "note"), null);
});

test("task Code Mode keeps deletion awaiting user approval and stops subsequent calls", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? {
          name: "tool_call",
          arguments: {
            id: "okami_execute_code",
            args: {
              code: "await prepare_delete({}); return await read_note({});",
            },
          },
        }
      : undefined,
  );
  const f = await taskRuntime(t);
  let paused = false,
    deletes = 0,
    reads = 0;
  const actions = new ActionService(f.db, {
    connected: async () => true,
    execute: async () => "unused",
  });
  actions.registerExternal("qa.delete", async () => {
    deletes++;
    return "deleted";
  });
  const agent = openclawAgent({
    dataDir: f.directory,
    model: "openai/fixture",
    providers: richChatFixtureProviders(f.directory),
    prompt: "Prepare the requested deletion.",
    codeToolEffects: true,
    shouldContinue: () => !paused,
    tools: [
      defineTool({
        name: "prepare_delete",
        description: "Prepare deletion for approval",
        parameters: z.object({}),
        execute: async () => {
          const action = await actions.proposeExternal(
            "owner",
            {
              tool: "qa.delete",
              target: "note",
              summary: "Delete the note",
              money: false,
              binding: {},
              requiresHumanApproval: true,
            },
            "code-delete",
          );
          paused = action.status === "awaiting_review";
          return { actionId: action.id, status: action.status, approvalRequired: paused };
        },
      }),
      defineTool({
        name: "read_note",
        description: "Read the note",
        parameters: z.object({}),
        execute: async () => {
          reads++;
          return { text: "note" };
        },
      }),
    ],
  });
  await lastValueFrom(
    agent
      .run({
        threadId: randomUUID(),
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: "user", content: "Delete my note." }],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  assert.equal(paused, true, "the code must create the ordinary approval card");
  assert.equal(deletes, 0, "a script is not user approval");
  assert.equal(reads, 0, "pause prevents subsequent dispatch even within the same script");
  const proposals = await f.db.list<{ status: string }>("owner", "actions");
  assert.equal(proposals[0].status, "awaiting_review");
});
