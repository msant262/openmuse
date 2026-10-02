import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { EventType, type RunAgentInput } from "@ag-ui/core";
import { type BuiltInAgent, defineTool } from "@copilotkit/runtime/v2";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { z } from "zod";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import { tanstackAgent } from "../apps/server/src/engine/tanstack-agent.ts";
import { modelProviderConfig } from "../apps/server/src/providers/config.ts";
import { writeProtected } from "../apps/server/src/providers/credential-store.ts";
import { ModelUnavailableError } from "../apps/server/src/providers/errors.ts";
import { GROK_API_URL } from "../apps/server/src/providers/grok-auth.ts";
import { ModelRouter } from "../apps/server/src/providers/model-router.ts";
import {
  modelAdapter,
  type ProviderContinuationCheckpoint,
  providerContinuationCheckpointSchema,
} from "../apps/server/src/providers/models.ts";
import { modelFixture } from "./helpers/model.ts";

async function directory(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "okami-router-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function run(agent: BuiltInAgent, messages?: RunAgentInput["messages"]) {
  const events: { type: string; [key: string]: unknown }[] = [];
  let failure: unknown;
  await new Promise<void>((resolve) =>
    agent
      .run({
        threadId: "routing",
        runId: crypto.randomUUID(),
        messages: messages ?? [{ id: "u", role: "user", content: "Complete the requested work." }],
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
      })
      .subscribe({
        next: (event) => events.push(event as { type: string; [key: string]: unknown }),
        error: (error) => {
          failure = error;
          resolve();
        },
        complete: resolve,
      }),
  );
  return {
    events,
    error: events.find((e) => e.type === EventType.RUN_ERROR)?.message ?? failure,
    finished: events.some((e) => e.type === EventType.RUN_FINISHED),
  };
}

test("Responses clean EOF never confirms a completed inference or dispatches a fallback", async (t) => {
  const fixture = await modelFixture(t, () => undefined, { cleanEof: () => true });
  const providers = modelProviderConfig(await directory(t), {
    LOCAL_BASE_URL: process.env.OPENAI_BASE_URL,
    LOCAL_API: "responses",
  });
  const result = await run(
    tanstackAgent({
      model: "local/first",
      fallbacks: ["local/second"],
      providers,
      maxSteps: 3,
      tools: [],
      prompt: "Reply.",
    }),
  );
  assert.equal(result.finished, false, "a missing response.completed must not finish the run");
  assert.ok(result.error, "the interruption is recoverable and visible");
  assert.equal(fixture.requests.length, 1, "accepted inference is not replayed");
});

test("an incomplete Responses stream cannot execute a fragmented function call", async (t) => {
  let tools = 0;
  const fixture = await modelFixture(t, () => ({ name: "effect", arguments: {} }), {
    partialTool: () => true,
  });
  const providers = modelProviderConfig(await directory(t), {
    LOCAL_BASE_URL: process.env.OPENAI_BASE_URL,
    LOCAL_API: "responses",
  });
  const result = await run(
    tanstackAgent({
      model: "local/first",
      providers,
      maxSteps: 3,
      prompt: "Use the tool.",
      tools: [
        defineTool({
          name: "effect",
          description: "Record once",
          parameters: z.object({}),
          execute: async () => {
            tools++;
            return { receipt: "once" };
          },
        }),
      ],
    }),
  );
  assert.equal(result.finished, false);
  assert.ok(result.error);
  assert.equal(tools, 0, "a complete JSON fragment without a terminal response is not authority");
  assert.equal(fixture.requests.length, 1);
});

for (const scenario of ["clean EOF", "length limit"] as const) {
  test(`Chat Completions ${scenario} cannot promote a tool fragment into an effect`, async (t) => {
    let executions = 0;
    const fixture = await modelFixture(
      t,
      (index) => (index === 0 ? { name: "effect", arguments: {} } : undefined),
      {
        partialTool: (index) => index === 0 && scenario === "clean EOF",
        chatFinishReason: (index) =>
          index === 0 && scenario === "length limit" ? "length" : undefined,
      },
    );
    const providers = modelProviderConfig(await directory(t), {
      LOCAL_BASE_URL: process.env.OPENAI_BASE_URL,
      LOCAL_API: "chat-completions",
    });
    const result = await run(
      tanstackAgent({
        model: "local/first",
        fallbacks: ["local/second"],
        providers,
        prompt: "Use the tool.",
        maxSteps: 2,
        tools: [
          defineTool({
            name: "effect",
            description: "Perform once",
            parameters: z.object({}),
            execute: async () => {
              executions++;
              return { receipt: "once" };
            },
          }),
        ],
      }),
    );
    assert.equal(executions, 0, "a complete-looking argument fragment is not a completed call");
    assert.equal(result.finished, false);
    assert.ok(result.error);
    assert.equal(fixture.requests.length, 1, "accepted inference is not replayed");
  });
}

