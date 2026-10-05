import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { MediaService } from "../apps/server/src/media-tools.ts";
import {
  CODEX_CLIENT_ID,
  codexAccessToken,
  codexDeviceLogin,
  codexStatus,
  disconnectCodex,
} from "../apps/server/src/providers/codex-auth.ts";
import {
  codexImageProvider,
  codexImageResponse,
} from "../apps/server/src/providers/codex-images.ts";
import { modelProviderConfig } from "../apps/server/src/providers/config.ts";
import { readProtected, writeProtected } from "../apps/server/src/providers/credential-store.ts";
import { availableImageModels } from "../apps/server/src/providers/images.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=",
  "base64",
);
const saved = (overrides: object = {}) => ({
  version: 1,
  provider: "codex",
  access_token: "codex-access",
  refresh_token: "codex-refresh",
  expires_at: Date.now() + 3600000,
  ...overrides,
});
const sse = (...events: object[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
const image = {
  type: "image_generation_call",
  status: "completed",
  result: png.toString("base64"),
};
async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "okami-codex-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("Codex device authorization polls the official protocol, exchanges PKCE and saves only its independent protected credential", async (t) => {
  const path = await directory(t),
    file = join(path, "codex.json"),
    siwc = join(path, "chatgpt.json");
  await writeProtected(siwc, { preserved: "existing-token-sharing" });
  let now = Date.now(),
    polls = 0;
  let pendingCancelled = false;
  const requests: string[] = [];
  const ctx = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request.url);
      assert.equal(request.redirect, "error");
      if (request.url.endsWith("/deviceauth/usercode")) {
        assert.deepEqual(await request.json(), { client_id: CODEX_CLIENT_ID });
        return Response.json({
          device_auth_id: "private-device-id",
          user_code: "ABCD-1234",
          interval: "3",
        });
      }
      if (request.url.endsWith("/deviceauth/token")) {
        assert.deepEqual(await request.json(), {
          device_auth_id: "private-device-id",
          user_code: "ABCD-1234",
        });
        return ++polls === 1
          ? new Response(
              new ReadableStream({
                cancel() {
                  pendingCancelled = true;
                },
              }),
              { status: 403 },
            )
          : Response.json({
              authorization_code: "private-exchange",
              code_verifier: "private-pkce",
            });
      }
      assert.equal(request.url, "https://auth.openai.com/oauth/token");
      const form = new URLSearchParams(await request.text());
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("redirect_uri"), "https://auth.openai.com/deviceauth/callback");
      assert.equal(form.get("code_verifier"), "private-pkce");
      return Response.json({
        access_token: "new-codex-access",
        refresh_token: "new-codex-refresh",
        expires_in: 3600,
      });
    },
  };
  const codes: object[] = [];
  await codexDeviceLogin(file, (code) => codes.push(code), ctx);
  assert.equal(codes.length, 1);
  assert.deepEqual(codes[0], {
    url: "https://auth.openai.com/codex/device",
    code: "ABCD-1234",
    expiresAt: now - 6000 + 900000,
    intervalSeconds: 3,
  });
  assert.ok(!JSON.stringify(codes).includes("private"));
  assert.equal(requests.length, 4);
  assert.equal(pendingCancelled, true);
  assert.deepEqual(await codexStatus(file), { connected: true });
  assert.deepEqual(await readProtected(siwc), { preserved: "existing-token-sharing" });
  await disconnectCodex(file);
  assert.deepEqual(await codexStatus(file), { connected: false });
  assert.ok(await readProtected(siwc));
});

test("cancelled or malformed device authorization cannot overwrite an existing Codex connection", async (t) => {
  const file = join(await directory(t), "codex.json");
  const original = saved();
  await writeProtected(file, original);
  const abort = new AbortController();
  const fetcher: typeof fetch = async () =>
    Response.json({ device_auth_id: "private", user_code: "CODE", interval: 1 });
  await assert.rejects(
    codexDeviceLogin(file, () => abort.abort(), { fetch: fetcher }, abort.signal),
    /abort/i,
  );
  assert.deepEqual(await readProtected(file), original);
  await assert.rejects(
    codexDeviceLogin(file, () => {}, {
      fetch: async () => Response.json({ user_code: "malformed" }),
    }),
    /iniciar/i,
  );
  assert.deepEqual(await readProtected(file), original);
});

test("Codex refresh is serialized and a consumer cancellation cannot discard a rotated credential", async (t) => {
  const file = join(await directory(t), "codex.json");
  await writeProtected(file, saved({ expires_at: Date.now() - 1 }));
  const abort = new AbortController();
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(String(input), "https://auth.openai.com/oauth/token");
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("refresh_token"), "codex-refresh");
    abort.abort();
    return Response.json({
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
    });
  };
  await assert.rejects(codexAccessToken(file, { fetch: fetcher }, abort.signal), /abort/i);
  assert.deepEqual(await codexAccessToken(file, { fetch: fetcher }), {
    token: "rotated-access",
    accountId: undefined,
  });
  assert.equal(calls, 1);
});

