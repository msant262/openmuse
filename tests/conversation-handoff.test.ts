import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { EventType } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { LocalThreads } from "../apps/server/src/threads.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const source = "https://garden.example/research";
const fact = "Regue quando os primeiros dois centímetros de terra estiverem secos.";
const imageArgs = {
  prompt: `Infográfico em português: ${fact} Fonte: ${source}`,
  name: "Cuidados do jardim",
  operationId: "garden-image",
};
const input = (content: string) => ({
  threadId: "research-image-chat",
  runId: randomUUID(),
  messages: [{ id: "request-image", role: "user" as const, content }],
  tools: [],
  context: [],
  state: {},
});
const offeredTools = (body: string) =>
  (JSON.parse(body).tools ?? []).map((tool: { name: string }) => tool.name);

// This fixture already knows these native argument shapes. A deferred schema is
// still an available capability; only the reserved handoff removes that capability.
const capabilityAvailable = (body: string, name: string) => {
  const tools = JSON.parse(body).tools ?? [];
  return tools.some(
    (tool: { name: string; description?: string }) =>
      tool.name === name || (tool.name === "search_tools" && tool.description?.includes(name)),
  );
};

test("research retains a bounded handoff before the final answer and delivers the requested image", async (t) => {
  const fixture = await modelFixture(
    t,
    (index) => {
      const tools = offeredTools(fixture.requests[index].body);
      if (index >= 10)
        return index === 10
          ? { name: "generate_image", arguments: imageArgs }
          : { name: "finish_task", arguments: { summary: "Infográfico pronto e anexado." } };
      if (capabilityAvailable(fixture.requests[index].body, "web_fetch"))
        return { name: "web_fetch", arguments: { url: source } };
      if (tools.includes("delegate_task"))
        return {
          name: "delegate_task",
          arguments: {
            kind: "agent",
            title: "Criar infográfico do jardim",
            prompt: `Crie um infográfico em português com o fato verificado: ${fact} Fonte: ${source}`,
          },
        };
      return undefined;
    },
    {
      text: (index) =>
        offeredTools(fixture.requests[index].body).length
          ? undefined
          : "O trabalho Criar infográfico do jardim está em andamento.",
    },
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const capability = server.agent.config.modelProviders?.routing?.capabilities["openai/fixture"];
  assert.ok(capability);
  capability.vision = true;
  assert.ok(server.threads instanceof LocalThreads);
  await server.threads.ensure("owner", "research-image-chat");
  let reads = 0;
  t.mock.method(server.agent.web, "read", async () => {
    reads++;
    return { url: source, title: "Cuidados do jardim", text: fact, links: [], truncated: false };
  });
  t.mock.method(server.agent.media, "generatedImage", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=",
      "base64",
    );
    const file = await server.files.importAttachment(
      "owner",
      "Jardim.png",
      png,
      "Generated image",
      "image/png",
    );
    return server.files.reference("owner", file.id);
  });
  const events = await lastValueFrom(
    new ConversationAgent(server.agent.config, server.agent, "owner")
      .run(input("Pesquise os cuidados e crie um infográfico sobre o jardim."))
      .pipe(toArray()),
  );
  const tasks = await server.agent.snapshot("owner");
  assert.equal(
    tasks.tasks.length,
    1,
    "research must leave a durable job for the requested artifact",
  );
  assert.equal(reads, 8, "reserve handoff and final response inside the existing ten-step budget");
  assert.equal(fixture.requests.length, 10);
  assert.deepEqual(offeredTools(fixture.requests[8].body), ["delegate_task"]);
  assert.deepEqual(offeredTools(fixture.requests[9].body), []);
  assert.match(fixture.requests[8].body, /do not.*claim.*unavailable/i);
  assert.ok(fixture.requests[8].body.includes(fact));
  assert.ok(fixture.requests[8].body.includes(source));
  const task = await server.agent.getTask("owner", tasks.tasks[0].id);
  assert.equal(task.kind, "agent");
  assert.equal(task.originThreadId, "research-image-chat");
  assert.equal(task.originMessageId, "request-image");
  assert.equal(task.prompt, "Pesquise os cuidados e crie um infográfico sobre o jardim.");
  assert.ok(task.criteria?.some((criterion) => criterion.id === "requested-image"));
  assert.ok(String(task.state.delegatedBrief).includes(fact));
  assert.ok(String(task.state.delegatedBrief).includes(source));
  assert.ok(
    events.some(
      (event) =>
        event.type === EventType.TOOL_CALL_START &&
        "toolCallName" in event &&
        event.toolCallName === "delegate_task",
    ),
  );
  assert.ok(!events.some((event) => event.type === EventType.RUN_ERROR));
  await server.agent.worker.tick();
  const completed = await server.agent.getTask("owner", task.id);
  assert.equal(completed.status, "succeeded", completed.error ?? completed.question);
  assert.equal(completed.artifactIds.length, 1);
  assert.equal((await server.files.get("owner", completed.artifactIds[0])).mimeType, "image/png");
  const publication = await server.db.get("owner", "thread-publications", `task:${task.id}`);
  assert.equal(publication?.threadId, "research-image-chat");
  assert.equal(publication?.status, "posted");
});

