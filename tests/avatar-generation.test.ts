import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { AvatarService } from "../apps/server/src/avatars.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { DeploymentMaintenance } from "../apps/server/src/deployment-maintenance.ts";
import { deploymentStatus } from "../apps/server/src/deployment-status.ts";
import {
  type AvatarMediaProvider,
  GrokAvatarProvider,
} from "../apps/server/src/providers/avatar-media.ts";
import { ModelProviderError } from "../apps/server/src/providers/errors.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "avatar-generation-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost/callback",
    allowedOrigins: [],
  };
  const server = await createApp(db, config);
  const session = await server.auth.session();
  const request = (path: string, body?: unknown) =>
    server.app.request(`/api/agent/avatars${path}`, {
      headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
  return {
    db,
    config,
    server,
    request,
    close: async () => {
      await server.agent.stop();
      await db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("avatar generation reports unavailable credentials and does not enqueue a pretend generation", async () => {
  const f = await fixture();
  try {
    const state = await f.request("");
    assert.equal(state.status, 200);
    const body = await state.json();
    assert.equal(body.capabilities.images, false);
    assert.deepEqual(body.generations, []);
    const generated = await f.request("/generations", {
      requestId: "disabled-one",
      prompt: "A tiny teal dragon",
    });
    assert.equal(generated.status, 503);
    assert.deepEqual(await f.db.list("local-user", "avatar-generations"), []);
  } finally {
    await f.close();
  }
});

test("uploaded characters retain owned media and selection cannot use another owner's files", async () => {
  const f = await fixture();
  try {
    const poster = await f.server.files.importAttachment("local-user", "dragon.png", png, "test");
    const foreign = await f.server.files.importAttachment(
      "someone-else",
      "dragon.png",
      png,
      "test",
    );
    assert.equal(
      (
        await f.request("/import", {
          requestId: "foreign",
          label: "Dragon",
          posterFileId: foreign.id,
        })
      ).status,
      404,
    );
    const result = await f.request("/import", {
      requestId: "own",
      label: "Dragon",
      posterFileId: poster.id,
    });
    assert.equal(result.status, 201);
    const asset = await result.json();
    assert.equal(asset.poster.fileId, poster.id);
    assert.equal(asset.source, "upload");
    const selected = await f.request(`/${asset.id}/select`, { requestId: "choose-upload" });
    assert.equal(selected.status, 200);
    assert.equal((await f.server.agent.snapshot("local-user")).identity.avatarAssetId, asset.id);
    assert.deepEqual(await f.db.list("local-user", "avatar-generations"), []);
    const other = await f.server.auth.devices.pair("someone-else", "test");
    const rejected = await f.server.app.request(`/api/agent/avatars/${asset.id}/select`, {
      method: "POST",
      headers: { Authorization: `Bearer ${other.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "steal" }),
    });
    assert.equal(rejected.status, 404);
  } finally {
    await f.close();
  }
});

function providerFixture() {
  const calls = { images: 0, working: 0, submitted: [] as string[], polled: [] as string[] };
  const provider: AvatarMediaProvider = {
    capabilities: async () => ({ provider: "grok", images: true, videos: true }),
    images: async () => {
      calls.images++;
      return Array.from({ length: 4 }, () => ({ bytes: png, mimeType: "image/png" }));
    },
    workingPoster: async () => {
      calls.working++;
      return { bytes: png, mimeType: "image/png" };
    },
    submitVideo: async (_reference, motion) => {
      calls.submitted.push(motion);
      return `receipt-${motion}`;
    },
    video: async (id) => {
      calls.polled.push(id);
      return {
        status: "done",
        media: { bytes: Buffer.from("0000ftypisom0000"), mimeType: "video/mp4", durationMs: 6000 },
      };
    },
  };
  return { calls, provider };
}

test("an expired video session exposes a retry that resumes the existing receipt", async () => {
  const f = await fixture();
  const p = providerFixture();
  const original = p.provider.video;
  let expired = true;
  p.provider.video = async (...args) => {
    if (expired) throw new ModelProviderError("grok", "credentials_missing", "Reconnect Grok", 401);
    return original(...args);
  };
  try {
    const service = new AvatarService(f.db, f.server.files, f.config, p.provider);
    const job = await service.create("local-user", {
      requestId: "expired-session",
      prompt: "A soft fox",
    });
    await service.tick();
    const generated = await service.generation("local-user", job.id);
    await service.select("local-user", job.id, {
      requestId: "expired-select",
      assetId: generated.candidateIds[0],
    });
    await service.tick();
    await f.db.compareAndSwap("local-user", "avatar-generations", job.id, {}, { pollAt: 0 });
    await service.tick();
    assert.equal((await service.generation("local-user", job.id)).status, "failed");
    expired = false;
    await service.retry("local-user", job.id, { requestId: "reconnected" });
    await service.tick();
    assert.deepEqual(p.calls.submitted, ["idle"]);
    assert.deepEqual(p.calls.polled, ["receipt-idle"]);
    assert.deepEqual((await service.generation("local-user", job.id)).completedMotions, ["idle"]);
  } finally {
    await f.close();
  }
});

test("four real candidate receipts survive service restart and selected animations resume without resubmission", async () => {
  const f = await fixture();
  const p = providerFixture();
  try {
    let service = new AvatarService(f.db, f.server.files, f.config, p.provider);
    const created = await service.create("local-user", {
      requestId: "new-dragon",
      prompt: "A teal dragon with tiny horns",
    });
    assert.equal(
      (
        await service.create("local-user", {
          requestId: "new-dragon",
          prompt: "A teal dragon with tiny horns",
        })
      ).id,
      created.id,
    );
    await assert.rejects(
      service.create("local-user", { requestId: "new-dragon", prompt: "A different bird" }),
    );
    await service.tick();
    let job = await service.generation("local-user", created.id);
    assert.equal(job.status, "awaiting_selection");
    assert.equal(job.candidates.length, 4);
    assert.equal(new Set(job.candidates.map((asset) => asset.poster.fileId)).size, 4);
    assert.equal((await f.server.agent.snapshot("local-user")).identity.avatarAssetId, undefined);
    await assert.rejects(service.generation("other-owner", job.id));
    await service.select("local-user", job.id, {
      requestId: "select-dragon",
      assetId: job.candidates[2].id,
    });
    await service.tick(); // Submission receipt is durable before polling.
    service = new AvatarService(f.db, f.server.files, f.config, p.provider);
    for (let i = 0; i < 12; i++) {
      await f.db.compareAndSwap("local-user", "avatar-generations", job.id, {}, { pollAt: 0 });
      await service.tick();
      job = await service.generation("local-user", job.id);
      if (job.status === "succeeded") break;
    }
    assert.equal(job.status, "succeeded");
    assert.deepEqual(job.completedMotions, ["idle", "working", "responding"]);
    assert.equal(p.calls.images, 1);
    assert.equal(p.calls.working, 1);
    assert.deepEqual(p.calls.submitted, ["idle", "working", "responding"]);
    assert.deepEqual(p.calls.polled, ["receipt-idle", "receipt-working", "receipt-responding"]);
    const asset = job.candidates.find((candidate) => candidate.id === job.selectedAssetId);
    assert.ok(asset);
    assert.notEqual(asset.motions.working?.posterFileId, asset.poster.fileId);
    assert.match(asset.motions.working?.posterUrl ?? "", /signature=/);
    assert.equal(
      (await f.server.agent.snapshot("local-user")).identity.avatarAsset?.status,
      "ready",
    );
  } finally {
    await f.close();
  }
});

test("uncertain generation requires explicit retry and replaying that retry cannot charge again", async () => {
  const f = await fixture();
  const p = providerFixture();
  let failures = true;
  const original = p.provider.images;
  p.provider.images = async (...args) => {
    if (failures) throw new Error("Connection lost after upload");
    return original(...args);
  };
  try {
    const service = new AvatarService(f.db, f.server.files, f.config, p.provider);
    const job = await service.create("local-user", {
      requestId: "unknown",
      prompt: "A tiny violet cloud",
    });
    await service.tick();
    assert.equal((await service.generation("local-user", job.id)).status, "uncertain");
    await service.tick();
    await assert.rejects(
      service.retry("local-user", job.id, { requestId: "retry-no-consent" }),
      /cota/,
    );
    failures = false;
    const retry = { requestId: "retry-confirmed", acknowledgeUncertain: true };
    await service.retry("local-user", job.id, retry);
    await service.tick();
    assert.equal((await service.retry("local-user", job.id, retry)).status, "awaiting_selection");
    await service.tick();
    assert.equal(p.calls.images, 1);
  } finally {
    await f.close();
  }
});

test("a persisted dispatch with no provider receipt becomes uncertain instead of submitting again", async () => {
  const f = await fixture();
  const p = providerFixture();
  try {
    const service = new AvatarService(f.db, f.server.files, f.config, p.provider);
    const job = await service.create("local-user", {
      requestId: "crash",
      prompt: "An amber sleepy octopus",
    });
    await f.db.compareAndSwap(
      "local-user",
      "avatar-generations",
      job.id,
      {},
      { status: "running", dispatching: true, leaseUntil: 0 },
    );
    await service.tick();
    assert.equal((await service.generation("local-user", job.id)).status, "uncertain");
    assert.equal(p.calls.images, 0);
  } finally {
    await f.close();
  }
});

test("owned avatar video URLs support byte ranges for native and browser playback", async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from("0000ftypisomabcdefghijklmnop");
    const video = await f.server.files.importAttachment("local-user", "loop.mp4", bytes, "test");
    const response = await f.server.app.request(video.url, { headers: { Range: "bytes=4-11" } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("Content-Range"), `bytes 4-11/${bytes.length}`);
    assert.match(response.headers.get("Content-Disposition") ?? "", /^inline/);
    assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "ftypisom");
    const invalid = await f.server.app.request(video.url, { headers: { Range: "bytes=500-900" } });
    assert.equal(invalid.status, 416);
  } finally {
    await f.close();
  }
});

test("maintenance waits for admitted avatar work and reconciles existing videos without starting another", async () => {
  const f = await fixture();
  const p = providerFixture();
  let begin!: () => void, finish!: () => void;
  const started = new Promise<void>((r) => {
    begin = r;
  });
  const waiting = new Promise<void>((r) => {
    finish = r;
  });
  const images = p.provider.images;
  p.provider.images = async (...args) => {
    begin();
    await waiting;
    return images(...args);
  };
  try {
    const service = new AvatarService(f.db, f.server.files, f.config, p.provider);
    const maintenance = new DeploymentMaintenance(f.db);
    const job = await service.create("local-user", {
      requestId: "drain",
      prompt: "A velvet paper crane",
    });
    const generating = service.tick();
    await started;
    await maintenance.update("operator", "drain-one", "begin");
    assert.equal((await deploymentStatus(f.db)).readyForStoppedWriterBackup, false);
    finish();
    await generating;
    assert.equal((await deploymentStatus(f.db)).readyForStoppedWriterBackup, true);
    await maintenance.update("operator", "drain-one", "finish");
    const candidates = await service.generation("local-user", job.id);
    await service.select("local-user", job.id, {
      requestId: "drain-select",
      assetId: candidates.candidateIds[0],
    });
    await service.tick();
    await f.db.compareAndSwap("local-user", "avatar-generations", job.id, {}, { pollAt: 0 });
    await maintenance.update("operator", "drain-two", "begin");
    assert.equal((await deploymentStatus(f.db)).readyForStoppedWriterBackup, false);
    await service.tick();
    assert.equal((await deploymentStatus(f.db)).readyForStoppedWriterBackup, true);
    await service.tick();
    assert.deepEqual(p.calls.submitted, ["idle"]);
    assert.deepEqual(p.calls.polled, ["receipt-idle"]);
  } finally {
    finish();
    await f.close();
  }
});

test("returning to the default companion preserves the user's saved gallery", async () => {
  const f = await fixture();
  try {
    const poster = await f.server.files.importAttachment("local-user", "saved.png", png, "test");
    const asset = await (
      await f.request("/import", {
        requestId: "default-import",
        label: "Saved",
        posterFileId: poster.id,
      })
    ).json();
    await f.request(`/${asset.id}/select`, { requestId: "default-select" });
    const reset = await f.request("/default/select", { requestId: "restore-default" });
    assert.equal(reset.status, 200);
    const identity = (await f.server.agent.snapshot("local-user")).identity;
    assert.equal(identity.avatarAssetId, undefined);
    assert.equal(identity.avatarAsset, undefined);
    const state = await (await f.request("")).json();
    assert.equal(state.assets.length, 1);
    assert.equal(state.activeAssetId, undefined);
  } finally {
    await f.close();
  }
});

test("Grok media uses its own grant, creates a working reference, pins video frames and rejects foreign download hosts", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.config.dataDir, "credentials"), { mode: 0o700 });
    await writeFile(
      join(f.config.dataDir, "credentials/grok.json"),
      JSON.stringify({
        version: 1,
        provider: "grok",
        token_endpoint: "https://auth.x.ai/oauth2/token",
        access_token: "test-avatar-token",
        refresh_token: "test-refresh-token",
        expires_in: 3600,
        saved_at: new Date().toISOString(),
        token_type: "Bearer",
      }),
      { mode: 0o600 },
    );
    let outputUrl = "https://vidgen.x.ai/generated.mp4";
    let downloads = 0;
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    const upstream: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "vidgen.x.ai") {
        downloads++;
        assert.equal(new Headers(init?.headers).has("Authorization"), false);
        return new Response(Buffer.from("0000ftypisom0000"));
      }
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-avatar-token");
      const body = JSON.parse(String(init?.body ?? "{}"));
      requests.push({ path: url.pathname, body });
      if (url.pathname.includes("/images/"))
        return Response.json({
          data: Array.from({ length: Number(body.n) }, () => ({
            b64_json: png.toString("base64"),
          })),
        });
      if (url.pathname === "/v1/videos/generations")
        return Response.json({ request_id: "real-provider-receipt" });
      return Response.json({
        status: "done",
        video: { url: outputUrl, duration: 6, respect_moderation: true },
      });
    };
    const provider = new GrokAvatarProvider(
      { ...f.config, model: "chatgpt/selected-text-model" },
      upstream,
    );
    assert.equal((await provider.capabilities()).images, true);
    const images = await provider.images("A green dragon");
    assert.equal(images.length, 4);
    assert.equal(requests[0].body.model, "grok-imagine-image-2.0");
    assert.equal(requests[0].body.n, 4);
    const working = await provider.workingPoster(images[0]);
    assert.equal(requests[1].path, "/v1/images/edits");
    assert.deepEqual(requests[1].body.image, {
      url: `data:image/png;base64,${png.toString("base64")}`,
      type: "image_url",
    });
    const receipt = await provider.submitVideo(working, "working");
    assert.equal(receipt, "real-provider-receipt");
    assert.equal(requests[2].body.generate_audio, false);
    assert.deepEqual(requests[2].body.image, requests[2].body.last_frame);
    assert.equal((await provider.video(receipt)).status, "done");
    outputUrl = "https://private.example.com/stolen.mp4";
    await assert.rejects(provider.video(receipt), /Untrusted/);
    assert.equal(downloads, 1);
  } finally {
    await f.close();
  }
});

test("avatar image requests do not seed unrelated anatomy and preserve requested features and exclusions", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.config.dataDir, "credentials"), { mode: 0o700 });
    await writeFile(
      join(f.config.dataDir, "credentials/grok.json"),
      JSON.stringify({
        version: 1,
        provider: "grok",
        token_endpoint: "https://auth.x.ai/oauth2/token",
        access_token: "test-avatar-token",
        refresh_token: "test-refresh-token",
        expires_in: 3600,
        saved_at: new Date().toISOString(),
        token_type: "Bearer",
      }),
      { mode: 0o600 },
    );
    const requests: Record<string, unknown>[] = [];
    const upstream: typeof fetch = async (input, init) => {
      assert.equal(new URL(String(input)).pathname, "/v1/images/generations");
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      return Response.json({
        data: Array.from({ length: Number(body.n) }, () => ({
          b64_json: png.toString("base64"),
        })),
      });
    };
    const provider = new GrokAvatarProvider(f.config, upstream);
    const descriptions = [
      "um coelho rosa cientista usando um jaleco fechado e com coisas na mao",
      "um gato roxo com mechas coloridas",
      "Um coelho branco de orelhas caídas e olhos pretos.",
      "Um gato lilás com cabelo colorido.",
      "Um gatinho rosa, sem chifres, sem asas e sem cauda.",
      "Um dragão verde sem chifres e sem asas, com uma cauda curta.",
      "A teal dragon with tiny horns, broad wings and a long tail.",
      "A soft white rabbit with a blue scarf.",
    ];
    for (const description of descriptions) {
      const images = await provider.images(description);
      assert.equal(images.length, 4);
      const request = requests.at(-1);
      assert.ok(request);
      const prompt = String(request.prompt);
      assert.ok(prompt.includes(description), "The full user's description reaches the model");
      const direction = prompt.replace(description, "");
      assert.doesNotMatch(
        direction,
        /\b(?:dragons?|horns?|wings?|tails?|hood(?:ed)?|rabbits?|cats?)\b/i,
        "Shared art direction must not seed any species or creature features",
      );
      assert.match(direction, /explicit exclusions override.*species/i);
      assert.match(direction, /only.*requested.*normal anatomy/i);
      assert.match(direction, /3D plush/);
      assert.match(direction, /soft studio light/);
      assert.ok(
        prompt.indexOf(description) < prompt.indexOf("3D plush"),
        "Requested anatomy is specified before the common rendering style",
      );
      assert.equal(request.image, undefined, "New characters must not inherit another avatar");
      assert.equal(request.seed, undefined);
      assert.equal(request.n, 4);
    }
    assert.equal(requests.length, descriptions.length);
  } finally {
    await f.close();
  }
});

test("built-in companions persist independently of the saved gallery and bind retries to the choice", async () => {
  const f = await fixture();
  try {
    assert.equal((await (await f.request("")).json()).builtinCompanion, "okami");
    const mini = await f.request("/default/select", {
      requestId: "choose-mini",
      companion: "mini-muse",
    });
    assert.equal(mini.status, 200);
    assert.equal(
      (await f.server.agent.snapshot("local-user")).identity.builtinCompanion,
      "mini-muse",
    );
    const restarted = new AvatarService(f.db, f.server.files, f.config);
    assert.equal((await restarted.state("local-user")).builtinCompanion, "mini-muse");
    assert.equal((await restarted.state("another-owner")).builtinCompanion, "okami");
    assert.equal(
      (await f.request("/default/select", { requestId: "choose-mini", companion: "mini-muse" }))
        .status,
      200,
    );
    assert.equal(
      (await f.request("/default/select", { requestId: "choose-mini", companion: "okami" })).status,
      409,
    );
    assert.equal(
      (await f.request("/default/select", { requestId: "invalid-choice", companion: "invalid" }))
        .status,
      422,
    );
    assert.equal(
      (await f.request("/default/select", { requestId: "choose-wolf", companion: "okami" })).status,
      200,
    );
    assert.equal((await restarted.state("local-user")).builtinCompanion, "okami");
  } finally {
    await f.close();
  }
});
