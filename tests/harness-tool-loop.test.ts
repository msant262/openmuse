import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { EventType } from "@ag-ui/core";
import { defineTool } from "@copilotkit/runtime/v2";
import { lastValueFrom, toArray } from "rxjs";
import { z } from "zod";
import { tanstackAgent } from "../apps/server/src/engine/tanstack-agent.ts";
import { modelFixture } from "./helpers/model.ts";

const input = () => ({
  threadId: randomUUID(),
  runId: randomUUID(),
  messages: [
    {
      id: randomUUID(),
      role: "user" as const,
      content: "Complete the work using available tools.",
    },
  ],
  tools: [],
  context: [],
  state: {},
});

test("the actual model loop vetoes repeated calls before dispatch and keeps a new approach available", async (t) => {
  const fixture = await modelFixture(t, (index) =>
    index < 21
      ? { name: "lookup", arguments: { query: "same" } }
      : index === 21
        ? { name: "lookup", arguments: { query: "different" } }
        : undefined,
  );
  const dispatches: string[] = [];
  const agent = tanstackAgent({
    model: "openai/fixture",
    prompt: "Execute.",
    maxSteps: 24,
    tools: [
      defineTool({
        name: "lookup",
        description: "Read",
        parameters: z.object({ query: z.string() }),
        execute: async ({ query }) => {
          dispatches.push(query);
          return { result: query };
        },
      }),
    ],
  });
  const events = await lastValueFrom(agent.run(input()).pipe(toArray()));
  assert.equal(dispatches.filter((query) => query === "same").length, 20);
  assert.equal(dispatches.at(-1), "different");
  assert.ok(fixture.requests.some((request) => request.body.includes("TOOL_NO_PROGRESS")));
  assert.ok(fixture.requests.some((request) => request.body.includes("WARNING: lookup")));
  assert.ok(!events.some((event) => event.type === EventType.RUN_ERROR));
});

test("the model receives bounded output and can retrieve the omitted middle while checkpoints keep full content", async (t) => {
  const full = `${"a".repeat(50000)}IMPORTANT MIDDLE${"z".repeat(50000)}`;
  let outputId = "";
  const fixture = await modelFixture(t, (index) => {
    if (index === 0) return { name: "large_read", arguments: {} };
    if (index === 1) {
      const body = fixture.requests[index].body;
      assert.ok(body.length < 25000, `provider payload: ${body.length}`);
      assert.ok(!body.includes("IMPORTANT MIDDLE"));
      return {
        name: "read_tool_output",
        arguments: { toolCallId: outputId, offset: 50000, limit: 100 },
      };
    }
    assert.ok(fixture.requests[index].body.includes("IMPORTANT MIDDLE"));
    return undefined;
  });
  let fullCheckpoint = false;
  const agent = tanstackAgent({
    model: "openai/fixture",
    prompt: "Read the complete requested source.",
    maxSteps: 4,
    tools: [
      defineTool({
        name: "large_read",
        description: "Read",
        parameters: z.object({}),
        execute: async () => full,
      }),
    ],
    onMessages: async (messages) => {
      for (const message of messages)
        if (message.role === "tool" && message.content === full) {
          outputId = message.toolCallId ?? "";
          fullCheckpoint = true;
        }
    },
  });
  const events = await lastValueFrom(agent.run(input()).pipe(toArray()));
  assert.equal(fullCheckpoint, true);
  assert.equal(fixture.requests.length, 3);
  assert.ok(!events.some((event) => event.type === EventType.RUN_ERROR));
});
