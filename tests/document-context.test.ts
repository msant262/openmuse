import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { EventType } from "@ag-ui/core";
import type { ModelMessage } from "@tanstack/ai";
import { lastValueFrom, toArray } from "rxjs";
import { ContextBudget } from "../apps/server/src/engine/context-budget.ts";
import { tanstackAgent } from "../apps/server/src/engine/tanstack-agent.ts";
import {
  type modelHistory,
  providerContinuationCheckpointSchema,
  publicToolArguments,
} from "../apps/server/src/engine/task-history.ts";
import { ToolOutputStore } from "../apps/server/src/engine/tool-output.ts";
import { ModelRouter, sharedModelRouter } from "../apps/server/src/providers/model-router.ts";
import { modelFixture, richChatFixtureProviders } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const file = (character: string) => character.repeat(64);

test("a rejected document preflight keeps its exact repairable arguments without claiming a rendered file", () => {
  const messages = creation(
    "actual-brief-id",
    file("a"),
    "Observed facts and one incorrect source URL",
    undefined,
    {
      attachment: false,
      rendered: false,
      repairable: true,
      missing: ["Correct the source URL"],
      nextSteps: ["Use the returned canonical source URL"],
      needsMoreResearch: false,
    },
  );
  const store = new ToolOutputStore();
  store.observe(messages);
  assert.equal(
    store.read({
      toolCallId: "actual-brief-id",
      part: "arguments",
      pointer: "/content",
      offset: 0,
      limit: 100,
    }).content,
    "Observed facts and one incorrect source URL",
  );
  assert.deepEqual(
    store.project(messages, ["actual-brief-id"]),
    messages,
    "a preflight rejection is not a successful artifact or a replacement",
  );
  const unknown = store.readTool({
    toolCallId: "call_9",
    part: "arguments",
    offset: 0,
    limit: 100,
  });
  assert.ok("availableReferences" in unknown);
  assert.deepEqual(unknown.availableReferences, [
    { toolCallId: "actual-brief-id", tool: "create_document", part: "arguments" },
  ]);
  assert.ok(
    !JSON.stringify(unknown).includes("incorrect source URL"),
    "reference lists never include source bodies",
  );
  const other = new ToolOutputStore().readTool({
    toolCallId: "actual-brief-id",
    part: "arguments",
    offset: 0,
    limit: 100,
  });
  assert.ok("availableReferences" in other);
  assert.deepEqual(other.availableReferences, [], "another run does not inherit these references");
});
function creation(
  id: string,
  fileId: string,
  content: string,
  replaceFileId?: string,
  result?: unknown,
): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id,
          type: "function",
          function: {
            name: "create_document",
            arguments: JSON.stringify({
              name: "guide",
              format: "pptx",
              operationId: `write-${id}`,
              content,
              ...(replaceFileId && { replaceFileId }),
            }),
          },
        },
      ],
    },
    {
      role: "tool",
      toolCallId: id,
      content: JSON.stringify(
        result ?? {
          fileId,
          attachment: true,
          mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          ...(replaceFileId && { replacesFileId: replaceFileId }),
        },
      ),
    },
  ];
}

