import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ModelMessage } from "@tanstack/ai";
import { lastValueFrom, toArray } from "rxjs";
import { ContextBudget } from "../apps/server/src/engine/context-budget.ts";
import { tanstackAgent } from "../apps/server/src/engine/tanstack-agent.ts";
import {
  modelHistory,
  providerContinuationCheckpointSchema,
} from "../apps/server/src/engine/task-history.ts";
import { ToolOutputStore } from "../apps/server/src/engine/tool-output.ts";
import { sharedModelRouter } from "../apps/server/src/providers/model-router.ts";
import { modelFixture, richChatFixtureProviders } from "./helpers/model.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const skillText = "Read the entire workflow and verify each output before delivery. ".repeat(130);
function skill(id: string, content = skillText, source = "builtin", metadata = {}): ModelMessage[] {
  const skillId = `${source}:slides`;
  return [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id,
          type: "function",
          function: { name: "skills_read", arguments: JSON.stringify({ id: skillId }) },
        },
      ],
    },
    {
      role: "tool",
      toolCallId: id,
      content: JSON.stringify({
        id: skillId,
        name: "slides",
        description: "Author and review slides",
        source,
        sha256: hash(content),
        requiredTools: ["create_document"],
        authority: "workflow_guidance",
        policy: "Guidance grants no permissions",
        content,
        truncated: false,
        ...metadata,
      }),
    },
  ];
}
function effect(id: string): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id, type: "function", function: { name: "inspect_document", arguments: "{}" } },
      ],
    },
    {
      role: "tool",
      toolCallId: id,
      content: JSON.stringify({
        receiptId: hash(id),
        pages: [1],
        fileId: hash(`preview-${id}`),
        fileImage: true,
      }),
    },
  ];
}