test("the handoff slot does not queue a second job after image generation was already delegated", async (t) => {
  const fixture = await modelFixture(t, (index) => {
    const tools = offeredTools(fixture.requests[index].body);
    if (index === 0) return { name: "generate_image", arguments: imageArgs };
    if (capabilityAvailable(fixture.requests[index].body, "agent_status"))
      return { name: "agent_status", arguments: {} };
    if (tools.includes("delegate_task"))
      return { name: "delegate_task", arguments: { prompt: "Create another infographic" } };
    return undefined;
  });
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  await lastValueFrom(
    new ConversationAgent(server.agent.config, server.agent, "owner")
      .run(input("Crie um infográfico do jardim."))
      .pipe(toArray()),
  );
  assert.equal((await server.db.list("owner", "tasks")).length, 1);
  assert.deepEqual(offeredTools(fixture.requests[8].body), []);
  assert.equal(fixture.requests.length, 9);
});

test("research that only needs a written answer ends without a background job", async (t) => {
  const fixture = await modelFixture(t, (index) =>
    capabilityAvailable(fixture.requests[index].body, "agent_status")
      ? { name: "agent_status", arguments: {} }
      : undefined,
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  await lastValueFrom(
    new ConversationAgent(server.agent.config, server.agent, "owner")
      .run(input("Quais tarefas estão em andamento?"))
      .pipe(toArray()),
  );
  assert.equal((await server.db.list("owner", "tasks")).length, 0);
  assert.deepEqual(offeredTools(fixture.requests[8].body), ["delegate_task"]);
  assert.equal(fixture.requests.length, 9);
});

test("a failed delegation does not suppress the reserved handoff", async (t) => {
  const taskArgs = { kind: "agent", prompt: `Crie um infográfico: ${fact} Fonte: ${source}` };
  const fixture = await modelFixture(t, (index) => {
    const tools = offeredTools(fixture.requests[index].body);
    if (index === 0) return { name: "delegate_task", arguments: taskArgs };
    if (capabilityAvailable(fixture.requests[index].body, "web_fetch"))
      return { name: "web_fetch", arguments: { url: source } };
    if (tools.includes("delegate_task")) return { name: "delegate_task", arguments: taskArgs };
    return undefined;
  });
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const createTask = server.agent.createTask.bind(server.agent);
  let attempts = 0;
  t.mock.method(server.agent, "createTask", async (...args: Parameters<typeof createTask>) => {
    if (++attempts === 1) throw new Error("Temporary queue admission unavailable");
    return createTask(...args);
  });
  t.mock.method(server.agent.web, "read", async () => ({
    url: source,
    title: "Cuidados do jardim",
    text: fact,
    links: [],
    truncated: false,
  }));
  await lastValueFrom(
    new ConversationAgent(server.agent.config, server.agent, "owner")
      .run(input("Pesquise os cuidados e crie um infográfico sobre o jardim."))
      .pipe(toArray()),
  );
  assert.equal(attempts, 2);
  assert.equal((await server.db.list("owner", "tasks")).length, 1);
  assert.deepEqual(offeredTools(fixture.requests[8].body), ["delegate_task"]);
  assert.ok(fixture.requests[8].body.includes("Temporary queue admission unavailable"));
  assert.deepEqual(offeredTools(fixture.requests[9].body), []);
  assert.equal(fixture.requests.length, 10);
});

test("cancelling the last research call does not start the reserved handoff", {
  timeout: 10000,
}, async (t) => {
  const fixture = await modelFixture(t, (index) => {
    const tools = offeredTools(fixture.requests[index].body);
    if (capabilityAvailable(fixture.requests[index].body, "web_fetch"))
      return { name: "web_fetch", arguments: { url: source } };
    if (tools.includes("delegate_task"))
      return { name: "delegate_task", arguments: { prompt: "Create an infographic" } };
    return undefined;
  });
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  let entered!: () => void;
  let release!: () => void;
  let returned!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const receipt = new Promise<void>((resolve) => {
    release = resolve;
  });
  const finishedRead = new Promise<void>((resolve) => {
    returned = resolve;
  });
  let reads = 0;
  let lastSignal: AbortSignal | undefined;
  t.mock.method(server.agent.web, "read", async (_url: string, signal: AbortSignal) => {
    if (++reads === 8) {
      lastSignal = signal;
      entered();
      await receipt;
      returned();
    }
    return { url: source, title: "Cuidados do jardim", text: fact, links: [], truncated: false };
  });
  const subscription = new ConversationAgent(server.agent.config, server.agent, "owner")
    .run(input("Pesquise os cuidados e crie um infográfico sobre o jardim."))
    .subscribe();
  t.after(() => {
    release();
    subscription.unsubscribe();
  });
  await started;
  subscription.unsubscribe();
  assert.equal(lastSignal?.aborted, true);
  release();
  await finishedRead;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reads, 8);
  assert.equal(fixture.requests.length, 8);
  assert.equal((await server.db.list("owner", "tasks")).length, 0);
});
