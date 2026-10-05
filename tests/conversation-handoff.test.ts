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

test("research is handed off immediately and the worker delivers the requested image", async (t) => {
  const fixture = await modelFixture(
    t,
    (index) => {
      const tools = offeredTools(fixture.requests[index].body);
      if (index >= 2)
        return index === 2
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
  assert.equal(reads, 0, "foreground must not research before starting the worker");
  assert.equal(fixture.requests.length, 2);
  assert.ok(offeredTools(fixture.requests[0].body).includes("delegate_task"));
  assert.deepEqual(offeredTools(fixture.requests[1].body), [
    "react_to_message",
    "send_sticker",
    "search_gifs",
    "send_gif",
    "reply_to_message",
  ]);
  assert.match(fixture.requests[0].body, /SOUL/);
  assert.ok(fixture.requests[1].body.includes("Criar infográfico do jardim"));
  assert.ok(
    !fixture.requests[1].body.includes(fact),
    "the acknowledgment must not reuse an unverified delegated brief as findings",
  );
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
    if (index === 0)
      return { name: "delegate_task", arguments: { kind: "agent", prompt: imageArgs.prompt } };
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
  assert.deepEqual(offeredTools(fixture.requests[1].body), [
    "react_to_message",
    "send_sticker",
    "search_gifs",
    "send_gif",
    "reply_to_message",
  ]);
  assert.equal(fixture.requests.length, 2);
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
  assert.ok(offeredTools(fixture.requests[1].body).includes("delegate_task"));
  assert.ok(fixture.requests[1].body.includes("Temporary queue admission unavailable"));
  assert.deepEqual(offeredTools(fixture.requests[2].body), [
    "react_to_message",
    "send_sticker",
    "search_gifs",
    "send_gif",
    "reply_to_message",
  ]);
  assert.equal(fixture.requests.length, 3);
});

test("cancelling a pending chat inference does not create a late background job", {
  timeout: 10000,
}, async (t) => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await modelFixture(t, async () => {
    entered();
    await pending;
    return { name: "delegate_task", arguments: { kind: "agent", prompt: "Create an infographic" } };
  });
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const subscription = new ConversationAgent(server.agent.config, server.agent, "owner")
    .run(input("Pesquise os cuidados e crie um infográfico sobre o jardim."))
    .subscribe();
  t.after(() => {
    release();
    subscription.unsubscribe();
  });
  await started;
  subscription.unsubscribe();
  release();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fixture.requests.length, 1);
  assert.equal((await server.db.list("owner", "tasks")).length, 0);
});

test("each foreground reply follows its owner's SOUL and conversation override without leaking reactions", async (t) => {
  const fixture = await modelFixture(t, () => undefined, { text: () => "Fixture reply" });
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  for (const [owner, patch] of [
    [
      "ana",
      {
        personality: "Paciente, afetuosa, explica com exemplos",
        responseLength: "detailed",
        tone: "warm",
        emojis: true,
      },
    ],
    [
      "bia",
      {
        personality: "Formal, direta, sem brincadeiras",
        responseLength: "concise",
        tone: "concise",
        emojis: false,
      },
    ],
  ] as const)
    await server.agent.profiles.update(owner, {
      scope: { kind: "global" },
      requestId: "profile",
      expectedRevision: 0,
      origin: { kind: "settings" },
      patch,
    });
  assert.ok(server.threads instanceof LocalThreads);
  await server.threads.ensure("ana", "research-image-chat");
  await server.agent.profiles.update("ana", {
    scope: { kind: "conversation", threadId: "research-image-chat" },
    requestId: "override",
    expectedRevision: 0,
    origin: { kind: "settings" },
    patch: { responseLength: "concise" },
  });
  await server.db.put("ana", "message-reactions", {
    id: "reaction",
    threadId: "research-image-chat",
    messageId: "request-image",
    actor: "user",
    emoji: "❤️",
  });
  for (const owner of ["ana", "bia"])
    await lastValueFrom(
      new ConversationAgent(server.agent.config, server.agent, owner)
        .run(input("Como vai?"))
        .pipe(toArray()),
    );
  assert.match(fixture.requests[0].body, /Paciente, afetuosa/);
  assert.match(fixture.requests[0].body, /❤️/);
  assert.ok(fixture.requests[0].body.includes('\\"responseLength\\":\\"concise\\"'));
  assert.match(fixture.requests[1].body, /Formal, direta/);
  assert.doesNotMatch(fixture.requests[1].body, /Paciente, afetuosa/);
  assert.ok(fixture.requests[1].body.includes('\\"emojis\\":false'));
  assert.ok(fixture.requests[1].body.includes('\\"reactions\\":[]'));
  for (const request of fixture.requests) {
    assert.match(request.body, /SOUL/);
    assert.match(request.body, /react_to_message/);
    assert.match(request.body, /reply_to_message/);
    assert.match(request.body, /send_sticker/);
  }
  assert.equal((await server.agent.profiles.get("ana")).fields.responseLength, "detailed");
  assert.equal((await server.db.list("bia", "tasks")).length, 0);
});