for (const api of ["responses", "chat-completions"] as const) {
  for (const mime of [
    { name: "incorrect MIME", value: "text/plain" },
    { name: "missing MIME", value: null },
    { name: "mixed-case MIME", value: "Text/Event-Stream; charset=utf-8" },
  ]) {
    for (const incomplete of [true, false]) {
      test(`${api} ${mime.name} ${incomplete ? "cannot authorize an incomplete tool" : "preserves genuine completion"}`, async (t) => {
        let effects = 0;
        const fixture = await modelFixture(
          t,
          (index) => (index === 0 ? { name: "effect", arguments: {} } : undefined),
          {
            partialTool: (index) => incomplete && index === 0,
            streamContentType: mime.value,
          },
        );
        const providers = modelProviderConfig(await directory(t), {
          LOCAL_BASE_URL: process.env.OPENAI_BASE_URL,
          LOCAL_API: api,
        });
        let checkpoint: ProviderContinuationCheckpoint | undefined;
        const result = await run(
          tanstackAgent({
            model: "local/first",
            fallbacks: ["local/second"],
            providers,
            prompt: "Use the tool once.",
            maxSteps: 2,
            onProviderInterrupted: (value) => {
              checkpoint = value;
            },
            tools: [
              defineTool({
                name: "effect",
                description: "Record once",
                parameters: z.object({}),
                execute: async () => {
                  effects++;
                  return { receipt: "once" };
                },
              }),
            ],
          }),
        );
        assert.equal(
          effects,
          incomplete ? 0 : 1,
          "provider MIME cannot turn a fragment into authority",
        );
        assert.equal(result.finished, !incomplete);
        assert.equal(fixture.requests.length, incomplete ? 1 : 2);
        if (incomplete) {
          assert.ok(result.error);
          assert.ok(checkpoint);
          assert.equal(checkpoint?.accepted, true);
          assert.equal(checkpoint?.code, "MODEL_PROVIDER_INTERRUPTED");
          assert.ok(
            !checkpoint.messages.some(
              (message) => message.role === "assistant" && message.toolCalls?.length,
            ),
          );
        } else {
          assert.equal(result.error, undefined);
          assert.equal(checkpoint, undefined);
        }
      });
    }
  }
}

test("non-streaming schema retry honors preflight capabilities when its attempt budget is exhausted", async (t) => {
  const fixture = await modelFixture(t, () => undefined, {
    errorStatus: () => 429,
    retryAfter: () => "120",
  });
  const providers = modelProviderConfig(await directory(t), {
    LOCAL_BASE_URL: process.env.OPENAI_BASE_URL,
    LOCAL_API: "responses",
    MODEL_MAX_ATTEMPTS: "1",
    MODEL_CAPABILITIES: JSON.stringify({
      "local/schema": { tools: true, vision: false, structuredOutput: false, contextTokens: 32768 },
      "local/plain": { tools: true, vision: false, structuredOutput: false, contextTokens: 32768 },
    }),
  });
  const router = new ModelRouter(providers);
  router.confirmCapabilities("ollama/schema", {
    tools: true,
    vision: false,
    structuredOutput: true,
    contextTokens: 32768,
  });
  const before = Date.now();
  await assert.rejects(
    modelAdapter("local/schema", ["local/plain"], providers, undefined, undefined, undefined, {
      router,
    }).structuredOutput({
      chatOptions: {
        model: "schema",
        messages: [{ role: "user", content: "Return JSON." }],
        logger: resolveDebugOption(false),
      },
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ModelUnavailableError);
      assert.equal(error.reason, "cooldown");
      assert.ok(
        error.retryAt && error.retryAt >= before + 120000 && error.retryAt <= Date.now() + 120000,
      );
      return true;
    },
  );
  assert.deepEqual(
    fixture.requests.map((request) => JSON.parse(request.body).model),
    ["schema"],
  );
});