test("only a confirmed replacement compacts historical authoring source while receipts and current content stay exact", () => {
  const source = "Original authoring source. ".repeat(500);
  const messages: ModelMessage[] = [
    ...creation("old", file("a"), source),
    ...creation("current", file("b"), "Current full content", file("a")),
  ];
  const before = JSON.stringify(messages);
  const output = new ToolOutputStore();
  output.observe(messages);
  const projected = output.project(messages, ["old", "current"]);
  const argumentsText = projected[0].toolCalls?.[0].function.arguments ?? "";
  assert.ok(argumentsText.length < 1500);
  assert.match(argumentsText, new RegExp(createHash("sha256").update(source).digest("hex")));
  assert.match(argumentsText, /read_tool_output/);
  assert.deepEqual(
    projected.slice(1),
    messages.slice(1),
    "exact effect receipts and latest draft remain available",
  );
  assert.equal(JSON.stringify(messages), before, "the canonical transcript must not change");
  assert.deepEqual(
    output.project(projected, ["old", "current"]),
    projected,
    "projection is idempotent",
  );
  let recovered = "",
    offset = 0;
  for (;;) {
    const page = output.read({ toolCallId: "old", part: "arguments", offset, limit: 777 });
    recovered += page.content;
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  assert.equal(recovered, messages[0].toolCalls?.[0].function.arguments);
  assert.throws(
    () =>
      new ToolOutputStore().read({ toolCallId: "old", part: "arguments", offset: 0, limit: 100 }),
    /unavailable/,
  );
});

test("requests, failed replacements, unrelated files and other effects cannot authorize source omission or argument reads", () => {
  const original = creation("old", file("a"), "Private authored body. ".repeat(200));
  const failed = creation("failed", file("b"), "Replacement", file("a"), {
    error: "Not dispatched",
  });
  const unrelated = creation("another", file("c"), "Independent deliverable");
  const messages: ModelMessage[] = [
    ...original,
    ...failed,
    ...unrelated,
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "email",
          type: "function",
          function: {
            name: "send_email",
            arguments: JSON.stringify({ content: "Sensitive other tool arguments".repeat(300) }),
          },
        },
      ],
    },
    {
      role: "tool",
      toolCallId: "email",
      content: JSON.stringify({ fileId: file("b"), attachment: true, replacesFileId: file("a") }),
    },
  ];
  const output = new ToolOutputStore();
  output.observe(messages);
  assert.deepEqual(output.project(messages, ["old", "failed", "another", "email"]), messages);
  assert.throws(
    () => output.read({ toolCallId: "email", part: "arguments", offset: 0, limit: 100 }),
    /unavailable/,
  );
  assert.throws(
    () => output.read({ toolCallId: "failed", part: "arguments", offset: 0, limit: 100 }),
    /unavailable/,
  );
});

test("repeated local draft revisions fit a fixed context capacity without losing mandatory receipts", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "Create and review the final presentation." },
  ];
  const required = [];
  for (let index = 0; index < 7; index++) {
    const id = `revision-${index}`;
    required.push(id);
    messages.push(
      ...creation(
        id,
        file(String(index)),
        `Draft ${index}: ${"Verified original content. ".repeat(190)}`,
        index ? file(String(index - 1)) : undefined,
      ),
    );
  }
  const options = {
    systemPrompts: ["System and tool inventory fixture. ".repeat(2800)],
    tools: [],
    requiredOperationIds: required,
  };
  const before = ContextBudget.minimumTokens(messages, options);
  const output = new ToolOutputStore();
  output.observe(messages);
  const projected = output.project(messages, required);
  const after = ContextBudget.minimumTokens(projected, options);
  assert.ok(before > 131072, `fixture must reproduce fixed-capacity failure: ${before}`);
  assert.ok(after < 131072, `projection must preserve admission at the same capacity: ${after}`);
  assert.equal(projected.filter((message) => message.role === "tool").length, 7);
  assert.deepEqual(projected.at(-1), messages.at(-1));
});

test("uncertain receipts cannot supersede a document and successful replay calls share the supersession", () => {
  const original = creation("old", file("a"), "Public document source ".repeat(200));
  for (const status of [
    { outcomeUnknown: true },
    { paused: true },
    { dispatched: false },
    { status: "running" },
    { status: "failed" },
  ]) {
    const messages = [
      ...original,
      ...creation("replace", file("b"), "New", file("a"), {
        fileId: file("b"),
        attachment: true,
        mimeType: "application/pdf",
        replacesFileId: file("a"),
        ...status,
      }),
    ];
    const store = new ToolOutputStore();
    store.observe(messages);
    assert.deepEqual(store.project(messages, ["old", "replace"]), messages);
  }
  const messages = [
    ...original,
    ...creation("replayed", file("a"), "Public document source ".repeat(200)),
    ...creation("new", file("b"), "Current", file("a")),
  ];
  const store = new ToolOutputStore();
  store.observe(messages);
  const projected = store.project(messages, ["old", "replayed", "new"]);
  assert.match(projected[0].toolCalls?.[0].function.arguments ?? "", /superseded_document_source/);
  assert.match(projected[2].toolCalls?.[0].function.arguments ?? "", /superseded_document_source/);
  assert.deepEqual(projected.slice(4), messages.slice(4));
});

