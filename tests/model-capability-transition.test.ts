import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type TestContext, test } from "node:test";
import type { ModelMessage } from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { modelProviderConfig } from "../apps/server/src/providers/config.ts";
import { ModelRouter } from "../apps/server/src/providers/model-router.ts";
import { modelAdapter } from "../apps/server/src/providers/models.ts";
import { modelFixture } from "./helpers/model.ts";

const image = {
  type: "image" as const,
  source: {
    type: "data" as const,
    mimeType: "image/png" as const,
    value:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6yS8AAAAASUVORK5CYII=",
  },
};
const plain: ModelMessage[] = [{ role: "user", content: "Continue from the saved result." }];
const visual: ModelMessage[] = [
  { role: "user", content: [{ type: "text", content: "Inspect the real page." }, image] },
];

async function setup(
  t: TestContext,
  fallback: { vision?: boolean; structuredOutput?: boolean; contextTokens?: number } = {},
) {
  const fixture = await modelFixture(t, () => undefined, {
    errorStatus: (index) => (index === 0 ? 403 : undefined),
    text: () => '{"ok":true}',
  });
  const providers = modelProviderConfig(`/tmp/okami-capability-transition-${randomUUID()}`, {
    LOCAL_BASE_URL: process.env.OPENAI_BASE_URL,
    LOCAL_API: "responses",
    MODEL_COOLDOWN_MS: "60000",
    MODEL_CAPABILITIES: JSON.stringify({
      "local/primary": { tools: true, vision: true, structuredOutput: true, contextTokens: 131072 },
      "local/fallback": {
        tools: true,
        vision: false,
        structuredOutput: true,
        contextTokens: 32768,
        ...fallback,
      },
    }),
  });
  let now = Date.now();
  const router = new ModelRouter(providers, () => now);
  const adapter = modelAdapter(
    "local/primary",
    ["local/fallback"],
    providers,
    undefined,
    undefined,
    undefined,
    { router },
  );
  const stream = async (messages = plain) => {
    const events = [];
    for await (const event of adapter.chatStream({
      model: "primary",
      messages,
      logger: resolveDebugOption(false),
    }))
      events.push(event);
    return {
      error: events.find((event) => event.type === "RUN_ERROR"),
      finished: events.some((event) => event.type === "RUN_FINISHED"),
    };
  };
  const first = await stream();
  assert.equal(first.error, undefined);
  assert.equal(first.finished, true);
  assert.deepEqual(
    fixture.requests.map((request) => JSON.parse(request.body).model),
    ["primary", "fallback"],
  );
  return {
    adapter,
    fixture,
    stream,
    recoverPrimary: () => {
      now += 60001;
    },
  };
}

test("sticky text fallback stays selected for text but reconsiders the earlier primary for page images", async (t) => {
  const { fixture, stream, recoverPrimary } = await setup(t);
  recoverPrimary();
  assert.equal((await stream()).finished, true);
  assert.deepEqual(
    fixture.requests.map((request) => JSON.parse(request.body).model),
    ["primary", "fallback", "fallback"],
    "Recovery alone must not undo ordinary sticky fallback",
  );
  const result = await stream(visual);
  assert.equal(
    result.error,
    undefined,
    "A prior text fallback cannot hide the configured vision model",
  );
  assert.equal(result.finished, true);
  assert.deepEqual(
    fixture.requests.map((request) => JSON.parse(request.body).model),
    ["primary", "fallback", "fallback", "primary"],
  );
  assert.ok(fixture.requests.at(-1)?.body.includes(image.source.value));
});

test("capability reconsideration respects the primary cooldown instead of reporting missing vision", async (t) => {
  const { fixture, stream, recoverPrimary } = await setup(t);
  const unavailable = await stream(visual);
  assert.equal(unavailable.finished, false);
  assert.equal(unavailable.error?.code, "MODEL_PROVIDER_UNAVAILABLE");
  assert.equal(
    fixture.requests.length,
    2,
    "No image request may bypass the primary cooldown or reach text-only fallback",
  );
  recoverPrimary();
  assert.equal((await stream(visual)).finished, true);
  const last = fixture.requests.at(-1);
  assert.ok(last);
  assert.equal(JSON.parse(last.body).model, "primary");
});

test("later structured output can return from a plain fallback to an earlier eligible model", async (t) => {
  const { adapter, fixture, recoverPrimary } = await setup(t, { structuredOutput: false });
  recoverPrimary();
  const result = await adapter.structuredOutput({
    chatOptions: { model: "primary", messages: plain, logger: resolveDebugOption(false) },
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
  });
  assert.deepEqual(result.data, { ok: true });
  assert.deepEqual(
    fixture.requests.map((request) => JSON.parse(request.body).model),
    ["primary", "fallback", "primary"],
  );
});

test("larger required context can return from a smaller sticky fallback without truncation", async (t) => {
  const { fixture, stream, recoverPrimary } = await setup(t, { contextTokens: 1024 });
  recoverPrimary();
  const evidence = `Saved current-task evidence: ${"verified-result ".repeat(200)}`;
  const result = await stream([{ role: "user", content: evidence }]);
  assert.equal(result.error, undefined);
  assert.equal(result.finished, true);
  const last = fixture.requests.at(-1);
  assert.ok(last);
  assert.equal(JSON.parse(last.body).model, "primary");
  assert.ok(
    last.body.includes(evidence),
    "Requirement transition must preserve the complete current context",
  );
});