for (const maxAttempts of [3, 1]) {
  test(`capable vision cooldown survives incapable fallbacks and attempt budget ${maxAttempts}`, async (t) => {
    const fixture = await modelFixture(t, () => undefined, {
      errorStatus: () => 429,
      retryAfter: () => "120",
    });
    const dir = await directory(t),
      db = await createStore();
    t.after(() => db.close());
    const providers = modelProviderConfig(dir, {
      LOCAL_BASE_URL: process.env.OPENAI_BASE_URL,
      LOCAL_API: "responses",
      MODEL_MAX_ATTEMPTS: String(maxAttempts),
      MODEL_CAPABILITIES: JSON.stringify({
        "local/vision": { tools: true, vision: true, structuredOutput: true, contextTokens: 32768 },
        "local/text": { tools: true, vision: false, structuredOutput: true, contextTokens: 32768 },
        "local/small-vision": {
          tools: true,
          vision: true,
          structuredOutput: true,
          contextTokens: 1024,
        },
      }),
    });
    const before = Date.now();
    const result = await run(
      tanstackAgent({
        model: "local/vision",
        fallbacks: ["ollama/vision", "local/text", "local/small-vision"],
        providers,
        requirements: { vision: true, contextTokens: 4000 },
        prompt: "Read the image.",
        maxSteps: 1,
        tools: [],
        onProviderInterrupted: async (checkpoint) => {
          await db.put("owner", "provider-checkpoints", { id: "vision", checkpoint });
        },
      }),
    );
    const saved = await db.get<{ checkpoint: ProviderContinuationCheckpoint }>(
      "owner",
      "provider-checkpoints",
      "vision",
    );
    assert.ok(saved, "the interruption callback persisted its envelope before the run stopped");
    assert.equal(saved.checkpoint.code, "MODEL_PROVIDER_UNAVAILABLE");
    assert.equal(saved.checkpoint.accepted, false);
    assert.ok(saved.checkpoint.retryAt);
    const retryAt = Date.parse(saved.checkpoint.retryAt);
    assert.ok(
      retryAt >= before + 120000 && retryAt <= Date.now() + 120000,
      "Retry-After uses only capable models, including aliases",
    );
    assert.equal(result.finished, false);
    assert.match(String(result.error), /temporariamente indisponíveis/);
    assert.deepEqual(
      fixture.requests.map((request) => JSON.parse(request.body).model),
      ["vision"],
    );
  });

  test(`worker persists eligible Retry-After with context-limited fallback and attempt budget ${maxAttempts}`, async (t) => {
    const fixture = await modelFixture(t, () => undefined, {
      errorStatus: () => 429,
      retryAfter: () => "120",
    });
    const dir = await directory(t),
      db = await createStore();
    const providers = modelProviderConfig(dir, {
      LOCAL_BASE_URL: process.env.OPENAI_BASE_URL,
      LOCAL_API: "responses",
      MODEL_MAX_ATTEMPTS: String(maxAttempts),
      MODEL_CAPABILITIES: JSON.stringify({
        "local/capable": {
          tools: true,
          vision: true,
          structuredOutput: true,
          contextTokens: 1000000,
        },
        "local/small": { tools: true, vision: false, structuredOutput: true, contextTokens: 256 },
      }),
    });
    const app = await createApp(db, {
      mode: "sample",
      agentBackend: "model",
      model: "local/capable",
      modelFallbacks: ["local/small"],
      modelProviders: providers,
      dataDir: dir,
      host: "127.0.0.1",
      port: 8787,
      publicUrl: "http://localhost:8787",
      googleRedirectUri: "http://localhost:8787/api/google/callback",
      allowedOrigins: [],
    });
    t.after(async () => {
      await app.agent.stop();
      await db.close();
    });
    const task = await app.agent.createTask("owner", {
      prompt: "Save the requested work",
      kind: "plan",
    });
    const before = Date.now();
    await app.agent.worker.tick();
    const saved = await app.agent.getTask("owner", task.id);
    const checkpoint = providerContinuationCheckpointSchema.parse(saved.state.providerCheckpoint);
    assert.equal(saved.status, "waiting_provider");
    assert.equal(saved.error, null);
    assert.equal(checkpoint.code, "MODEL_PROVIDER_UNAVAILABLE");
    assert.ok(checkpoint.retryAt);
    assert.equal(saved.nextRunAt, checkpoint.retryAt);
    const retryAt = Date.parse(checkpoint.retryAt);
    assert.ok(retryAt >= before + 120000 && retryAt <= Date.now() + 120000);
    assert.match(saved.question ?? "", /temporariamente indisponíveis/);
    assert.deepEqual(
      fixture.requests.map((request) => JSON.parse(request.body).model),
      ["capable"],
    );
  });
}

