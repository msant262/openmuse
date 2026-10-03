import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@ag-ui/core";
import {
  ContextBudget,
  type ContextModelResolver,
} from "../apps/server/src/engine/context-budget.ts";
import { tanstackAgent } from "../apps/server/src/engine/tanstack-agent.ts";
import { modelProviderConfig } from "../apps/server/src/providers/config.ts";
import { sharedModelRouter } from "../apps/server/src/providers/model-router.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

for (const preflight of [false, true])
  test(`M10 budgets to actual ${preflight ? "preflight" : "declared"} fallback capacity and real M5 selects it after 503`, async (t) => {
    const model = await modelFixture(t, () => undefined, {
      errorStatus: (index) => (index === 0 ? 503 : undefined),
    });
    const models = ["openai/primary", "openai/fallback", "openai/incapable"];
    const providers = modelProviderConfig("/tmp/m10-capacity-proof", {
      ...process.env,
      MODEL_CAPABILITIES: JSON.stringify({
        "openai/primary": {
          tools: true,
          vision: false,
          structuredOutput: true,
          contextTokens: 65536,
        },
        "openai/fallback": {
          tools: true,
          vision: false,
          structuredOutput: true,
          contextTokens: 12000,
        },
        "openai/incapable": {
          tools: false,
          vision: false,
          structuredOutput: false,
          contextTokens: 512,
        },
      }),
    });
    const router = sharedModelRouter(providers);
    router.register(models);
    if (preflight)
      router.confirmCapabilities("openai/fallback", {
        tools: true,
        vision: false,
        structuredOutput: true,
        contextTokens: 8000,
      });
    const actualCapacity = preflight ? 8000 : 12000;
    let resolvedCapacity = 0;
    const server = await taskRuntime(t, {
      model: models[0],
      modelFallbacks: models.slice(1),
      modelProviders: providers,
    });
    const contextModel: ContextModelResolver = (requirements) => {
      const resolved = server.agent.contextModel?.(requirements);
      assert.ok(resolved);
      resolvedCapacity = resolved.contextTokens;
      return resolved;
    };
    const messages: Message[] = [
      ...Array.from(
        { length: 50 },
        (_, i): Message => ({
          id: `old${i}`,
          role: i % 2 ? "assistant" : "user",
          content: `old${i} ${"historical source ".repeat(100)}`,
        }),
      ),
      { id: "current", role: "user", content: "Answer this request" },
    ];
    const selected: string[] = [];
    const agent = tanstackAgent({
      model: models[0],
      fallbacks: models.slice(1),
      providers,
      modelRouter: router,
      contextModel,
      workClass: "interactive",
      onModelSelected: (model) => selected.push(model.model),
      tools: [],
      prompt: "Follow the current user",
      maxSteps: 1,
    });
    agent.threadId = "capacity";
    agent.setMessages(messages);
    await agent.runAgent({ runId: `proof-${preflight}` });
    assert.equal(resolvedCapacity, actualCapacity);
    assert.equal(model.requests.length, 2);
    assert.match(model.requests[0].body, /primary/);
    assert.match(model.requests[1].body, /fallback/);
    assert.ok(model.requests.every((request) => Buffer.byteLength(request.body) < actualCapacity));
    assert.deepEqual(selected, ["fallback"]);
    assert.equal(router.status().active?.model, "fallback");
    assert.ok(
      agent.messages.some((message) => message.id === "old0"),
      "canonical history is not trimmed",
    );
    assert.ok(
      model.requests.every((request) => !request.body.includes("old0 ")),
      "bounded context is used for both actual attempts",
    );
    assert.equal(
      ContextBudget.requiresVision([
        { role: "tool", content: '{"browserScreenshot":true,"screenshotId":"fixture"}' },
      ]),
      true,
    );
  });

import type { ModelMessage } from "@tanstack/ai";
// Actual M5 admission after the actual shared browser/file hydrator, including long metadata.
import { browserImageMessages } from "../apps/server/src/providers/browser-images.ts";
import { requestRequirements } from "../apps/server/src/providers/model-capabilities.ts";