test("provider interruption persists the 120k canonical document source and a fresh resumed loop can page it", async (t) => {
  const source = `${"A".repeat(70000)}RECOVER THIS ORIGINAL PASSAGE`.padEnd(120000, "B");
  assert.equal(source.length, 120000);
  const fixture = await modelFixture(
    t,
    (index) =>
      index === 1
        ? {
            name: "read_tool_output",
            arguments: { toolCallId: "old", part: "arguments", offset: 70000, limit: 300 },
          }
        : undefined,
    { dropAfterText: (index) => index === 0 },
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await server.agent.createTask("owner", {
    kind: "agent",
    prompt: "Read the preserved source.",
  });
  const messages = [
    ...creation("old", file("a"), source),
    ...creation("current", file("b"), "Complete current document", file("a")),
  ];
  for (let index = 0; index < messages.length; index += 2) {
    const call = messages[index].toolCalls?.[0];
    assert.ok(call);
    const receipt = messages[index + 1].content;
    assert.equal(typeof receipt, "string");
    await server.agent.journal.prepare("owner", {
      id: call.id,
      taskId: task.id,
      toolName: "create_document",
      toolCallId: call.id,
      args: JSON.parse(call.function.arguments),
      receipt: JSON.parse(receipt as string),
      bindingHash: createHash("sha256").update(call.function.arguments).digest("hex"),
      revision: 0,
      executorId: "fixture",
      executorEpoch: 1,
      resourceFence: 0,
      status: "succeeded",
      effect: true,
      runToken: "fixture",
      resourceLeaseIds: [],
      createdAt: `2026-10-04T00:00:0${index}.000Z`,
    });
  }
  const journal = await server.agent.journal.history("owner", task.id);
  assert.equal(
    JSON.parse(
      journal.find((message) => message.role === "assistant")?.toolCalls?.[0].function.arguments ??
        "{}",
    ).content,
    source,
  );
  assert.deepEqual(await server.agent.journal.history("another-owner", task.id), []);
  assert.deepEqual(await server.agent.journal.history("owner", "another-task"), []);
  const providers = server.agent.config.modelProviders;
  assert.ok(providers);
  const options = {
    model: "openai/fixture",
    providers,
    prompt: "Recover the document source using tools.",
    maxSteps: 3,
    tools: [],
    requiredOperationIds: async () => ["old", "current"],
  };
  let interrupted = false;
  const first = tanstackAgent({
    ...options,
    onProviderInterrupted: async (value) => {
      const checkpoint = providerContinuationCheckpointSchema.parse(value);
      assert.equal(checkpoint.partialText, "Hello partial ");
      assert.equal(checkpoint.admission?.stage, "provider_dispatch");
      assert.ok((checkpoint.admission?.requirements.contextTokens ?? 131072) < 131072);
      await server.db.put("owner", "tasks", {
        ...task,
        state: { ...task.state, providerCheckpoint: checkpoint },
      });
      interrupted = true;
    },
  });
  const input = (history: ReturnType<typeof modelHistory>) => ({
    threadId: "fixture-thread",
    runId: `run-${fixture.requests.length}`,
    messages: [{ id: "request", role: "user" as const, content: task.prompt }, ...history],
    tools: [],
    context: [],
    state: {},
  });
  await assert.rejects(lastValueFrom(first.run(input(journal)).pipe(toArray())), /interrompida/);
  assert.equal(interrupted, true);
  assert.match(fixture.requests[0].body, /superseded_document_source/);
  assert.ok(fixture.requests[0].body.length < 15000);
  const saved = await server.agent.getTask("owner", task.id);
  const restored = await server.agent.actor.history("owner", saved);
  const old = restored.find(
    (message) =>
      message.role === "assistant" && message.toolCalls?.some((call) => call.id === "old"),
  );
  const restoredArgs =
    old?.role === "assistant"
      ? old.toolCalls?.find((call) => call.id === "old")?.function.arguments
      : undefined;
  assert.ok(restoredArgs);
  assert.equal(JSON.parse(restoredArgs).content, source);
  assert.doesNotMatch(restoredArgs, /_historyProjection/);
  sharedModelRouter(providers).health.succeeded("openai/fixture");
  const events = await lastValueFrom(tanstackAgent(options).run(input(restored)).pipe(toArray()));
  assert.equal(
    events.some((event) => event.type === EventType.RUN_ERROR),
    false,
  );
  assert.equal(fixture.requests.length, 3);
  assert.match(
    fixture.requests[1].body,
    new RegExp(createHash("sha256").update(source).digest("hex")),
  );
  assert.match(fixture.requests[2].body, /RECOVER THIS ORIGINAL PASSAGE/);
  assert.equal(
    (await server.agent.journal.operations("owner", task.id)).length,
    2,
    "completed document effects were never replayed",
  );
});

test("the larger journal bound applies only to document content and retains secret scrubbing", () => {
  const source = "x".repeat(120100);
  const args = publicToolArguments("create_document", {
    content: source,
    title: source,
    apiKey: "hidden",
    extra: "Bearer abcdefghijklmnopqrstuvwxyz",
  }) as Record<string, string>;
  assert.equal(args.content.length, 120000);
  assert.equal(args.title.length, 32000);
  assert.equal(args.apiKey, undefined);
  assert.equal(args.extra, "Bearer [redacted]");
  const other = publicToolArguments("send_email", { content: source }) as Record<string, string>;
  assert.equal(other.content.length, 32000);
});

test("context admission failures persist numeric requirements and capabilities before dispatch", async (t) => {
  const fixture = await modelFixture(t, () => undefined);
  const providers = richChatFixtureProviders("/tmp/document-context-admission");
  const router = new ModelRouter(providers);
  let checkpoint: ReturnType<typeof providerContinuationCheckpointSchema.parse> | undefined;
  const agent = tanstackAgent({
    model: "openai/fixture",
    providers,
    modelRouter: router,
    maxSteps: 2,
    tools: [],
    prompt: "Mandatory trusted context ".repeat(6000),
    contextModel: (requirements) => ({
      id: "openai/fixture",
      contextTokens: router.contextCapacity(
        { ...requirements, contextTokens: requirements.contextTokens ?? 0 },
        ["openai/fixture"],
      ),
    }),
    onProviderInterrupted: async (value) => {
      checkpoint = providerContinuationCheckpointSchema.parse(value);
    },
  });
  await assert.rejects(
    lastValueFrom(
      agent
        .run({
          threadId: "diagnostic",
          runId: "diagnostic",
          messages: [{ id: "request", role: "user", content: "Continue." }],
          context: [],
          tools: [],
          state: {},
        })
        .pipe(toArray()),
    ),
    /contexto/,
  );
  assert.equal(fixture.requests.length, 0);
  assert.ok(checkpoint);
  assert.equal(checkpoint.code, "MODEL_CAPABILITY_UNAVAILABLE");
  assert.equal(checkpoint.admission?.stage, "context_projection");
  assert.ok((checkpoint.admission?.context?.baseTokens ?? 0) > 131072);
  assert.equal(checkpoint.admission?.context?.mandatoryMessages, 1);
  assert.deepEqual(checkpoint.admission?.context?.tools, []);
  assert.ok((checkpoint.admission?.requirements.contextTokens ?? 0) > 131072);
  assert.deepEqual(
    checkpoint.admission?.candidates.map(({ model, eligible, considered, capabilities }) => ({
      model,
      eligible,
      considered,
      contextTokens: capabilities.contextTokens,
    })),
    [{ model: "openai/fixture", eligible: false, considered: true, contextTokens: 131072 }],
  );
  assert.doesNotMatch(JSON.stringify(checkpoint.admission), /Mandatory trusted context/);
});
