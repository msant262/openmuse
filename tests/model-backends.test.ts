import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { EventType, type RunAgentInput } from "@ag-ui/core";
import { type BuiltInAgent, defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import { agentConfigured } from "../apps/server/src/agent.ts";
import type { Config } from "../apps/server/src/config.ts";
import { tanstackAgent } from "../apps/server/src/engine/tanstack-agent.ts";
import { modelProviderConfig, orderedModels } from "../apps/server/src/providers/config.ts";
import { writeProtected } from "../apps/server/src/providers/credential-store.ts";
import { httpProviderError } from "../apps/server/src/providers/errors.ts";
import { imageProvider } from "../apps/server/src/providers/images.ts";
import { modelCapabilities } from "../apps/server/src/providers/models.ts";
import { providerFetch, siwcRequest } from "../apps/server/src/providers/transport.ts";
import { modelFixture } from "./helpers/model.ts";

async function directory(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "openmuse-provider-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function run(agent: BuiltInAgent) {
  const input: RunAgentInput = {
    threadId: "providers",
    runId: "provider-run",
    messages: [{ id: "m", role: "user", content: "Use a tool then reply." }],
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  };
  const events: { type: string; [key: string]: unknown }[] = [];
  let failure: string | undefined;
  await new Promise<void>((resolve) =>
    agent.run(input).subscribe({
      next: (event) => {
        events.push(event as { type: string; [key: string]: unknown });
      },
      error: (error) => {
        failure = error instanceof Error ? error.message : String(error);
        resolve();
      },
      complete: resolve,
    }),
  );
  return {
    events,
    error: events.find((event) => event.type === EventType.RUN_ERROR)?.message ?? failure,
    finished: events.some((event) => event.type === EventType.RUN_FINISHED),
  };
}

test("ordered per-request fallback keeps committed tool history and advances without rerunning tools", async (t) => {
  let executions = 0;
  const fixture = await modelFixture(
    t,
    (index) => (index === 1 ? { name: "record_step", arguments: { text: "once" } } : undefined),
    { errorStatus: (index) => ([0, 2].includes(index) ? 403 : undefined) },
  );
  const providers = modelProviderConfig(await directory(t), {
    LOCAL_BASE_URL: process.env.OPENAI_BASE_URL,
    LOCAL_API: "responses",
  });
  const outcome = await run(
    tanstackAgent({
      model: "openai/first",
      fallbacks: ["local/second", "local/third"],
      providers,
      maxSteps: 6,
      prompt: "Use the tool once.",
      tools: [
        defineTool({
          name: "record_step",
          description: "Record one step",
          parameters: z.object({ text: z.string() }),
          execute: async () => {
            executions++;
            return { receipt: "committed-once" };
          },
        }),
      ],
    }),
  );
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.finished, true);
  assert.equal(executions, 1);
  assert.deepEqual(
    fixture.requests.map((r) => JSON.parse(r.body).model),
    ["first", "second", "second", "third"],
  );
  const history = JSON.parse(fixture.requests[3].body).input;
  assert.ok(
    history.some(
      (item: Record<string, unknown>) =>
        item.type === "function_call_output" && String(item.output).includes("committed-once"),
    ),
  );
  assert.ok(
    outcome.events.some((event) => event.type === "CUSTOM" && event.name === "openmuse.model"),
  );
});

test("missing subscription credentials can fall back to a keyless local model", async (t) => {
  const fixture = await modelFixture(t, () => undefined);
  const dir = await directory(t),
    providers = modelProviderConfig(dir, {
      LOCAL_BASE_URL: process.env.OPENAI_BASE_URL,
      LOCAL_API: "responses",
    });
  const config = {
    agentBackend: "model",
    model: "chatgpt/account-model",
    modelFallbacks: ["local/qwen3:8b"],
    modelProviders: providers,
    dataDir: dir,
  } as Config;
  assert.equal(agentConfigured(config), true);
  const outcome = await run(
    tanstackAgent({
      model: config.model!,
      fallbacks: config.modelFallbacks,
      providers,
      prompt: "Reply.",
      maxSteps: 2,
      tools: [],
    }),
  );
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.finished, true);
  assert.equal(fixture.requests.length, 1);
  assert.equal(JSON.parse(fixture.requests[0].body).model, "qwen3:8b");
});