for (const file of [false, true])
  test(`M10 long ${file ? "file" : "browser"} image metadata fits actual M5 requestRequirements plus output reserve`, async () => {
    const receipt = JSON.stringify({
      ...(file
        ? { fileImage: true, fileId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }
        : { browserScreenshot: true, screenshotId: "a".repeat(64) }),
      title: "Long page title ".repeat(350),
      url: `https://example.com/${"path/".repeat(500)}`,
      mimeType: "image/jpeg",
      width: 1280,
      height: 800,
    });
    const messages: ModelMessage[] = [
      {
        id: "call",
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "image-op", type: "function", function: { name: "observe", arguments: "{}" } },
        ],
      },
      { id: "result", role: "tool", toolCallId: "image-op", content: receipt },
      { id: "user", role: "user", content: "Summarize this page" },
    ];
    const model = {
      id: "vision",
      contextTokens: 30000,
      outputReserveTokens: 1024,
      imageContextTokens: 8192,
    };
    const options = { model, requiredOperationIds: ["image-op"], systemPrompts: [], tools: [] };
    const previousEstimate =
      Buffer.byteLength(JSON.stringify({ messages, prompts: [], tools: [] })) +
      model.imageContextTokens +
      1024;
    model.contextTokens = previousEstimate + model.outputReserveTokens;
    assert.throws(() => ContextBudget.limit(messages, options), /CONTEXT_REQUIRED_TOO_LARGE/);
    model.contextTokens = ContextBudget.cost(messages, options) + model.outputReserveTokens;
    const selected = ContextBudget.limit(messages, options);
    const image = async () => ({
      type: "image" as const,
      source: { type: "data" as const, value: "fixture", mimeType: "image/jpeg" },
    });
    const hydrated = await browserImageMessages(selected, image, image);
    const actual = requestRequirements(
      { messages: hydrated, systemPrompts: [], tools: [] } as unknown as Parameters<
        typeof requestRequirements
      >[0],
      {},
      model.imageContextTokens,
    );
    assert.equal(actual.vision, true);
    assert.equal(actual.contextTokens, ContextBudget.cost(selected, options));
    assert.ok(actual.contextTokens + model.outputReserveTokens <= model.contextTokens);
    assert.equal(selected.length, 3);
    assert.equal(messages[1].content, receipt);
  });

test("mandatory context excludes an undersized fallback without blocking a capable primary", async (t) => {
  const fixture = await modelFixture(t, () => undefined);
  const providers = modelProviderConfig("/tmp/okami-m10-required-capacity", {
    ...process.env,
    MODEL_CAPABILITIES: JSON.stringify({
      "openai/large": { tools: true, vision: false, structuredOutput: true, contextTokens: 65536 },
      "openai/tiny": { tools: true, vision: false, structuredOutput: true, contextTokens: 8000 },
    }),
  });
  const server = await taskRuntime(t, {
    model: "openai/large",
    modelFallbacks: ["openai/tiny"],
    modelProviders: providers,
  });
  const agent = tanstackAgent({
    model: "openai/large",
    fallbacks: ["openai/tiny"],
    providers,
    contextModel: server.agent.contextModel,
    requiredOperationIds: async () => ["saved-effect"],
    prompt: "Use the exact completed receipt",
    tools: [],
    maxSteps: 1,
  });
  agent.threadId = "required-capacity";
  const receipt = JSON.stringify({
    status: "succeeded",
    reference: "retained-" + "r".repeat(10000),
  });
  agent.setMessages([
    {
      id: "call",
      role: "assistant",
      toolCalls: [
        {
          id: "saved-effect",
          type: "function",
          function: { name: "save_external", arguments: "{}" },
        },
      ],
    },
    { id: "receipt", role: "tool", toolCallId: "saved-effect", content: receipt },
    ...Array.from(
      { length: 60 },
      (_, index): Message => ({
        id: `history-${index}`,
        role: "assistant",
        content: "old context ".repeat(1000),
      }),
    ),
    {
      id: "current",
      role: "user",
      content: "Confirm the saved reference without repeating the operation",
    },
  ]);
  await agent.runAgent({ runId: "required-capacity-run" });
  assert.equal(fixture.requests.length, 1);
  assert.match(fixture.requests[0].body, /large/);
  assert.ok(fixture.requests[0].body.includes("retained-" + "r".repeat(10000)));
  assert.ok(!fixture.requests[0].body.includes("history-0"));
  assert.ok(agent.messages.some((message) => message.id === "history-0"));
});

