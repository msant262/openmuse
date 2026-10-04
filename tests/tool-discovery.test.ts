import assert from "node:assert/strict";
import { test } from "node:test";
import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import { tanstackAgent } from "../apps/server/src/engine/tanstack-agent.ts";
import { modelFixture, richChatFixtureProviders } from "./helpers/model.ts";

function catalog(execute = async (_input: { title: string }) => ({ artifact: "verified.pdf" })) {
  return [
    defineTool({
      name: "create_document",
      description: "Create a PDF document",
      parameters: z.object({ title: z.string().describe("DOCUMENT_SCHEMA_DETAIL ".repeat(150)) }),
      execute,
    }),
    ...Array.from({ length: 24 }, (_, i) =>
      defineTool({
        name: `specialized_${i}`,
        description: `Specialized capability ${i}`,
        parameters: z.object({
          input: z.string().describe(`UNUSED_SCHEMA_DETAIL_${i} `.repeat(150)),
        }),
        execute: async () => ({ success: true }),
      }),
    ),
  ];
}
const input = (id: string) => ({ runId: id });
function makeAgent(
  tools: ReturnType<typeof catalog>,
  maxSteps = 6,
  options: Partial<Parameters<typeof tanstackAgent>[0]> = {},
) {
  return tanstackAgent({
    model: "openai/fixture",
    providers: richChatFixtureProviders("/tmp/discovery-fixture"),
    maxSteps,
    prompt: "Create the requested document using discovered tools.",
    tools,
    ...options,
  });
}
test("provider receives bounded tools then loads a schema and dispatches the original native tool", async (t) => {
  const fixture = await modelFixture(
    t,
    (i) =>
      [
        { name: "search_tools", arguments: { query: "PDF document" } },
        { name: "describe_tools", arguments: { names: ["create_document"] } },
        { name: "create_document", arguments: { title: "Travel" } },
      ][i],
  );
  const created: string[] = [];
  const recorded: string[] = [];
  const agent = makeAgent(
    catalog(async ({ title }) => {
      created.push(title);
      return { artifact: "verified.pdf" };
    }),
    6,
    {
      executeTool: async (call, execute) => {
        recorded.push(call.name);
        return execute();
      },
    },
  );
  agent.threadId = "discovery";
  agent.setMessages([{ id: "user", role: "user", content: "Create a travel PDF" }]);
  await agent.runAgent(input("discovery-run"));
  assert.doesNotMatch(fixture.requests[0].body, /DOCUMENT_SCHEMA_DETAIL|UNUSED_SCHEMA_DETAIL/);
  const first = JSON.parse(fixture.requests[0].body);
  assert.ok(first.tools.some((t: { name: string }) => t.name === "search_tools"));
  assert.ok(Buffer.byteLength(JSON.stringify(first.tools)) < 16000);
  assert.match(fixture.requests[2].body, /DOCUMENT_SCHEMA_DETAIL/);
  assert.doesNotMatch(fixture.requests[2].body, /UNUSED_SCHEMA_DETAIL/);
  assert.deepEqual(created, ["Travel"]);
  const searchResult = agent.messages.find((m) => m.role === "tool");
  assert.equal(JSON.parse(String(searchResult?.content)).tools[0].name, "create_document");
  assert.deepEqual(recorded, ["search_tools", "describe_tools", "create_document"]);
  assert.ok(
    agent.messages.some(
      (m) =>
        m.role === "assistant" && m.toolCalls?.some((c) => c.function.name === "create_document"),
    ),
    "canonical history names the real effect",
  );
});

test("a restarted run restores described schemas from canonical receipts", async (t) => {
  const fixture = await modelFixture(t, (i) =>
    i === 0
      ? { name: "describe_tools", arguments: { names: ["create_document"] } }
      : i === 1
        ? { name: "create_document", arguments: { title: "Resumed" } }
        : undefined,
  );
  const created: string[] = [];
  const tools = catalog(async ({ title }) => {
    created.push(title);
    return { artifact: "verified.pdf" };
  });
  const first = makeAgent(tools, 1);
  first.threadId = "resume";
  first.setMessages([{ id: "user", role: "user", content: "Create a PDF" }]);
  await first.runAgent(input("first"));
  const resumed = makeAgent(tools);
  resumed.threadId = "resume";
  resumed.setMessages(first.messages);
  await resumed.runAgent(input("second"));
  assert.deepEqual(created, ["Resumed"]);
  const secondTools = JSON.parse(fixture.requests[1].body).tools;
  assert.ok(secondTools.some((t: { name: string }) => t.name === "create_document"));
  assert.ok(!secondTools.some((t: { name: string }) => t.name === "specialized_23"));
});

test("discovery rejects unavailable tools and cannot undo final-response tool restrictions", async (t) => {
  const fixture = await modelFixture(t, (i) =>
    i === 0 ? { name: "describe_tools", arguments: { names: ["foreign_owner_tool"] } } : undefined,
  );
  const agent = makeAgent(catalog(), 2, { finalResponseOnStepLimit: true });
  agent.threadId = "unknown";
  agent.setMessages([{ id: "user", role: "user", content: "Find the available document tools" }]);
  await agent.runAgent(input("unknown-run"));
  assert.match(fixture.requests[1].body, /Unknown|unavailable/i);
  assert.equal((JSON.parse(fixture.requests[1].body).tools ?? []).length, 0);
});
