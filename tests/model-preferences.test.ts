import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hono } from "hono";
import { lastValueFrom, toArray } from "rxjs";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { AppError } from "../apps/server/src/errors.ts";
import { discoverSubscriptionModels } from "../apps/server/src/providers/catalog.ts";
import { modelProviderConfig } from "../apps/server/src/providers/config.ts";
import {
  modelPreferenceRoutes,
  modelPreferences,
  modelSelection,
} from "../apps/server/src/providers/preferences.ts";
import { modelFixture, richChatFixtureProviders } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("owner model choice persists, changes actual primary route and retains explicit fallbacks", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const config = {
    dataDir: "/tmp/model-preferences-unused",
    model: "local/default",
    modelFallbacks: ["local/secondary"],
    modelProviders: modelProviderConfig("/tmp/model-preferences-unused", {}),
  } as Config;
  const app = new Hono<{ Variables: { owner: string } }>();
  app.use("*", async (c, next) => {
    c.set("owner", "owner");
    await next();
  });
  app.onError(
    (error) =>
      new Response("Invalid model", { status: error instanceof AppError ? error.status : 500 }),
  );
  app.route("/api", modelPreferenceRoutes(db, config));
  assert.equal((await modelSelection(db, config, "owner")).model, "local/default");
  const response = await app.request("/api/models/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "local/secondary" }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).selected, "local/secondary");
  assert.deepEqual(await modelSelection(db, config, "owner"), {
    model: "local/secondary",
    fallbacks: ["local/default"],
  });
  assert.equal((await modelSelection(db, config, "another-owner")).model, "local/default");
  const bad = await app.request("/api/models/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "grok/invented-model" }),
  });
  assert.equal(bad.status, 422);
  assert.equal((await modelPreferences(db, config, "owner")).selected, "local/secondary");
  const reset = await app.request("/api/models/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: null }),
  });
  assert.equal(reset.status, 200);
  assert.equal((await modelSelection(db, config, "owner")).model, "local/default");
});

test("connected subscription catalogs expose text model metadata without keys or non-chat generators", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "okami-catalog-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const providers = modelProviderConfig(dir, {});
  await writeFile(join(dir, "chatgpt.json"), "fixture");
  await writeFile(join(dir, "grok.json"), "fixture");
  providers.chatgptFile = join(dir, "chatgpt.json");
  providers.grokFile = join(dir, "grok.json");
  const canary = "secret-subscription-token-canary";
  const calls: string[] = [];
  const catalog = await discoverSubscriptionModels(providers, {
    token: async () => canary,
    fetch: async (url, init) => {
      calls.push(String(url));
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${canary}`);
      return Response.json(
        String(url).includes("openai")
          ? {
              models: [
                {
                  slug: "gpt-fixture",
                  display_name: "ChatGPT fixture",
                  visibility: "list",
                  context_window: 272000,
                  input_modalities: ["text", "image"],
                },
                { slug: "gpt-hidden", visibility: "hidden" },
                { slug: "gpt-image-1", visibility: "list" },
              ],
            }
          : { data: [{ id: "grok-fixture" }, { id: "grok-imagine-image" }, { id: "../bad" }] },
      );
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(catalog.models.map((model) => model.id).sort(), [
    "chatgpt/gpt-fixture",
    "grok/grok-fixture",
  ]);
  assert.equal(JSON.stringify(catalog).includes(canary), false);
  assert.equal(
    catalog.providers.every((provider) => provider.status === "available"),
    true,
  );
  const failed = await discoverSubscriptionModels(providers, {
    token: async () => canary,
    fetch: async () => new Response(canary, { status: 401 }),
  });
  assert.equal(failed.models.length, 0);
  assert.equal(JSON.stringify(failed).includes(canary), false);
  assert.equal(
    failed.providers.every((provider) => provider.status === "unavailable"),
    true,
  );
});

test("saved model selection reaches actual chat and task adapter dispatch", async (t) => {
  let phase: "chat" | "task" = "chat";
  const { requests } = await modelFixture(
    t,
    () =>
      phase === "task"
        ? { name: "finish_task", arguments: { summary: "A resposta solicitada foi entregue." } }
        : undefined,
    { text: () => "Olá!" },
  );
  const server = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    modelFallbacks: [],
    modelProviders: richChatFixtureProviders("/tmp/selection-runtime", ["openai/fixture"]),
  });
  const routing = server.agent.config.modelProviders?.routing;
  assert.ok(routing);
  routing.capabilities["openai/fixture"].contextTokens = 4096;
  await server.db.put("owner", "settings", {
    id: "model-catalog",
    checkedAt: new Date().toISOString(),
    providers: [],
    models: [
      {
        id: "openai/selected",
        label: "Selected",
        provider: "openai",
        capabilities: {
          tools: true,
          vision: false,
          structuredOutput: true,
          contextTokens: 131072,
        },
      },
    ],
  });
  await server.db.put("owner", "settings", {
    id: "model",
    model: "openai/selected",
    updatedAt: new Date().toISOString(),
  });
  const conversation = new ConversationAgent(server.agent.config, server.agent, "owner");
  const events = await lastValueFrom(
    conversation
      .run({
        threadId: randomUUID(),
        runId: randomUUID(),
        state: {},
        tools: [],
        context: [],
        messages: [{ id: randomUUID(), role: "user", content: "Diga olá" }],
      })
      .pipe(toArray()),
  );
  assert.ok(!events.some((event) => event.type === "RUN_ERROR"), JSON.stringify(events));
  assert.ok(requests.length > 0);
  assert.equal(JSON.parse(requests[0].body).model, "selected");
  phase = "task";
  requests.length = 0;
  const task = await server.agent.createTask("owner", {
    prompt: "Escreva uma saudação curta",
    kind: "agent",
  });
  await server.agent.worker.tick();
  assert.ok(requests.length > 0);
  assert.equal(JSON.parse(requests[0].body).model, "selected");
  const completed = await server.agent.getTask("owner", task.id);
  assert.equal(completed.result, "A resposta solicitada foi entregue.");
});