test("insufficient mandatory context parks the actual task and resumes after verified capacity changes", async (t) => {
  const fixture = await modelFixture(t, () => ({
    name: "ask_user",
    arguments: { question: "Which destination?" },
  }));
  const providers = modelProviderConfig("/tmp/okami-m10-capacity-recovery", {
    ...process.env,
    MODEL_CAPABILITIES: JSON.stringify({
      "openai/fixture": {
        tools: true,
        vision: false,
        structuredOutput: true,
        contextTokens: 8000,
      },
    }),
  });
  const server = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    modelProviders: providers,
  });
  const task = await server.agent.createTask("owner", { prompt: "Prepare the requested journey" });
  await server.agent.worker.tick();
  const waiting = await server.agent.getTask("owner", task.id);
  assert.equal(waiting.status, "waiting_provider", waiting.error ?? waiting.question);
  assert.equal(fixture.requests.length, 0);
  assert.equal(
    (waiting.state.providerCheckpoint as { code: string }).code,
    "MODEL_CAPABILITY_UNAVAILABLE",
  );
  sharedModelRouter(providers).confirmCapabilities("openai/fixture", {
    tools: true,
    vision: false,
    structuredOutput: true,
    contextTokens: 131072,
  });
  await server.agent.actor.wake("owner", task.id, "provider");
  await server.agent.worker.tick();
  const resumed = await server.agent.getTask("owner", task.id);
  assert.equal(resumed.status, "waiting_input", resumed.error ?? resumed.question);
  assert.equal(resumed.question, "Which destination?");
  assert.equal(fixture.requests.length, 1);
});

for (const stale of [false, true])
  test(`actual provider projection ${stale ? "expires" : "hydrates"} desktop capture without changing canonical evidence`, async (t) => {
    const fixture = await modelFixture(t, () => undefined);
    const providers = modelProviderConfig(`/tmp/m10-observation-${stale}`, {
      ...process.env,
      MODEL_CAPABILITIES: JSON.stringify({
        "openai/fixture": {
          tools: true,
          vision: !stale,
          structuredOutput: true,
          contextTokens: 65536,
        },
      }),
    });
    const runtime = await taskRuntime(t, { model: "openai/fixture", modelProviders: providers });
    const screenshotId = "a".repeat(64);
    const receipt = JSON.stringify({
      sessionId: "native-session",
      sessionGeneration: 2,
      executorEpoch: 3,
      frameId: "frame",
      width: 640,
      height: 360,
      sequence: 1,
      observedAt: new Date(Date.now() - (stale ? 360000 : 1000)).toISOString(),
      imageHash: screenshotId,
      imageUnchanged: false,
      mimeType: "image/png",
      screenshotId,
      browserScreenshot: true,
      desktopScreenshot: true,
      imageBytes: 128,
      imageInput: "vision-required",
    });
    let loads = 0;
    const agent = tanstackAgent({
      model: "openai/fixture",
      providers,
      contextModel: runtime.agent.contextModel,
      requiredOperationIds: async () => ["capture"],
      tools: [],
      prompt: "Describe only current observations",
      maxSteps: 1,
      loadBrowserImage: async (id) => {
        assert.equal(id, screenshotId);
        loads++;
        return { type: "image", source: { type: "data", value: "fixture", mimeType: "image/png" } };
      },
    });
    agent.threadId = `capture-${stale}`;
    agent.setMessages([
      {
        id: "observe-call",
        role: "assistant",
        toolCalls: [
          {
            id: "capture",
            type: "function",
            function: { name: "desktop_observe", arguments: "{}" },
          },
        ],
      },
      { id: "observe-result", role: "tool", toolCallId: "capture", content: receipt },
      { id: "now", role: "user", content: "What is visible?" },
    ]);
    await agent.runAgent({ runId: `capture-run-${stale}` });
    assert.equal(fixture.requests.length, 1);
    assert.equal(loads, stale ? 0 : 1);
    assert.ok(fixture.requests[0].body.includes(screenshotId));
    assert.equal(
      fixture.requests[0].body.includes("Obsolete observation retained for audit"),
      stale,
    );
    assert.equal(
      agent.messages.find((message) => message.id === "observe-result")?.content,
      receipt,
    );
  });

test("only trusted desktop tool receipts expire; toolCallId also works without message ids", () => {
  const content = JSON.stringify({
    browserScreenshot: true,
    desktopScreenshot: true,
    screenshotId: "b".repeat(64),
    observedAt: "2020-01-01T00:00:00.000Z",
  });
  const messages: ModelMessage[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "op", type: "function", function: { name: "desktop_observe", arguments: "{}" } },
      ],
    },
    { role: "tool", toolCallId: "op", content },
    { role: "user", content: "Inspect again" },
  ];
  assert.equal(ContextBudget.currentVision(messages), false);
  const result = ContextBudget.limit(messages, {
    model: { id: "text", contextTokens: 32768 },
    requiredOperationIds: ["op"],
  });
  assert.match(String(result[1].content), /Obsolete observation/);
  const upload = { role: "user" as const, content };
  assert.equal(ContextBudget.currentVision([upload]), true);
  const external = structuredClone(messages);
  external[0].toolCalls![0].function.name = "read_external";
  assert.equal(ContextBudget.currentVision(external), true);
});
