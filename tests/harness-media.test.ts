import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import { MediaService } from "../apps/server/src/media-tools.ts";
import { modelProviderConfig } from "../apps/server/src/providers/config.ts";
import { writeProtected } from "../apps/server/src/providers/credential-store.ts";
import { LocalThreads } from "../apps/server/src/threads.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=",
  "base64",
);

test("image publication accepts native harness call identities without repeating generation", async (t) => {
  const server = await taskRuntime(t);
  const config = {
    ...server.agent.config,
    modelProviders: modelProviderConfig(server.directory, {}),
  };
  await writeProtected(config.modelProviders.grokFile, {
    version: 1,
    provider: "grok",
    token_endpoint: "https://auth.x.ai/oauth2/token",
    access_token: "fixture-token",
    refresh_token: "fixture-refresh",
    token_type: "Bearer",
    expires_in: 3600,
    saved_at: new Date().toISOString(),
  });
  let generations = 0;
  const media = new MediaService(server.db, server.files, config, async () => {
    generations++;
    return Response.json({ data: [{ b64_json: png.toString("base64") }] });
  });
  const task = await server.agent.createTask(
    "owner",
    { prompt: "Crie um infográfico" },
    "durable-chat-admission",
  );
  const args = { prompt: "A verified infographic", operationId: "map" };
  const worker = new TaskWorker(server.db, async (owner, running) => {
    const call = {
      id: "f3d00769-256b-4a6a-a1c3-bc4a828467ef:tool_call:call_VjGS2rhWUEFAKuDMG8BcoFFZ:okami_generate_image:14",
      name: "generate_image",
      args,
    };
    const generate = () =>
      server.agent.journal.run(
        owner,
        running,
        call,
        () => media.generatedImage(owner, "chatgpt/fixture", args, running.id),
        true,
      );
    const file = (await generate()) as { fileId: string };
    assert.deepEqual(await server.files.bytes(owner, file.fileId), png);
    assert.deepEqual(await generate(), file);
    return { status: "succeeded", artifactIds: [file.fileId] };
  });
  t.after(() => worker.stop());
  await worker.tick();
  const saved = await server.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question);
  assert.equal(generations, 1);
  const operations = await server.agent.journal.operations("owner", task.id);
  assert.ok(operations.some((op) => op.toolName === "primitive.generate_image"));
  assert.ok(operations.every((op) => op.id.length <= 256 && op.status === "succeeded"));
});

test("an infographic mislabelled document stays a generic creation task with image delivery criteria", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", {
    kind: "document",
    prompt: "Crie um infográfico sobre as eleições",
    title: "Infográfico",
  });
  assert.equal(task.kind, "agent");
  assert.ok(task.criteria?.some((item) => item.id === "requested-image"));
  assert.ok(
    !task.criteria?.some((item) => item.id === "filled-document" || item.id === "requested-send"),
  );
  assert.ok(!task.plan.some((step) => /reply|source document/i.test(step.title)));
  const form = await server.agent.createTask("owner", {
    kind: "document",
    prompt: "Preencha e responda o formulário",
    input: { messageId: "selected-email" },
  });
  assert.equal(form.kind, "document");
  assert.ok(form.criteria?.some((item) => item.id === "filled-document"));
});

test("a text claim cannot complete an infographic without its generated image", async (t) => {
  await modelFixture(t, () => ({
    name: "finish_task",
    arguments: { summary: "Criei o infográfico solicitado." },
  }));
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await server.agent.createTask("owner", {
    prompt: "Crie um infográfico visual",
    kind: "document",
  });
  await server.agent.worker.tick();
  const saved = await server.agent.getTask("owner", task.id);
  assert.equal(saved.status, "failed");
  assert.equal(saved.completion?.status, "unverified");
  assert.deepEqual(saved.artifactIds, []);
  assert.equal((await server.db.list("owner", "interaction-requests")).length, 0);
});

test("connected Grok image generation works while chatting with ChatGPT and never calls a billed fallback", async (t) => {
  const server = await taskRuntime(t);
  const config = {
    ...server.agent.config,
    modelProviders: modelProviderConfig(server.directory, {}),
  };
  await writeProtected(config.modelProviders.grokFile, {
    version: 1,
    provider: "grok",
    token_endpoint: "https://auth.x.ai/oauth2/token",
    access_token: "test-subscription-token",
    refresh_token: "test-refresh-token",
    token_type: "Bearer",
    expires_in: 3600,
    saved_at: new Date().toISOString(),
  });
  let calls = 0;
  const media = new MediaService(server.db, server.files, config, async (input, init) => {
    calls++;
    assert.equal(String(input), "https://api.x.ai/v1/images/generations");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-subscription-token");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "grok-imagine-image-2.0");
    assert.equal(body.prompt, "A clean infographic, Portuguese labels, verified data");
    return Response.json({ data: [{ b64_json: png.toString("base64") }] });
  });
  assert.deepEqual((await media.imageCapabilities("chatgpt/gpt-5.4")).providers, [
    {
      provider: "grok",
      model: "grok-imagine-image-2.0",
      subscription: true,
    },
  ]);
  const args = {
    prompt: "A clean infographic, Portuguese labels, verified data",
    name: "Infográfico",
    operationId: "once",
  };
  const result = await media.generatedImage("owner", "chatgpt/gpt-5.4", args, "test");
  assert.ok("fileId" in result);
  assert.match(result.name, /^Infográfico-/);
  assert.deepEqual(await server.files.bytes("owner", result.fileId), png);
  assert.deepEqual(
    await media.generatedImage("owner", "chatgpt/another-model", args, "test"),
    result,
  );
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(result).includes("token"));
});

