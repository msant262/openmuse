import assert from "node:assert/strict";
import test from "node:test";
import { defineTool } from "@copilotkit/runtime/v2";
import type { ModelMessage } from "@tanstack/ai";
import { lastValueFrom, toArray } from "rxjs";
import { z } from "zod";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { openclawAgent } from "../apps/server/src/engine/openclaw-agent.ts";
import { browserImageMessages } from "../apps/server/src/providers/browser-images.ts";
import { modelProviderConfig } from "../apps/server/src/providers/config.ts";
import { modelFixture, richChatFixtureProviders } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6yS8AAAAASUVORK5CYII=",
  "base64",
);

test("a reviewed file preview stays before its later repair receipts on the actual model wire", async (t) => {
  const model = await modelFixture(t, () => undefined, { text: () => "Continue the correction." });
  const f = await taskRuntime(t);
  const preview = await f.files.importAttachment(
    "owner",
    "document-preview.png",
    png,
    "Preview fixture",
    undefined,
    "page-preview",
  );
  const providers = richChatFixtureProviders(f.directory);
  assert.ok(providers.routing);
  providers.routing.capabilities["openai/fixture"].vision = true;
  const result = { ...(await f.files.reference("owner", preview.id)), receiptId: "a".repeat(64) };
  const review = { passed: false, issues: ["Correct the last paragraph in the current file."] };
  const repair = { complete: false, repairable: true, continuation: "document_review" };
  const names = ["inspect_document", "confirm_document_review", "finish_task"];
  const agent = openclawAgent({
    dataDir: f.directory,
    model: "openai/fixture",
    providers,
    toolSearch: false,
    prompt: "Continue from the latest tool receipt.",
    tools: names.map((name) =>
      defineTool({
        name,
        description: name,
        parameters: z.object({}),
        execute: async () => assert.fail("Replaying a receipt must not execute its tool"),
      }),
    ),
    loadFileImage: (id) => f.files.imageContent("owner", id),
  });
  await lastValueFrom(
    agent
      .run({
        threadId: "review-history",
        runId: "review-history-run",
        tools: [],
        context: [],
        state: {},
        messages: [
          { id: "request", role: "user", content: "Create the requested document." },
          ...names.flatMap((name, index) => [
            {
              id: `call-${index}`,
              role: "assistant" as const,
              content: "",
              toolCalls: [
                {
                  id: `tool-${index}`,
                  type: "function" as const,
                  function: { name, arguments: "{}" },
                },
              ],
            },
            {
              id: `result-${index}`,
              role: "tool" as const,
              toolCallId: `tool-${index}`,
              content: JSON.stringify([result, review, repair][index]),
            },
          ]),
        ],
      })
      .pipe(toArray()),
  );
  assert.equal(model.requests.length, 1);
  const wire = JSON.parse(model.requests[0].body).input as Array<Record<string, unknown>>;
  const imageIndex = wire.findIndex((entry) =>
    JSON.stringify(entry).includes(`data:image/png;base64,${png.toString("base64")}`),
  );
  const reviewIndex = wire.findIndex(
    (entry) =>
      entry.type === "function_call_output" &&
      String(entry.output).includes("Correct the last paragraph"),
  );
  const repairIndex = wire.findIndex(
    (entry) =>
      entry.type === "function_call_output" && String(entry.output).includes('"repairable":true'),
  );
  assert.ok(imageIndex >= 0 && reviewIndex >= 0 && repairIndex >= 0, JSON.stringify(wire));
  assert.ok(
    imageIndex < reviewIndex && reviewIndex < repairIndex,
    "Old preview pixels must precede the later assessment and repair receipt, not masquerade as the newest user message",
  );
});

for (const generated of [true, false])
  test(`view_file sends actual pixels for ${generated ? "durably generated" : "uploaded"} owned images to the provider`, async (t) => {
    let fileId = "";
    const model = await modelFixture(t, (index) =>
      index === 0 ? { name: "view_file", arguments: { fileId } } : undefined,
    );
    const providers = modelProviderConfig("/tmp/file-vision-transport", {
      ...process.env,
      MODEL_CAPABILITIES: JSON.stringify({
        "openai/fixture": {
          tools: true,
          vision: true,
          structuredOutput: true,
          contextTokens: 131072,
        },
      }),
    });
    const server = await taskRuntime(t, {
      agentBackend: "model",
      model: "openai/fixture",
      modelProviders: providers,
    });
    const file = await server.files.importAttachment(
      "owner",
      "document-preview.png",
      png,
      "Preview fixture",
      undefined,
      generated ? "rendered-document-page" : undefined,
    );
    fileId = file.id;
    assert.match(fileId, generated ? /^[a-f0-9]{64}$/ : /^[a-f0-9-]{36}$/);
    const events = await lastValueFrom(
      new ConversationAgent(server.agent.config, server.agent, "owner")
        .run({
          threadId: "file-vision",
          runId: `inspect-${generated}`,
          messages: [{ id: "request", role: "user", content: "Inspect the supplied image." }],
          tools: [],
          context: [],
          state: {},
        })
        .pipe(toArray()),
    );
    assert.equal(model.requests.length, 2);
    assert.ok(
      model.requests[1].body.includes(`data:image/png;base64,${png.toString("base64")}`),
      "the next model request must contain image pixels, not only file metadata",
    );
    assert.ok(!JSON.stringify(events).includes(png.toString("base64")));
    await assert.rejects(
      browserImageMessages(
        [{ role: "tool", content: JSON.stringify(await server.files.reference("owner", fileId)) }],
        undefined,
        (id) => server.files.imageContent("other-owner", id),
      ),
      /not found/,
    );
  });

test("file vision references reject arbitrary paths and malformed identifiers before loading", async () => {
  for (const fileId of ["../private", "a".repeat(63), "g".repeat(64), "/tmp/image.png"])
    assert.equal(
      (
        await browserImageMessages(
          [{ role: "tool", content: JSON.stringify({ fileImage: true, fileId }) }],
          undefined,
          async () => {
            assert.fail("malformed identifiers must not call the file loader");
          },
        )
      ).length,
      1,
    );
});

test("a historical image does not split the outputs of a parallel tool-call batch", async () => {
  const messages: ModelMessage[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: ["preview", "sources"].map((id) => ({
        id,
        type: "function",
        function: { name: id, arguments: "{}" },
      })),
    },
    {
      role: "tool",
      toolCallId: "preview",
      content: JSON.stringify({ fileImage: true, fileId: "a".repeat(64) }),
    },
    { role: "tool", toolCallId: "sources", content: "The source lookup completed." },
    { role: "user", content: "Use the corrected source." },
  ];
  const promoted = await browserImageMessages(messages, undefined, async () => ({
    type: "image",
    source: { type: "data", value: png.toString("base64"), mimeType: "image/png" },
  }));
  assert.deepEqual(
    promoted.slice(0, 3),
    messages.slice(0, 3),
    "all outputs must immediately follow their assistant tool calls before a user image",
  );
  assert.equal(promoted[3].role, "user");
  assert.equal(promoted[4], messages[3], "the actual subsequent user direction remains last");
  assert.equal(messages.length, 4, "hydration never mutates durable input history");
});