test("fallback never switches after an accepted stream, partial text or tool call", async (t) => {
  for (const option of ["dropAfterStart", "dropAfterText", "errorPart"] as const) {
    await t.test(option, async (t) => {
      const fixture = await modelFixture(t, () => undefined, {
        [option]: (index: number) => index === 0,
      });
      const providers = modelProviderConfig(await directory(t), {
        LOCAL_BASE_URL: process.env.OPENAI_BASE_URL,
        LOCAL_API: "responses",
      });
      const outcome = await run(
        tanstackAgent({
          model: "openai/first",
          fallbacks: ["local/second"],
          providers,
          prompt: "Reply.",
          maxSteps: 2,
          tools: [],
        }),
      );
      assert.ok(outcome.error);
      assert.equal(outcome.finished, false);
      assert.equal(fixture.requests.length, 1);
      if (option === "dropAfterText")
        assert.equal(
          outcome.events
            .filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK)
            .map((e) => e.delta)
            .join(""),
          "Hello partial ",
        );
    });
  }
});

test("generic compatible Chat Completions dispatches arbitrary model IDs and local tool results", async (t) => {
  const requests: {
    path: string;
    headers: Record<string, string | string[] | undefined>;
    body: Record<string, unknown>;
  }[] = [];
  let executions = 0;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push({ path: request.url!, headers: request.headers, body: JSON.parse(raw) });
    const index = requests.length - 1;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (delta: object, finish_reason: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({ id: `completion-${index}`, object: "chat.completion.chunk", created: 1, model: "vendor/arbitrary:latest", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    if (index === 0) {
      emit({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call-one",
            type: "function",
            function: { name: "record_step", arguments: '{"text":"once"}' },
          },
        ],
      });
      emit({}, "tool_calls");
    } else {
      emit({ role: "assistant", content: "Complete" });
      emit({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const providers = modelProviderConfig(await directory(t), {
    OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    OPENAI_COMPATIBLE_API_KEY: "dedicated-compatible-key",
  });
  const outcome = await run(
    tanstackAgent({
      model: "compatible/vendor/arbitrary:latest",
      providers,
      prompt: "Use the tool once.",
      maxSteps: 4,
      tools: [
        defineTool({
          name: "record_step",
          description: "Record",
          parameters: z.object({ text: z.string() }),
          execute: async () => {
            executions++;
            return { receipt: "once" };
          },
        }),
      ],
    }),
  );
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.finished, true);
  assert.equal(executions, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].path, "/v1/chat/completions");
  assert.equal(requests[0].body.model, "vendor/arbitrary:latest");
  assert.equal(requests[0].headers.authorization, "Bearer dedicated-compatible-key");
  assert.ok(
    (requests[1].body.messages as { role: string; content: string }[]).some(
      (message) => message.role === "tool" && message.content.includes("receipt"),
    ),
  );
});

test("SIWC streamed tools execute once and continue only after verified inference completion", async (t) => {
  for (const scenario of [
    "completed with output",
    "completed with empty output",
    "eof",
    "incomplete",
    "failed",
    "late failure",
  ] as const) {
    await t.test(scenario, async (t) => {
      let executions = 0;
      const fixture = await modelFixture(
        t,
        (index) => (index === 0 ? { name: "computer_status", arguments: {} } : undefined),
        {
          toolNamespace: "openmuse",
          emptyCompletedOutput: (index) => index === 0 && scenario !== "completed with output",
          terminalStatus: (index) =>
            index === 0 &&
            (scenario === "eof" || scenario === "incomplete" || scenario === "failed")
              ? scenario
              : "completed",
          lateFailure: (index) => index === 0 && scenario === "late failure",
          text: (index) => (index === 1 ? "Registro confirmado." : undefined),
        },
      );
      const providers = modelProviderConfig(await directory(t), {});
      await writeProtected(providers.chatgptFile, {
        issuer: "https://auth.openai.com",
        subject: "account",
        client_id: "oaiapp_fixture",
        ext_agent_host_id: "urn:uuid:12345678-1234-4123-8123-123456789abc",
        access_token: "subscription-access",
        refresh_token: "subscription-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        scopes: ["chatgpt.tokens.use.direct"],
        saved_at: new Date().toISOString(),
      });
      const originalFetch = globalThis.fetch;
      const inferenceUrl = process.env.OPENAI_BASE_URL!;
      const headers: string[] = [];
      globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        assert.equal(request.url, "https://api.openai.com/v1/responses");
        assert.equal(request.redirect, "error");
        headers.push(request.headers.get("Authorization")!);
        return originalFetch(`${inferenceUrl}/responses`, {
          method: request.method,
          headers: request.headers,
          body: await request.text(),
          signal: request.signal,
        });
      };
      t.after(() => {
        globalThis.fetch = originalFetch;
      });
      const outcome = await run(
        tanstackAgent({
          model: "chatgpt/account-model",
          providers,
          prompt: "Use the tool once.",
          maxSteps: 4,
          tools: [
            defineTool({
              name: "computer_status",
              description: "Read status",
              parameters: z.object({}),
              execute: async (args) => {
                assert.deepEqual(args, {});
                executions++;
                return { receipt: "one" };
              },
            }),
          ],
        }),
      );
      if (scenario !== "completed with output" && scenario !== "completed with empty output") {
        assert.ok(outcome.error, "a missing or failed provider terminal must surface an error");
        assert.equal(outcome.finished, false);
        assert.equal(executions, 0, "an unconfirmed call must never be executed");
        assert.equal(fixture.requests.length, 1, "an accepted inference must not be replayed");
        assert.equal(
          outcome.events.some((event) => event.type === EventType.TOOL_CALL_RESULT),
          false,
        );
        return;
      }
      assert.equal(outcome.error, undefined);
      assert.equal(executions, 1);
      assert.equal(outcome.finished, true);
      assert.equal(
        outcome.events
          .filter((event) => event.type === EventType.TEXT_MESSAGE_CHUNK)
          .map((event) => event.delta)
          .join(""),
        "Registro confirmado.",
      );
      const receipt = outcome.events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
      assert.ok(receipt);
      assert.equal(receipt.toolCallId, "call-0");
      assert.deepEqual(JSON.parse(String(receipt.content)), { receipt: "one" });
      assert.equal(fixture.requests.length, 2);
      assert.deepEqual(headers, ["Bearer subscription-access", "Bearer subscription-access"]);
      for (const request of fixture.requests) {
        const body = JSON.parse(request.body);
        assert.equal(body.store, false);
        assert.equal(body.stream, true);
        assert.ok(Array.isArray(body.input));
        assert.equal(body.instructions, "Use the tool once.");
        assert.equal(body.tools[0].type, "namespace");
        assert.equal(body.tools[0].name, "openmuse");
        assert.ok(
          body.tools[0].tools.some((tool: { name: string }) => tool.name === "computer_status"),
        );
      }
      const replay = JSON.parse(fixture.requests[1].body).input;
      assert.ok(
        replay.some(
          (item: Record<string, unknown>) =>
            item.type === "function_call" &&
            item.namespace === "openmuse" &&
            item.name === "computer_status",
        ),
      );
      assert.ok(
        replay.some(
          (item: Record<string, unknown>) =>
            item.type === "function_call_output" && item.call_id === "call-0",
        ),
      );
    });
  }
});

test("SIWC sanitizes preview fields, rejects audio/video/hosted images, and pins OAuth dispatch", async (t) => {
  const prepared = siwcRequest({
    model: "account-model",
    input: [
      { type: "message", role: "system", content: "instruction" },
      { type: "function_call", name: "run_command", call_id: "c", arguments: "{}" },
    ],
    tools: [{ type: "function", name: "run_command", parameters: { type: "object" } }],
    metadata: { private: true },
    previous_response_id: "remote",
    temperature: 0.2,
    max_output_tokens: 100,
    background: true,
    store: true,
    stream: false,
  });
  for (const field of [
    "metadata",
    "previous_response_id",
    "temperature",
    "max_output_tokens",
    "background",
  ])
    assert.equal(field in prepared, false);
  assert.equal(prepared.store, false);
  assert.equal(prepared.stream, true);
  assert.equal((prepared.input as { role: string }[])[0].role, "developer");
  for (const content of [
    [{ type: "input_audio", data: "raw" }],
    [{ type: "input_file", filename: "voice.mp3" }],
    [{ type: "input_video", data: "raw" }],
  ])
    assert.throws(() => siwcRequest({ input: [{ role: "user", content }] }), /Transcribe/);
  assert.throws(
    () => siwcRequest({ input: [], tools: [{ type: "image_generation" }] }),
    /Hosted tools/,
  );
  const state = { accepted: false };
  let sent = false;
  const transport = providerFetch(
    "chatgpt",
    state,
    modelProviderConfig(await directory(t), {}),
    async () => {
      sent = true;
      return new Response();
    },
  );
  await assert.rejects(
    transport("https://attacker.test/v1/responses", { method: "POST", body: "{}" }),
    /documented Responses/,
  );
  assert.equal(sent, false);
});

test("usage errors preserve safe status/code/request ID, never provider payloads or credential URLs", async () => {
  const error = await httpProviderError(
    "chatgpt",
    new Response(
      JSON.stringify({
        error: {
          code: "subscription_sharing_usage_limit_exceeded",
          param: "model",
          message: "secret-token https://attacker.test/?key=secret",
        },
      }),
      { status: 429, headers: { "x-request-id": "req-fixture" } },
    ),
  );
  assert.equal(error.status, 429);
  assert.equal(error.code, "subscription_sharing_usage_limit_exceeded");
  assert.equal(error.requestId, "req-fixture");
  assert.match(error.message, /https:\/\/chatgpt.com\/settings\/usage/);
  assert.doesNotMatch(error.message, /secret|attacker/);
  assert.equal(error.bodyShape, "error");
  const detail = await httpProviderError(
    "chatgpt",
    new Response(JSON.stringify({ detail: "private admission text" }), { status: 403 }),
  );
  assert.equal(detail.bodyShape, "detail");
  assert.doesNotMatch(detail.message, /private admission/);
});

test("MiMo is explicitly a Token Plan provider; model configuration/capabilities are conservative", () => {
  const config = modelProviderConfig(".openmuse", {
    MIMO_BASE_URL: "https://token-plan-cn.xiaomimimo.com/v1",
    MIMO_API_KEY: "plan-only",
    LOCAL_IMAGE_MODEL: "configured-image-model",
  });
  assert.equal(config.mimo?.api, "responses");
  assert.equal(config.mimo?.key, "plan-only");
  assert.throws(
    () => modelProviderConfig(".openmuse", { MIMO_BASE_URL: "https://api.xiaomimimo.com/v1" }),
    /Token Plan/,
  );
  assert.throws(
    () => modelProviderConfig(".openmuse", { LOCAL_BASE_URL: "http://secret@localhost/v1" }),
    /embedded credentials/,
  );
  assert.throws(() => modelProviderConfig(".openmuse", { LOCAL_API: "unknown" }));
  assert.equal(modelCapabilities("chatgpt/account-model", config).imageGeneration, false);
  assert.equal(modelCapabilities("local/image-model", config).imageGeneration, true);
  assert.equal(modelCapabilities("openai/text-model", config).imageGeneration, false);
  assert.deepEqual(
    orderedModels("chatgpt/account-model", [
      "mimo/mimo-v2.5-pro",
      "local/qwen3:8b",
      "mimo/mimo-v2.5-pro",
    ]).map((m) => m.spec),
    ["chatgpt/account-model", "mimo/mimo-v2.5-pro", "local/qwen3:8b"],
  );
});

test("keyless compatible transport removes placeholder auth and image requests require explicit capability", async () => {
  const config = modelProviderConfig(".openmuse", { LOCAL_IMAGE_MODEL: "operator-image-model" });
  let calls = 0;
  const upstream: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.headers.get("Authorization"), null);
    assert.equal(request.redirect, "error");
    if (request.url.endsWith("/images/generations")) {
      const body = await request.json();
      assert.equal(body.model, "operator-image-model");
      assert.equal(body.prompt, "Draw a flower");
    }
    calls++;
    return new Response("{}", { headers: { "Content-Type": "application/json" } });
  };
  await providerFetch(
    "local",
    { accepted: false },
    config,
    upstream,
  )(`${config.local.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: "Bearer keyless-local-provider" },
    body: "{}",
  });
  assert.equal(imageProvider("chatgpt/account-model", config, upstream), undefined);
  assert.equal(imageProvider("grok/text-model", config, upstream), undefined);
  const image = imageProvider("local/text-model", config, upstream);
  assert.ok(image);
  await image.generate({ model: "untrusted-model-override", prompt: "Draw a flower" });
  assert.equal(calls, 2);
});
