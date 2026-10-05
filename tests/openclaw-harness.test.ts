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
import { modelFixture, richChatFixtureProviders } from "./helpers/model.ts";

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