test("a legacy misclassified infographic recovers into the general agent and publishes its image in the originating chat", async (t) => {
  await modelFixture(
    t,
    (index) =>
      [
        {
          name: "generate_image",
          arguments: {
            prompt: "Infográfico sobre um jardim",
            name: "Jardim",
            operationId: "garden",
          },
        },
        { name: "finish_task", arguments: { summary: "O infográfico está pronto e anexado." } },
      ][index],
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  assert.ok(server.threads instanceof LocalThreads);
  server.agent.config.modelProviders!.routing!.capabilities["openai/fixture"].vision = true;
  await server.threads.ensure("owner", "image-chat");
  t.mock.method(server.agent.media, "generatedImage", async () => {
    const file = await server.files.importAttachment(
      "owner",
      "Jardim.png",
      png,
      "Generated image",
      "image/png",
    );
    return server.files.reference("owner", file.id);
  });
  const task = await server.agent.createTask("owner", {
    prompt: "Crie um infográfico sobre um jardim",
    originThreadId: "image-chat",
  });
  await server.db.compareAndSwap(
    "owner",
    "tasks",
    task.id,
    {},
    {
      kind: "document",
      criteria: [
        {
          id: "filled-document",
          kind: "file",
          description: "Old PDF criterion",
          format: "application/pdf",
          requiredItems: [],
        },
      ],
    },
  );
  await server.agent.worker.tick();
  const saved = await server.agent.getTask("owner", task.id);
  assert.equal(saved.kind, "agent");
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question ?? undefined);
  assert.equal(saved.completion?.status, "verified");
  assert.equal(saved.artifactIds.length, 1);
  const file = await server.files.get("owner", saved.artifactIds[0]);
  assert.equal(file.mimeType, "image/png");
  const publication = await server.db.get("owner", "thread-publications", `task:${task.id}`);
  assert.equal(publication?.threadId, "image-chat");
  assert.equal(publication?.status, "posted");
});

test("background failures publish their actual failure in chat even when no result was produced", async (t) => {
  const server = await taskRuntime(t);
  assert.ok(server.threads instanceof LocalThreads);
  await server.threads.ensure("owner", "failed-chat");
  const task = await server.agent.createTask("owner", {
    kind: "document",
    title: "Selected form",
    prompt: "Fill this existing form",
    input: { messageId: "missing-email" },
    originThreadId: "failed-chat",
  });
  await server.agent.worker.tick();
  const saved = await server.agent.getTask("owner", task.id);
  assert.equal(saved.status, "failed");
  assert.ok(saved.error);
  assert.equal(saved.result, undefined);
  const publications = await server.db.list<{ taskId: string; text: string; status: string }>(
    "owner",
    "thread-publications",
  );
  assert.equal(publications.length, 1);
  assert.equal(publications[0].taskId, task.id);
  assert.ok(publications[0].text.includes(saved.error));
  assert.equal(publications[0].status, "posted");
});

test("read-only computer status answers in the current chat without creating a background task", async (t) => {
  const { lastValueFrom, toArray } = await import("rxjs");
  const { ConversationAgent } = await import("../apps/server/src/engine/conversation.ts");
  await modelFixture(t, (index) =>
    index === 0 ? { name: "computer_status", arguments: {} } : undefined,
  );
  const server = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    computerEnabled: false,
  });
  const agent = new ConversationAgent(server.agent.config, server.agent, "owner");
  const events = await lastValueFrom(
    agent
      .run({
        threadId: "status-chat",
        runId: "status-run",
        messages: [{ id: "status-user", role: "user", content: "O computador está conectado?" }],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  const receipt = events.find((event) => event.type === "TOOL_CALL_RESULT");
  assert.ok(receipt && "content" in receipt);
  const value = JSON.parse(String(receipt.content));
  assert.equal(value.enabled, false);
  assert.equal(value.status, "unconfigured");
  assert.equal(value.taskId, undefined);
  assert.deepEqual(await server.db.list("owner", "tasks"), []);
  assert.ok(!events.some((event) => event.type === "RUN_ERROR"));
});