test("explicit vision and context requirements exclude incapable models before dispatch", async (t) => {
  const fixture = await modelFixture(t, () => undefined);
  const providers = modelProviderConfig(await directory(t), {
    LOCAL_BASE_URL: process.env.OPENAI_BASE_URL,
    LOCAL_API: "responses",
    MODEL_CAPABILITIES: JSON.stringify({
      "local/text": { tools: true, vision: false, structuredOutput: true, contextTokens: 32768 },
      "local/small-vision": {
        tools: true,
        vision: true,
        structuredOutput: true,
        contextTokens: 1024,
      },
      "local/large-vision": {
        tools: true,
        vision: true,
        structuredOutput: true,
        contextTokens: 65536,
      },
    }),
  });
  const result = await run(
    tanstackAgent({
      model: "local/text",
      fallbacks: ["local/small-vision", "local/large-vision"],
      providers,
      tools: [],
      maxSteps: 1,
      requirements: { vision: true, contextTokens: 4000 },
      prompt: "Read the image.",
    }),
  );
  assert.equal(result.error, undefined);
  assert.deepEqual(
    fixture.requests.map((r) => JSON.parse(r.body).model),
    ["large-vision"],
  );
});

test("provider quota one is work conserving and gives queued chat the next seat", async (t) => {
  const release: (() => void)[] = [];
  const fixture = await modelFixture(t, async () => {
    await new Promise<void>((resolve) => release.push(resolve));
    return undefined;
  });
  const providers = modelProviderConfig(await directory(t), {
    LOCAL_BASE_URL: process.env.OPENAI_BASE_URL,
    LOCAL_API: "responses",
    MODEL_PROVIDER_QUOTAS: JSON.stringify({ local: { total: 1, background: 3, interactive: 1 } }),
  });
  const call = (model: string, workClass: "background" | "interactive") =>
    run(
      tanstackAgent({
        model: `local/${model}`,
        providers,
        workClass,
        tools: [],
        maxSteps: 1,
        prompt: "Reply.",
      }),
    );
  const first = call("background-1", "background");
  const waitFor = async (count: number) => {
    for (let i = 0; i < 100 && fixture.requests.length < count; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(fixture.requests.length, count);
  };
  await waitFor(1);
  const second = call("background-2", "background");
  const third = call("background-3", "background");
  const chat = call("chat", "interactive");
  const calls = [first, second, third, chat];
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fixture.requests.length, 1, "one inference is dispatched at a time");
    release[0]();
    await waitFor(2);
    assert.equal(JSON.parse(fixture.requests[1].body).model, "chat");
    release[1]();
    await waitFor(3);
    release[2]();
    await waitFor(4);
    release[3]();
    for (const result of await Promise.all(calls)) assert.equal(result.error, undefined);
  } finally {
    for (const unblock of release) unblock();
    await Promise.all(calls);
  }
});

test("a worker parks provider interruption with completed tool receipts and saved progress", async (t) => {
  const fixture = await modelFixture(
    t,
    () => ({ name: "set_plan", arguments: { steps: ["Save the work"] } }),
    { cleanEof: (index) => index === 1 },
  );
  const dir = await directory(t),
    db = await createStore();
  const providers = modelProviderConfig(dir, {
    LOCAL_BASE_URL: process.env.OPENAI_BASE_URL,
    LOCAL_API: "responses",
  });
  const app = await createApp(db, {
    mode: "sample",
    agentBackend: "model",
    model: "local/worker",
    modelProviders: providers,
    dataDir: dir,
    host: "127.0.0.1",
    port: 8787,
    publicUrl: "http://localhost:8787",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  });
  t.after(async () => {
    await app.agent.stop();
    await db.close();
  });
  const task = await app.agent.createTask("owner", { prompt: "Save the work", kind: "plan" });
  await app.agent.worker.tick();
  const saved = await app.agent.getTask("owner", task.id);
  assert.equal(saved.status, "waiting_provider", saved.error ?? saved.question);
  assert.equal(saved.plan[0]?.title, "Save the work");
  const checkpoint = saved.state.providerCheckpoint as { messages: RunAgentInput["messages"] };
  assert.ok(checkpoint.messages.some((m) => m.role === "tool" && m.toolCallId === "call-0"));
  assert.equal(fixture.requests.length, 2);
});

test("a timed out unaccepted attempt leaves time for its configured fallback", async (t) => {
  let release = () => {};
  const fixture = await modelFixture(t, async (index) => {
    if (index === 0)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return undefined;
  });
  const providers = modelProviderConfig(await directory(t), {
    LOCAL_BASE_URL: process.env.OPENAI_BASE_URL,
    LOCAL_API: "responses",
    MODEL_ATTEMPT_TIMEOUT_MS: "1000",
    MODEL_DEADLINE_MS: "5000",
  });
  try {
    const result = await run(
      tanstackAgent({
        model: "local/timeout",
        fallbacks: ["local/fallback"],
        providers,
        tools: [],
        maxSteps: 1,
        prompt: "Reply.",
      }),
    );
    assert.equal(result.finished, true);
    assert.equal(result.error, undefined);
    assert.deepEqual(
      fixture.requests.map((r) => JSON.parse(r.body).model),
      ["timeout", "fallback"],
    );
  } finally {
    release();
  }
});