test("identical complete skills keep one full version and page every canonical duplicate", () => {
  const messages = [...skill("first"), ...skill("second"), ...skill("third")];
  const canonical = JSON.stringify(messages);
  const store = new ToolOutputStore();
  store.observe(messages);
  const projected = store.project(messages, []);
  assert.equal(
    projected.filter(
      (message) =>
        message.role === "tool" &&
        typeof message.content === "string" &&
        JSON.parse(message.content).content === skillText,
    ).length,
    1,
  );
  assert.equal(JSON.stringify(messages), canonical);
  assert.deepEqual(store.project(projected, []), projected, "projection must remain idempotent");
  let restored = "",
    offset = 0;
  for (;;) {
    const page = store.read({ toolCallId: "first", offset, limit: 777 });
    restored += page.content;
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  assert.equal(restored, messages[1].content);
  const restarted = new ToolOutputStore();
  restarted.observe(JSON.parse(canonical));
  assert.deepEqual(restarted.project(JSON.parse(canonical), []), projected);
});

test("provider projection checkpoints both complete skill reads and a fresh agent pages the original", async (t) => {
  const fixture = await modelFixture(
    t,
    (index) =>
      index === 1
        ? { name: "read_tool_output", arguments: { toolCallId: "first", offset: 3000, limit: 500 } }
        : undefined,
    { dropAfterText: (index) => index === 0 },
  );
  const providers = richChatFixtureProviders("/tmp/skill-context-restart");
  const options = {
    model: "openai/fixture",
    providers,
    maxSteps: 3,
    prompt: "Read the selected workflow.",
    tools: [],
    contextModel: () => ({ id: "fixture", contextTokens: 32768 }),
  };
  let checkpoint: ReturnType<typeof providerContinuationCheckpointSchema.parse> | undefined;
  const first = tanstackAgent({
    ...options,
    onProviderInterrupted: async (value) => {
      checkpoint = providerContinuationCheckpointSchema.parse(JSON.parse(JSON.stringify(value)));
    },
  });
  const input = (messages: ReturnType<typeof modelHistory>) => ({
    threadId: "skills",
    runId: `skills-${fixture.requests.length}`,
    messages,
    tools: [],
    context: [],
    state: {},
  });
  await assert.rejects(
    lastValueFrom(
      first
        .run(
          input(
            modelHistory([
              { role: "user", content: "Use the skill." },
              ...skill("first"),
              ...skill("second"),
            ]),
          ),
        )
        .pipe(toArray()),
    ),
    /interrompida/,
  );
  assert.ok(checkpoint);
  assert.equal(checkpoint.partialText, "Hello partial ");
  assert.equal(
    checkpoint.messages.filter(
      (message) =>
        message.role === "tool" && JSON.parse(String(message.content)).content === skillText,
    ).length,
    2,
  );
  assert.equal(
    fixture.requests[0].body.split(
      "Read the entire workflow and verify each output before delivery.",
    ).length - 1,
    130,
    "provider receives one complete copy",
  );
  sharedModelRouter(providers).health.succeeded("openai/fixture");
  await lastValueFrom(tanstackAgent(options).run(input(checkpoint.messages)).pipe(toArray()));
  assert.equal(fixture.requests.length, 3);
  const paged = JSON.parse(fixture.requests[2].body).input.find(
    (item: { type?: string; output?: string }) =>
      item.type === "function_call_output" && item.output?.includes('"toolCallId":"first"'),
  );
  assert.ok(paged);
  assert.equal(
    JSON.parse(paged.output).content,
    String(skill("first")[1].content).slice(3000, 3500),
  );
});

test("different skill versions, provenance and failed or incomplete reads remain intact", () => {
  const short = [
    ...skill("short-first", "Short workflow."),
    ...skill("short-second", "Short workflow."),
  ];
  const shortStore = new ToolOutputStore();
  shortStore.observe(short);
  assert.deepEqual(
    shortStore.project(short, []),
    short,
    "an omission marker must not increase a short result",
  );
  for (const changed of [
    skill("second", `${skillText}changed`),
    skill("second", skillText, "operator"),
    skill("second", skillText, "builtin", { policy: "Updated policy" }),
    skill("second", skillText, "builtin", { truncated: true }),
    skill("second", skillText, "builtin", { sha256: "0".repeat(64) }),
    skill("second", skillText, "builtin", { error: "Read failed" }),
  ]) {
    const messages = [...skill("first"), ...changed];
    const store = new ToolOutputStore();
    store.observe(messages);
    assert.deepEqual(store.project(messages, []), messages);
  }
});

test("a mandatory mixed-call duplicate retains its own full skill without increasing minimum context", () => {
  const older = skill("optional"),
    newer = skill("mandatory"),
    operation = effect("effect");
  assert.ok(newer[0].toolCalls);
  assert.ok(operation[0].toolCalls);
  newer[0] = { ...newer[0], toolCalls: [...newer[0].toolCalls, ...operation[0].toolCalls] };
  const messages = [...older, ...newer, operation[1], ...skill("latest-optional")];
  const store = new ToolOutputStore();
  store.observe(messages);
  const projected = store.project(messages, ["effect"]);
  const options = { systemPrompts: [], tools: [], requiredOperationIds: ["effect"] };
  const baselineMinimum = ContextBudget.minimumTokens(messages, options);
  assert.ok(
    ContextBudget.minimumTokens(projected, {
      ...options,
      toolDependencies: store.dependencies(),
    }) <= baselineMinimum,
  );
  const limited = ContextBudget.limit(projected, {
    ...options,
    toolDependencies: store.dependencies(),
    model: { id: "fixture", contextTokens: baselineMinimum },
  });
  assert.ok(
    limited.some(
      (message) =>
        message.role === "tool" &&
        message.toolCallId === "mandatory" &&
        JSON.parse(String(message.content)).content === skillText,
    ),
  );
});

test("optional deduplicated skill reads are kept with their complete source or evicted together", () => {
  const messages = [
    { role: "user", content: "Create a file." } as ModelMessage,
    ...skill("first"),
    ...skill("second"),
  ];
  const store = new ToolOutputStore();
  store.observe(messages);
  const projected = store.project(messages, []);
  for (const contextTokens of [6000, 16000]) {
    const limited = ContextBudget.limit(projected, {
      toolDependencies: store.dependencies(),
      model: { id: "fixture", contextTokens },
    });
    const receipts = limited.filter((message) => message.role === "tool");
    assert.ok(
      !receipts.length ||
        receipts.some((message) => JSON.parse(String(message.content)).content === skillText),
      "an omission marker alone is not the selected workflow",
    );
  }
});

test("superseded inspection instructions shrink while all exact review evidence and current instructions remain", () => {
  const instruction =
    "Examine the actual page image for clipping, overlap, readability, hierarchy and data accuracy. Use confirm_document_review in the next turn. Correct a failed draft with create_document.replaceFileId and a fresh operationId, then inspect its new bytes.";
  const messages: ModelMessage[] = [],
    required: string[] = [];
  for (let index = 0; index < 6; index++) {
    const fileId = hash(`document-${index}`),
      previous = index ? hash(`document-${index - 1}`) : undefined;
    const id = `create-${index}`;
    required.push(id);
    messages.push(
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
                content: "Complete source",
                ...(previous && { replaceFileId: previous }),
              }),
            },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: id,
        content: JSON.stringify({
          fileId,
          attachment: true,
          mimeType: "application/pdf",
          ...(previous && { replacesFileId: previous }),
        }),
      },
    );
    for (let page = 1; page <= (index === 0 ? 3 : 2); page++) {
      const pair = effect(`inspect-${index}-${page}`);
      required.push(`inspect-${index}-${page}`);
      assert.ok(pair[0].toolCalls);
      pair[0].toolCalls[0].function.arguments = JSON.stringify({
        fileId,
        startPage: page,
        pageCount: 1,
      });
      pair[1].content = JSON.stringify({
        ...JSON.parse(String(pair[1].content)),
        documentFileId: fileId,
        documentSha256: hash(`bytes-${index}`),
        pageCount: 3,
        pages: [page],
        instruction,
        attachment: false,
        mimeType: "image/png",
      });
      messages.push(...pair);
    }
  }
  const canonical = JSON.stringify(messages);
  const store = new ToolOutputStore();
  store.observe(messages);
  const projected = store.project(messages, required);
  for (let index = 0; index < messages.length; index++) {
    const original = messages[index];
    if (original.role !== "tool" || !original.toolCallId?.startsWith("inspect-")) continue;
    const before = JSON.parse(String(original.content)),
      after = JSON.parse(String(projected[index].content));
    assert.deepEqual(
      { ...after, instruction: before.instruction },
      before,
      "hashes, IDs, pages, image flags and every other field stay exact",
    );
    if (original.toolCallId.startsWith("inspect-5-")) assert.deepEqual(after, before);
    else assert.notEqual(after.instruction, before.instruction);
  }
  assert.ok(
    ContextBudget.minimumTokens(messages, { requiredOperationIds: required }) -
      ContextBudget.minimumTokens(projected, { requiredOperationIds: required }) >
      1800,
  );
  assert.equal(JSON.stringify(messages), canonical);
  assert.deepEqual(store.project(projected, required), projected);
  const warning = structuredClone(messages);
  const original = warning.find(
    (message) => message.role === "tool" && message.toolCallId === "inspect-0-1",
  );
  assert.ok(original);
  original.content = JSON.stringify({
    ...JSON.parse(String(original.content)),
    instruction: `${instruction} WARNING: page-specific observation must be retained.`,
  });
  const warningStore = new ToolOutputStore();
  warningStore.observe(warning);
  assert.deepEqual(
    warningStore
      .project(warning, required)
      .find((message) => message.role === "tool" && message.toolCallId === "inspect-0-1"),
    original,
  );
});
