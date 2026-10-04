import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { EventType } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { runtimeTool } from "../apps/server/src/runtime-tools.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("chat can inspect its actual runtime and owned procedures without external research or private config", async (t) => {
  const fixture = await modelFixture(t, (index) =>
    index === 0
      ? { name: "read_runtime", arguments: {} }
      : index === 1
        ? { name: "describe_tools", arguments: { names: ["generate_image"] } }
        : undefined,
  );
  const server = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    encryptionKey: "private-encryption-marker",
    accessKey: "private-access-marker",
  });
  await server.db.put("owner", "playbooks", {
    id: "owned-procedure",
    versions: [
      {
        id: "owned-procedure",
        title: "Meu resumo",
        version: 3,
        requiredTools: ["web_fetch"],
        steps: ["Private full procedure body"],
      },
    ],
  });
  await server.db.put("other-owner", "playbooks", {
    id: "foreign-procedure",
    versions: [
      { id: "foreign-procedure", title: "Foreign private title", version: 1, requiredTools: [] },
    ],
  });
  t.mock.method(server.agent.web, "read", async () => {
    throw new Error("Explaining the local runtime should not fetch public pages");
  });
  const events = await lastValueFrom(
    new ConversationAgent(server.agent.config, server.agent, "owner")
      .run({
        threadId: "runtime-chat",
        runId: randomUUID(),
        messages: [
          {
            id: "runtime-user",
            role: "user",
            content: "Explique como você funciona, seu harness e suas skills.",
          },
        ],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(result && "content" in result, "read_runtime must be a callable chat tool");
  const runtime = JSON.parse(String(result.content));
  assert.equal(runtime.product, "OkamiBot");
  assert.equal(runtime.model, "openai/fixture");
  assert.equal(runtime.execution.surface, "chat");
  assert.equal(runtime.approvals.policy, "all");
  assert.equal(runtime.skills.kind, "installed_workflows");
  assert.ok(
    runtime.skills.installed.some(
      (skill: { id: string }) => skill.id === "builtin:assistant-runtime",
    ),
  );
  assert.equal(runtime.procedures.kind, "saved_procedures");
  assert.deepEqual(runtime.procedures.saved, [
    { id: "owned-procedure", title: "Meu resumo", version: 3, requiredTools: ["web_fetch"] },
  ]);
  assert.ok(runtime.tools.registered.includes("delegate_task"));
  assert.ok(runtime.tools.registered.includes("read_runtime"));
  assert.ok(runtime.tools.registered.includes("read_tool_output"));
  assert.ok(!runtime.tools.registered.includes("finish_task"));
  const serialized = JSON.stringify(runtime);
  for (const marker of [
    "private-encryption-marker",
    "private-access-marker",
    "Foreign private title",
    "Private full procedure body",
    server.directory,
  ])
    assert.ok(!serialized.includes(marker), `runtime response must omit ${marker}`);
  assert.ok(serialized.length < 10000, "default introspection should stay compact");
  assert.equal((await server.db.list("owner", "tasks")).length, 0);
  assert.ok(!events.some((event) => event.type === EventType.RUN_ERROR));
  assert.match(fixture.requests[0].body, /read_runtime/);
  const imageTool = JSON.parse(fixture.requests[2].body).tools.find(
    (tool: { name: string }) => tool.name === "generate_image",
  );
  assert.match(imageTool.description, /returns only a task card/);
  assert.match(imageTool.description, /Worker operation contract/);
  assert.ok(
    fixture.requests[0].body.includes(
      "Promising future, background, delegated, or continued work creates follow-through ownership.",
    ),
    "the chat provider must receive the shared promised-work contract",
  );
});

test("worker runtime introspection is journaled as a read and reports that worker's registered tools", async (t) => {
  const fixture = await modelFixture(t, (index) =>
    index === 0
      ? { name: "read_runtime", arguments: {} }
      : {
          name: "finish_task",
          arguments: {
            summary: "A execução usa ferramentas registradas e tarefas com resultados verificados.",
          },
        },
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await server.agent.createTask("owner", {
    prompt: "Explique em texto como este assistente executa tarefas.",
  });
  await server.agent.worker.tick();
  const operations = await server.agent.journal.operations("owner", task.id);
  const read = operations.find((operation) => operation.toolName === "read_runtime");
  assert.ok(read, "the worker must expose its actual runtime without a public search");
  assert.equal(read.effect, false);
  assert.equal(read.status, "succeeded");
  const request = JSON.parse(fixture.requests[1].body);
  const history = JSON.stringify(request.input);
  assert.match(history, /"?surface\\?":\\?"task/);
  assert.match(history, /finish_task/);
  assert.match(history, /saved_procedures/);
  assert.ok(
    fixture.requests[0].body.includes(
      "Promising future, background, delegated, or continued work creates follow-through ownership.",
    ),
    "the worker provider must receive the same promised-work contract",
  );
  assert.equal((await server.agent.getTask("owner", task.id)).status, "succeeded");
  assert.ok(
    !operations.some((operation) => ["search_web", "web_fetch"].includes(operation.toolName)),
  );
});

test("runtime tool accepts only its read schema and resolves descriptions from the current registry", async (t) => {
  const server = await taskRuntime(t);
  let registered = [{ name: "custom_tool", description: "First registered description" }];
  const tool = runtimeTool(server.agent, "owner", {
    surface: "chat",
    model: () => "fixture/current",
    tools: () => registered,
  });
  assert.ok(tool.execute);
  assert.deepEqual(await tool.execute({ tool: "custom_tool" }), {
    found: true,
    name: "custom_tool",
    description: "First registered description",
  });
  registered = [{ name: "replacement_tool", description: "Current registered description" }];
  assert.deepEqual(await tool.execute({ tool: "custom_tool" }), {
    found: false,
    name: "custom_tool",
  });
  assert.deepEqual(await tool.execute({ tool: "replacement_tool" }), {
    found: true,
    name: "replacement_tool",
    description: "Current registered description",
  });
  await assert.rejects(tool.execute({ includeSecrets: true } as never), /Unrecognized key/);
});

test("large installed tool and procedure inventories remain bounded with explicit truncation", async (t) => {
  const server = await taskRuntime(t);
  for (let index = 0; index < 30; index++)
    await server.db.put("owner", "playbooks", {
      id: `procedure-${index}`,
      versions: [
        {
          id: `procedure-${index}`,
          title: "Long saved procedure ".repeat(8).slice(0, 160),
          version: 1,
          requiredTools: Array.from({ length: 20 }, (_, n) => `tool${n}-${"x".repeat(50)}`),
        },
      ],
    });
  const tool = runtimeTool(server.agent, "owner", {
    surface: "chat",
    model: () => "fixture/current",
    tools: () =>
      Array.from({ length: 200 }, (_, index) => ({
        name: `mcp_long_${index}_${"a".repeat(100)}`,
        description: "Registered tool",
      })),
  });
  assert.ok(tool.execute);
  const result = await tool.execute({});
  const serialized = JSON.stringify(result);
  assert.ok(serialized.length < 10000, `runtime summary was ${serialized.length} characters`);
  const metadata = JSON.parse(serialized);
  assert.equal(metadata.tools.truncated, true);
  assert.equal(metadata.procedures.truncated, true);
});