test("ChatGPT 429 then Grok 503 falls back to MiMo only, with shared Retry-After health", async (t) => {
  const fixture = await modelFixture(t, () => undefined, {
    errorStatus: (index) => (index === 0 ? 429 : index === 1 ? 503 : undefined),
    retryAfter: (index) => (index === 0 ? "60" : undefined),
  });
  const base = process.env.OPENAI_BASE_URL;
  assert.ok(base);
  const providers = modelProviderConfig(await directory(t), {
    MIMO_BASE_URL: "https://token-plan-sgp.xiaomimimo.com/v1",
    MIMO_API_KEY: "synthetic-plan-key",
  });
  await writeProtected(providers.chatgptFile, {
    issuer: "https://auth.openai.com",
    subject: "fixture",
    client_id: "oaiapp_fixture",
    ext_agent_host_id: "urn:uuid:12345678-1234-4123-8123-123456789abc",
    access_token: "synthetic-subscription",
    refresh_token: "synthetic-refresh",
    token_type: "Bearer",
    expires_in: 3600,
    scopes: ["chatgpt.tokens.use.direct"],
    saved_at: new Date().toISOString(),
  });
  await writeProtected(providers.grokFile, {
    version: 1,
    provider: "grok",
    token_endpoint: "https://auth.x.ai/oauth2/token",
    access_token: "synthetic-grok",
    refresh_token: "synthetic-refresh",
    token_type: "Bearer",
    expires_in: 900,
    saved_at: new Date().toISOString(),
  });
  const original = globalThis.fetch,
    routes: string[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    routes.push(request.url);
    assert.ok(
      [
        "https://api.openai.com/v1/responses",
        `${GROK_API_URL}/responses`,
        "https://token-plan-sgp.xiaomimimo.com/v1/responses",
      ].includes(request.url),
    );
    return original(`${base}/responses`, {
      method: "POST",
      body: await request.text(),
      headers: request.headers,
      signal: request.signal,
    });
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const router = new ModelRouter(providers);
  const agent = () =>
    tanstackAgent({
      model: "chatgpt/primary",
      fallbacks: ["grok/second", "mimo/third"],
      modelRouter: router,
      providers,
      tools: [],
      maxSteps: 1,
      prompt: "Reply.",
    });
  const first = await run(agent());
  assert.equal(first.error, undefined);
  assert.deepEqual(
    fixture.requests.map((r) => JSON.parse(r.body).model),
    ["primary", "second", "third"],
  );
  assert.equal(routes.length, 3, "SDK and router attempts must not multiply");
  const second = await run(agent());
  assert.equal(second.error, undefined);
  assert.deepEqual(
    fixture.requests.map((r) => JSON.parse(r.body).model),
    ["primary", "second", "third", "third"],
  );
  const status = router.status();
  assert.equal(status.active?.provider, "mimo");
  assert.equal(status.active?.fallback, true);
  assert.ok(
    (status.models.find((m) => m.model === "chatgpt/primary")?.cooldownUntil ?? 0) >
      Date.now() + 50000,
  );
  assert.doesNotMatch(
    JSON.stringify(status),
    /synthetic|Authorization|refresh_token|token-plan-sgp/,
  );
});

test("late terminal failure never emits success or dispatches a completed-looking tool", async (t) => {
  let effects = 0;
  const fixture = await modelFixture(t, () => ({ name: "effect", arguments: {} }), {
    lateFailure: () => true,
  });
  const providers = modelProviderConfig(await directory(t), {
    LOCAL_BASE_URL: process.env.OPENAI_BASE_URL,
    LOCAL_API: "responses",
  });
  let checkpoint: ProviderContinuationCheckpoint | undefined;
  const result = await run(
    tanstackAgent({
      model: "local/late",
      providers,
      tools: [
        defineTool({
          name: "effect",
          description: "Effect",
          parameters: z.object({}),
          execute: async () => {
            effects++;
            return { receipt: "once" };
          },
        }),
      ],
      maxSteps: 2,
      prompt: "Use the tool.",
      onProviderInterrupted: (value) => {
        checkpoint = value;
      },
    }),
  );
  assert.equal(result.finished, false);
  assert.match(String(result.error), /https:\/\/chatgpt.com\/settings\/usage/);
  assert.doesNotMatch(String(result.error), /private late error/);
  assert.equal(effects, 0);
  assert.equal(fixture.requests.length, 1);
  assert.equal(checkpoint?.accepted, true);
  assert.ok(!checkpoint?.messages.some((m) => m.role === "assistant" && m.toolCalls?.length));
});

test("empty-argument tools keep their stable call IDs and completed receipts on continuation", async (t) => {
  let effects = 0;
  const fixture = await modelFixture(
    t,
    (index) => (index === 0 ? { name: "effect", arguments: {} } : undefined),
    { noArgumentDelta: () => true, cleanEof: (index) => index === 1 },
  );
  const providers = modelProviderConfig(await directory(t), {
    LOCAL_BASE_URL: process.env.OPENAI_BASE_URL,
    LOCAL_API: "responses",
  });
  let checkpoint: ProviderContinuationCheckpoint | undefined;
  const agent = (model: string) =>
    tanstackAgent({
      model,
      providers,
      tools: [
        defineTool({
          name: "effect",
          description: "Effect",
          parameters: z.object({}),
          execute: async () => {
            effects++;
            return { receipt: "completed-once" };
          },
        }),
      ],
      maxSteps: 4,
      prompt: "Use the tool once, then complete.",
      onProviderInterrupted: (value) => {
        checkpoint = value;
      },
    });
  const interrupted = await run(agent("local/first"));
  assert.equal(interrupted.finished, false);
  assert.equal(effects, 1);
  assert.ok(checkpoint);
  const restored = await run(agent("local/second"), checkpoint.messages);
  assert.equal(restored.error, undefined);
  assert.equal(effects, 1, "safe history does not replay an already completed tool");
  const history = JSON.parse(fixture.requests[2].body).input;
  assert.ok(
    history.some(
      (item: Record<string, unknown>) =>
        item.type === "function_call_output" &&
        item.call_id === "call-0" &&
        String(item.output).includes("completed-once"),
    ),
  );
});

test("structured output shares capability filtering and the provider's inference seat", async (t) => {
  const releases: (() => void)[] = [];
  const fixture = await modelFixture(
    t,
    async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return undefined;
    },
    { text: () => '{"ok":true}' },
  );
  const providers = modelProviderConfig(await directory(t), {
    LOCAL_BASE_URL: process.env.OPENAI_BASE_URL,
    LOCAL_API: "responses",
    MODEL_PROVIDER_QUOTAS: '{"local":{"total":1}}',
    MODEL_CAPABILITIES: JSON.stringify({
      "local/plain": { tools: true, vision: false, structuredOutput: false, contextTokens: 32768 },
    }),
  });
  const router = new ModelRouter(providers);
  const logger = resolveDebugOption(false);
  const options = {
    chatOptions: {
      model: "plain",
      messages: [{ role: "user" as const, content: "Return JSON." }],
      logger,
    },
    outputSchema: {
      type: "object" as const,
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    },
  };
  const first = modelAdapter(
    "local/plain",
    ["local/schema"],
    providers,
    undefined,
    undefined,
    undefined,
    { router, workClass: "background" },
  ).structuredOutput(options);
  const second = modelAdapter("local/schema", [], providers, undefined, undefined, undefined, {
    router,
  });
  const streamed = (async () => {
    let text = "",
      finished = false;
    assert.ok(second.structuredOutputStream);
    for await (const event of second.structuredOutputStream(options)) {
      if (event.type === "TEXT_MESSAGE_CONTENT") text += event.delta;
      if (event.type === "RUN_FINISHED") finished = true;
    }
    assert.equal(finished, true);
    return { data: JSON.parse(text) };
  })();
  const waitFor = async (count: number) => {
    for (let i = 0; i < 100 && fixture.requests.length < count; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(fixture.requests.length, count);
  };
  await waitFor(1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fixture.requests.length, 1);
  assert.equal(JSON.parse(fixture.requests[0].body).model, "schema");
  releases[0]();
  await waitFor(2);
  releases[1]();
  assert.deepEqual(
    (await Promise.all([first, streamed])).map((result) => result.data),
    [{ ok: true }, { ok: true }],
  );
  assert.equal(router.status().providers[0].active, 0);
});

test("a measured lower quota keeps a chat seat while three background calls compete", async (t) => {
  const releases: (() => void)[] = [];
  const fixture = await modelFixture(t, async () => {
    await new Promise<void>((resolve) => releases.push(resolve));
    return undefined;
  });
  const providers = modelProviderConfig(await directory(t), {
    LOCAL_BASE_URL: process.env.OPENAI_BASE_URL,
    LOCAL_API: "responses",
    MODEL_DEADLINE_MS: "2000",
    MODEL_ATTEMPT_TIMEOUT_MS: "2000",
  });
  const router = new ModelRouter(providers);
  router.observeQuota("ollama", 2);
  const agents: BuiltInAgent[] = [];
  const call = (model: string, workClass: "background" | "interactive") => {
    const agent = tanstackAgent({
      model: `local/${model}`,
      providers,
      workClass,
      modelRouter: router,
      tools: [],
      maxSteps: 1,
      prompt: "Reply.",
    });
    agents.push(agent);
    return run(agent);
  };
  const background = [call("b1", "background"), call("b2", "background"), call("b3", "background")];
  const waitFor = async (count: number) => {
    for (let i = 0; i < 100 && fixture.requests.length < count; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(fixture.requests.length, count);
  };
  let chat: ReturnType<typeof run> | undefined;
  try {
    await waitFor(1);
    chat = call("chat", "interactive");
    await waitFor(2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(
      fixture.requests.map((r) => JSON.parse(r.body).model),
      ["b1", "chat"],
    );
    assert.deepEqual(router.status().providers[0].quota, {
      total: 2,
      background: 1,
      interactive: 1,
    });
    releases[0]();
    await waitFor(3);
    releases[2]();
    await waitFor(4);
    releases[3]();
    releases[1]();
    for (const result of await Promise.all([...background, chat]))
      assert.equal(result.error, undefined);
  } finally {
    for (const agent of agents) agent.abortRun();
    for (const release of releases) release();
    await Promise.all([...background, ...(chat ? [chat] : [])]);
  }
});

test("insufficient capabilities preserve the request without dispatch and an explicit preflight can unblock it", async (t) => {
  const fixture = await modelFixture(t, () => undefined);
  const providers = modelProviderConfig(await directory(t), {
    LOCAL_BASE_URL: process.env.OPENAI_BASE_URL,
    LOCAL_API: "responses",
  });
  const router = new ModelRouter(providers);
  let checkpoint: ProviderContinuationCheckpoint | undefined;
  const agent = () =>
    tanstackAgent({
      model: "local/declared-later",
      providers,
      modelRouter: router,
      requirements: { vision: true },
      tools: [],
      maxSteps: 1,
      prompt: "Inspect the image.",
      onProviderInterrupted: (value) => {
        checkpoint = value;
      },
    });
  const blocked = await run(agent());
  assert.equal(blocked.finished, false);
  assert.equal(fixture.requests.length, 0);
  assert.equal(checkpoint?.code, "MODEL_CAPABILITY_UNAVAILABLE");
  assert.equal(checkpoint?.messages[0].content, "Complete the requested work.");
  router.confirmCapabilities("local/declared-later", {
    tools: true,
    vision: true,
    structuredOutput: true,
    contextTokens: 32768,
  });
  const unblocked = await run(agent());
  assert.equal(unblocked.error, undefined);
  assert.equal(fixture.requests.length, 1);
  assert.equal(router.status().models[0].capabilitySource, "preflight");
});

test("configuration rejects an unimplemented shared quota guarantee and invalid capability declarations", () => {
  assert.throws(
    () => modelProviderConfig(".openmuse", { MODEL_QUOTA_SCOPE: "shared" }),
    /shared inference admission adapter/,
  );
  assert.throws(() =>
    modelProviderConfig(".openmuse", { MODEL_CAPABILITIES: '{"local/fixture":{"vision":"yes"}}' }),
  );
  assert.throws(() =>
    modelProviderConfig(".openmuse", { MODEL_PROVIDER_QUOTAS: '{"grok":{"total":0}}' }),
  );
});

test("image bytes are sent intact without treating their base64 encoding as text context", async (t) => {
  const fixture = await modelFixture(t, () => undefined);
  const providers = modelProviderConfig(await directory(t), {
    LOCAL_BASE_URL: process.env.OPENAI_BASE_URL,
    LOCAL_API: "responses",
    MODEL_CAPABILITIES: JSON.stringify({
      "local/vision": { tools: true, vision: true, structuredOutput: true, contextTokens: 32768 },
    }),
  });
  const bytes = Buffer.alloc(100000, 1).toString("base64");
  const result = await run(
    tanstackAgent({
      model: "local/vision",
      providers,
      prompt: "Describe the image.",
      tools: [],
      maxSteps: 1,
    }),
    [
      {
        id: "image",
        role: "user",
        content: [
          { type: "image", source: { type: "data", value: bytes, mimeType: "image/jpeg" } },
        ],
      },
    ],
  );
  assert.equal(result.error, undefined);
  assert.equal(fixture.requests.length, 1);
  assert.ok(
    fixture.requests[0].body.includes(bytes),
    "context accounting never strips the dispatched image",
  );
});

for (const provider of ["anthropic", "google-gemini"] as const) {
  test(`${provider} keeps its existing gateway normalization and does not multiply SDK retries`, async (t) => {
    const fixture = await modelFixture(t, () => undefined, {
      errorStatus: (index) => (index === 0 ? 503 : undefined),
    });
    const base = process.env.OPENAI_BASE_URL;
    assert.ok(base);
    const names =
      provider === "anthropic"
        ? ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]
        : ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_BASE_URL"];
    const previous = names.map((name) => process.env[name]);
    process.env[names[0]] = "synthetic-test-key";
    process.env[names[1]] = `${new URL(base).origin}/${provider === "anthropic" ? "v1" : "v1beta"}`;
    t.after(() => {
      names.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name];
        else process.env[name] = previous[index];
      });
    });
    const providers = modelProviderConfig(await directory(t), {
      LOCAL_BASE_URL: base,
      LOCAL_API: "responses",
    });
    const result = await run(
      tanstackAgent({
        model: `${provider}/fixture`,
        fallbacks: ["local/fallback"],
        providers,
        tools: [],
        maxSteps: 1,
        prompt: "Reply.",
      }),
    );
    assert.equal(result.error, undefined);
    assert.equal(fixture.requests.length, 2, "one rejected SDK request then one explicit fallback");
    assert.ok(
      fixture.requests[0].path.startsWith(
        provider === "anthropic" ? "/v1/messages" : "/v1beta/models/fixture:",
      ),
    );
    assert.equal(fixture.requests[1].path, "/v1/responses");
    assert.equal(JSON.parse(fixture.requests[1].body).model, "fallback");
  });
}