test("Codex image stream requires a completed generation and never trusts an earlier image over terminal failure", async () => {
  const output = await codexImageResponse(
    sse(
      { type: "response.output_item.done", item: image },
      { type: "response.completed", response: { status: "completed", output: [] } },
    ),
  );
  assert.deepEqual(await output.json(), { data: [{ b64_json: png.toString("base64") }] });
  await assert.rejects(
    codexImageResponse(sse({ type: "response.output_item.done", item: image })),
    /interrompida/,
  );
  await assert.rejects(
    codexImageResponse(
      sse(
        { type: "response.output_item.done", item: image },
        { type: "response.failed", response: { error: { code: "rate_limit" } } },
      ),
    ),
    /não concluiu/,
  );
  await assert.rejects(
    codexImageResponse(
      sse(
        { type: "response.output_item.done", item: image },
        {
          type: "response.completed",
          response: { output: [{ type: "image_generation_call", status: "failed" }] },
        },
      ),
    ),
    /sem entregar/,
  );
});

test("GPT Image dispatch uses only Codex subscription credentials and produces a downloadable image before Grok", async (t) => {
  const server = await taskRuntime(t);
  const providers = modelProviderConfig(server.directory, {});
  await writeProtected(providers.codexFile!, saved({ account_id: "codex-account" }));
  await writeProtected(providers.chatgptFile, {
    provider: "chatgpt",
    secret: "must-not-be-read-as-codex",
  });
  await writeProtected(providers.grokFile, { provider: "grok", secret: "must-not-be-read" });
  let calls = 0;
  const upstream: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(String(input), "https://chatgpt.com/backend-api/codex/responses");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), "Bearer codex-access");
    assert.equal(headers.get("ChatGPT-Account-Id"), "codex-account");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(body.model, "gpt-6-astra");
    const currentTime = /Current UTC date and time: ([^\s]+)/.exec(body.instructions)?.[1];
    assert.ok(currentTime, "The hosted image agent needs the same current-time grounding as chat");
    assert.ok(Math.abs(Date.parse(currentTime) - Date.now()) < 60000);
    assert.deepEqual(body.tools, [
      { type: "image_generation", model: "gpt-image-2", size: "1024x1536", output_format: "png" },
    ]);
    return sse({ type: "response.completed", response: { status: "completed", output: [image] } });
  };
  const media = new MediaService(
    server.db,
    server.files,
    { ...server.agent.config, modelProviders: providers },
    upstream,
  );
  assert.equal(
    (await availableImageModels("chatgpt/gpt-6-sol", providers))[0],
    "codex/gpt-image-2",
  );
  const ref = await media.generatedImage(
    "owner",
    "chatgpt/gpt-6-sol",
    {
      prompt: "A garden infographic",
      aspectRatio: "3:4",
      operationId: "gpt-image",
      name: "Garden",
    },
    "image-test",
  );
  assert.ok("fileId" in ref);
  assert.deepEqual(await server.files.bytes("owner", ref.fileId), png);
  assert.equal(calls, 1);
  assert.equal((await media.imageCapabilities("chatgpt/gpt-6-sol")).chatgpt?.imageGeneration, true);
});

test("GPT Image rejects unsupported subscription routes without silently trying an API key or Grok", async (t) => {
  const file = join(await directory(t), "codex.json");
  await writeProtected(file, saved());
  const config = modelProviderConfig(await directory(t), { CODEX_AUTH_FILE: file });
  let calls = 0;
  const provider = codexImageProvider(config, async () => {
    calls++;
    return Response.json({ error: { code: "quota_exceeded" } }, { status: 429 });
  });
  await assert.rejects(provider.generate({ prompt: "test" }), /limitado/);
  assert.equal(calls, 1);
});

test("a credential refresh failure before image dispatch can retry the same request after reconnection", async (t) => {
  const server = await taskRuntime(t);
  const providers = modelProviderConfig(server.directory, {});
  assert.ok(providers.codexFile);
  await writeProtected(providers.codexFile, saved({ expires_at: Date.now() - 1 }));
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    assert.equal(String(input), "https://auth.openai.com/oauth/token");
    return Response.json({ error: { code: "temporarily_unavailable" } }, { status: 503 });
  });
  let imageCalls = 0;
  const media = new MediaService(
    server.db,
    server.files,
    { ...server.agent.config, modelProviders: providers },
    async () => {
      imageCalls++;
      return sse({
        type: "response.completed",
        response: { status: "completed", output: [image] },
      });
    },
  );
  const args = { prompt: "A simple image", provider: "chatgpt", operationId: "resume-after-login" };
  await assert.rejects(
    media.generatedImage("owner", "chatgpt/gpt-6-sol", args, "retry"),
    /indisponível/,
  );
  assert.equal(imageCalls, 0);
  assert.deepEqual(await server.db.list("owner", "image-generations"), []);
  await writeProtected(providers.codexFile, saved());
  const result = await media.generatedImage("owner", "chatgpt/gpt-6-sol", args, "retry");
  assert.ok("fileId" in result);
  assert.equal(imageCalls, 1);
});
