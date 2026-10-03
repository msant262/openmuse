import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import { MediaService } from "../apps/server/src/media-tools.ts";
import { browserImageMessages } from "../apps/server/src/providers/browser-images.ts";
import { modelProviderConfig } from "../apps/server/src/providers/config.ts";
import { config as base } from "./helpers/computer.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6yS8AAAAASUVORK5CYII=",
  "base64",
);

test("owned arbitrary attachments upload, download and resolve on replay while PDF filling stays restricted", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-media-files-"));
  const db = await createStore();
  const server = await createApp(db, {
    ...base,
    dataDir,
    intelligenceApiKey: undefined,
    computerEnabled: false,
  });
  try {
    const session = await server.auth.session();
    const headers = { Authorization: `Bearer ${session.token}` };
    const form = new FormData();
    form.append(
      "file",
      new File([Uint8Array.from([80, 75, 3, 4, 1, 2])], "agenda.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    );
    const upload = await server.app.request("/api/files", { method: "POST", headers, body: form });
    assert.equal(upload.status, 201);
    const file = await upload.json();
    assert.equal(file.pageCount, 0);
    assert.match(file.mimeType, /wordprocessingml/);
    const content = await server.app.request(file.url);
    assert.equal(content.status, 200);
    assert.match(content.headers.get("content-disposition") ?? "", /^attachment;/);
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), Buffer.from([80, 75, 3, 4, 1, 2]));
    const metadata = await server.app.request(`/api/files/${file.id}`, { headers });
    assert.equal(metadata.status, 200);
    assert.ok((await metadata.json()).url);
    const fill = await server.app.request(`/api/files/${file.id}/fill`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: {} }),
    });
    assert.equal(fill.status, 422);
    await assert.rejects(() => server.files.bytes("other-owner", file.id), /not found/);
    const html = await server.files.importAttachment(
      "local-user",
      "../note\r\n.html",
      Buffer.from("<script>alert(1)</script>"),
      "Test",
      "text/html",
    );
    assert.equal(html.name, "note.html");
    assert.equal(html.mimeType, "application/octet-stream");
    await assert.rejects(
      () => server.files.importAttachment("local-user", "fake.png", Buffer.from("bad"), "Test"),
      /does not match/,
    );
    const largeImage = new Uint8Array(8 * 1024 * 1024 + 1);
    largeImage.set(png);
    const downloadable = await server.files.importAttachment(
      "local-user",
      "large.png",
      largeImage,
      "Test",
    );
    assert.equal(
      "fileImage" in (await server.files.reference("local-user", downloadable.id)),
      false,
    );
    assert.equal(
      (await server.files.bytes("local-user", downloadable.id)).length,
      largeImage.length,
    );
    await assert.rejects(
      () =>
        server.files.importAttachment(
          "local-user",
          "big.bin",
          new Uint8Array(25 * 1024 * 1024 + 1),
          "Test",
        ),
      /25 MB/,
    );
  } finally {
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
test("image tools use selected capability, validate bytes, persist ID-only refs and never duplicate uncertain requests", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-media-images-"));
  const db = await createStore();
  const config = {
    ...base,
    dataDir,
    intelligenceApiKey: undefined,
    computerEnabled: false,
    modelProviders: modelProviderConfig(dataDir, {
      OPENAI_COMPATIBLE_BASE_URL: "https://images.example/v1",
      OPENAI_COMPATIBLE_API_KEY: "private-key",
      OPENAI_COMPATIBLE_IMAGE_MODEL: "test-image",
    }),
  };
  const server = await createApp(db, config);
  let calls = 0;
  const service = new MediaService(db, server.files, config, async (input, init) => {
    calls++;
    assert.equal(String(input), "https://images.example/v1/images/generations");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer private-key");
    assert.equal(JSON.parse(String(init?.body)).model, "test-image");
    return Response.json({ data: [{ b64_json: png.toString("base64") }] });
  });
  try {
    assert.equal(
      (
        (await service.generatedImage(
          "owner",
          "chatgpt/model",
          { prompt: "flower", operationId: "disabled" },
          "scope",
        )) as { disabled: boolean }
      ).disabled,
      true,
    );
    assert.equal(calls, 0);
    const ref = await service.generatedImage(
      "owner",
      "compatible/model",
      { prompt: "flower", operationId: "one" },
      "scope",
    );
    assert.ok("fileId" in ref);
    assert.equal("url" in ref, false);
    assert.equal("base64" in ref, false);
    assert.equal(calls, 1);
    assert.deepEqual(
      await service.generatedImage(
        "owner",
        "compatible/model",
        { prompt: "flower", operationId: "one" },
        "scope",
      ),
      ref,
    );
    assert.equal(calls, 1);
    const broken = new MediaService(db, server.files, config, async () =>
      Response.json({ data: [{ url: "http://169.254.169.254/private" }] }),
    );
    await assert.rejects(
      () =>
        broken.generatedImage(
          "owner",
          "compatible/model",
          { prompt: "broken", operationId: "broken" },
          "scope",
        ),
      /base64/,
    );
    await assert.rejects(
      () =>
        broken.generatedImage(
          "owner",
          "compatible/model",
          { prompt: "broken", operationId: "broken" },
          "scope",
        ),
      /unknown or pending/,
    );
    const messages = [{ role: "tool" as const, content: JSON.stringify(ref), toolCallId: "image" }];
    const hydrated = await browserImageMessages(messages, undefined, (id) =>
      server.files.imageContent("owner", id),
    );
    assert.equal(hydrated.length, 2);
    assert.equal(messages[0].content.includes(png.toString("base64")), false);
    await assert.rejects(
      () =>
        browserImageMessages(messages, undefined, (id) =>
          server.files.imageContent("other-owner", id),
        ),
      /not found/,
    );
  } finally {
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("generated images validate the 8 MiB boundary and malformed padding without retrying external work", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-media-images-boundary-"));
  const db = await createStore();
  const config = {
    ...base,
    dataDir,
    intelligenceApiKey: undefined,
    computerEnabled: false,
    modelProviders: modelProviderConfig(dataDir, {
      OPENAI_COMPATIBLE_BASE_URL: "https://images.example/v1",
      OPENAI_COMPATIBLE_IMAGE_MODEL: "test-image",
    }),
  };
  const server = await createApp(db, config);
  let encoded = "";
  let calls = 0;
  const service = new MediaService(db, server.files, config, async () => {
    calls++;
    return Response.json({ data: [{ b64_json: encoded }] });
  });
  const request = (operationId: string) =>
    service.generatedImage(
      "owner",
      "compatible/model",
      { prompt: "flower", operationId },
      "boundary",
    );
  try {
    for (const size of [128 * 1024, 1024 * 1024, 8 * 1024 * 1024]) {
      const bytes = Buffer.alloc(size, 173);
      png.copy(bytes); // Raster-signature fixture exercises exact transport, not rendering.
      encoded = bytes.toString("base64");
      const ref = await request(`size-${size}`);
      assert.ok("fileId" in ref);
      assert.equal(ref.size, size);
      assert.deepEqual(await server.files.bytes("owner", ref.fileId), bytes);
      const beforeReplay = calls;
      assert.deepEqual(await request(`size-${size}`), ref);
      assert.equal(calls, beforeReplay);
      await assert.rejects(() => server.files.bytes("other-owner", ref.fileId), /not found/);
    }
    for (const [index, invalid] of [
      "AAAA=",
      "AAAA====",
      "AA=A",
      "A===",
      "=AAA",
      "AA-_",
      "AA\n=",
      "AB==",
      "AAF=",
    ].entries()) {
      encoded = invalid;
      const operationId = `malformed-${index}`;
      const beforeFailure = calls;
      await assert.rejects(() => request(operationId), /bounded base64/);
      await assert.rejects(() => request(operationId), /unknown or pending/);
      assert.equal(calls, beforeFailure + 1);
    }
    for (const excess of [1, 3]) {
      const bytes = Buffer.alloc(8 * 1024 * 1024 + excess, 173);
      png.copy(bytes);
      encoded = bytes.toString("base64");
      const operationId = `oversized-${excess}`;
      const beforeFailure = calls;
      await assert.rejects(() => request(operationId));
      await assert.rejects(() => request(operationId), /unknown or pending/);
      assert.equal(calls, beforeFailure + 1);
    }
  } finally {
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("mobile multipart retries preserve one named file and reject reuse with changed content", async (t) => {
  const { taskRuntime } = await import("./helpers/task-runtime.ts");
  const server = await taskRuntime(t);
  const session = await server.auth.session();
  const upload = (text: string) => {
    const form = new FormData();
    form.append("file", new File([text], "private-cache-hash", { type: "text/plain" }));
    form.append("fileName", "meu-documento.txt");
    form.append("uploadId", "stable-mobile-id");
    return server.app.request("/api/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.token}` },
      body: form,
    });
  };
  const first = await upload("durable bytes"),
    retry = await upload("durable bytes");
  assert.equal(first.status, 201);
  assert.equal(retry.status, 201);
  const saved = await first.json();
  assert.equal(saved.name, "meu-documento.txt");
  assert.equal((await retry.json()).id, saved.id);
  assert.equal((await upload("different bytes")).status, 409);
  assert.equal(
    (await server.db.list("local-user", "files")).filter((file: any) => file.id === saved.id)
      .length,
    1,
  );
});