test("closing a stream after delivered text releases its shared inference seat", async (t) => {
  await modelFixture(t, () => undefined, { text: () => "Partial text" });
  const providers = modelProviderConfig(await directory(t), {
    LOCAL_BASE_URL: process.env.OPENAI_BASE_URL,
    LOCAL_API: "responses",
    MODEL_PROVIDER_QUOTAS: '{"local":{"total":1}}',
  });
  const router = new ModelRouter(providers);
  const adapter = modelAdapter("local/cancelled", [], providers, undefined, undefined, undefined, {
    router,
  });
  let delivered = "";
  for await (const event of adapter.chatStream({
    model: "cancelled",
    messages: [{ role: "user", content: "Reply." }],
    logger: resolveDebugOption(false),
  })) {
    if (event.type === "TEXT_MESSAGE_CONTENT") {
      delivered += event.delta;
      break;
    }
  }
  assert.equal(delivered, "Partial text");
  assert.equal(
    router.status().providers[0].active,
    0,
    "consumer cancellation cannot leak a quota seat",
  );
});

test("continuation validation keeps typed receipts and excludes provider metadata and media bytes", () => {
  const checkpoint = providerContinuationCheckpointSchema.parse({
    version: 1,
    messages: [
      {
        id: "u",
        role: "user",
        content: [
          { type: "text", text: "Inspect the attachment." },
          {
            type: "image",
            source: { type: "data", mimeType: "image/png", value: "synthetic-media-bytes" },
          },
        ],
      },
      {
        id: "a",
        role: "assistant",
        content: "Completed one action.",
        encryptedValue: "synthetic-reasoning",
        metadata: { internal: "synthetic-provider-secret" },
        toolCalls: [
          {
            id: "completed",
            type: "function",
            function: { name: "effect", arguments: "{}" },
            metadata: { internal: "synthetic-provider-secret" },
            encryptedValue: "synthetic-reasoning",
          },
          { id: "fragment", type: "function", function: { name: "effect", arguments: "{" } },
        ],
      },
      { id: "t", role: "tool", toolCallId: "completed", content: '{"receipt":"once"}' },
    ],
    partialText: "Saved reply.",
    rejectedModel: "local/first",
    accepted: true,
    code: "MODEL_PROVIDER_INTERRUPTED",
  });
  const serialized = JSON.stringify(checkpoint);
  assert.ok(!/synthetic-(media|reasoning|provider)/.test(serialized));
  assert.equal(checkpoint.messages[0].content, "Inspect the attachment.");
  const assistant = checkpoint.messages[1];
  assert.equal(assistant.role, "assistant");
  if (assistant.role === "assistant")
    assert.deepEqual(
      assistant.toolCalls?.map((call) => call.id),
      ["completed"],
    );
  assert.equal(checkpoint.messages[2].role, "tool");
  assert.equal(
    providerContinuationCheckpointSchema.safeParse({
      ...checkpoint,
      messages: [{ id: "r", role: "reasoning", content: "Private reasoning." }],
    }).success,
    false,
  );
});
