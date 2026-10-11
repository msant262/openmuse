import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { TaskOutcomeUnknownError } from "../apps/server/src/engine/task-journal.ts";
import { taskCriteria } from "../apps/server/src/engine/task-verification.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import { MediaService, mediaTools } from "../apps/server/src/media-tools.ts";
import { synthesizeSpeech } from "../packages/integrations/src/speech.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

// A real encoded MP3 tone fixture, not a MIME label or fabricated receipt.
const mp3 = () => readFile(new URL("./fixtures/speech.mp3", import.meta.url));

test("text_to_speech delivers owned, verified audio and reuses the same operation", async (t) => {
  const server = await taskRuntime(t);
  let requests = 0;
  const media = new MediaService(
    server.db,
    server.files,
    server.agent.config,
    fetch,
    async (args) => {
      requests++;
      assert.equal(args.text, "Olá! Este áudio foi gerado para você.");
      assert.equal(args.voice, "pt-BR-FranciscaNeural");
      return new Uint8Array(await mp3());
    },
  );
  const attached: string[] = [];
  const tool = mediaTools(media, server.agent.computer, "owner", "speech-test", {
    model: () => undefined,
    artifact: async (id) => {
      attached.push(id);
    },
  }).find((entry) => entry.name === "text_to_speech");
  assert.ok(tool?.execute, "speech generation must be available in the actual tool catalog");
  const execute = tool.execute as (args: unknown) => Promise<Record<string, unknown>>;
  const args = {
    text: "Olá! Este áudio foi gerado para você.",
    name: "Saudação",
    operationId: "greeting",
  };
  const result = await execute(args);
  assert.equal(result.mimeType, "audio/mpeg");
  assert.equal(result.name, "Saudação.mp3");
  assert.ok(Number(result.durationSeconds) > 0);
  assert.deepEqual(attached, [result.fileId]);
  assert.deepEqual(await server.files.bytes("owner", String(result.fileId)), await mp3());
  assert.deepEqual(await execute(args), result);
  assert.equal(requests, 1);
  assert.match(String((await execute({ ...args, text: "Outro texto" })).error), /different|outro/i);
  assert.equal(requests, 1);
  await assert.rejects(server.files.bytes("other-owner", String(result.fileId)));
});

test("speech worker cancellation and deadline stop its owned work before returning", async () => {
  const args = { text: "Olá", voice: "pt-BR-FranciscaNeural", timeoutMs: 1 };
  await assert.rejects(synthesizeSpeech(args), /timed out/);
  const abort = new AbortController();
  const pending = synthesizeSpeech({ ...args, timeoutMs: 60000 }, abort.signal);
  setTimeout(() => abort.abort(new Error("stop this speech")), 10);
  await assert.rejects(pending, /stop this speech/);
});

test("an empty or truncated provider response never becomes an audio attachment", async (t) => {
  const server = await taskRuntime(t);
  for (const [i, bytes] of [
    new Uint8Array(),
    Buffer.from("<html>Error</html>"),
    (await mp3()).subarray(0, 80),
  ].entries()) {
    const media = new MediaService(
      server.db,
      server.files,
      server.agent.config,
      fetch,
      async () => bytes,
    );
    const tool = mediaTools(media, server.agent.computer, "owner", "invalid-speech", {
      model: () => undefined,
    }).find((entry) => entry.name === "text_to_speech");
    assert.ok(tool?.execute);
    const result = await (tool.execute as (args: unknown) => Promise<Record<string, unknown>>)({
      text: "Olá",
      operationId: `bad-${i}`,
    });
    assert.ok(result.error);
  }
  assert.equal((await server.db.list("owner", "files")).length, 0);
});

test("speech requests require an audio file even when the source mentions an infographic", () => {
  for (const prompt of [
    "Gere um áudio em português explicando o que são modelos de linguagem.",
    "Leia este texto em voz alta e me envie o áudio.",
    "Crie um MP3 com a explicação desse infográfico.",
  ]) {
    assert.ok(
      taskCriteria({ kind: "agent", prompt }).some(
        (criterion) => criterion.kind === "file" && criterion.format === "audio/mpeg",
      ),
      prompt,
    );
    assert.ok(
      !taskCriteria({ kind: "agent", prompt }).some((criterion) => criterion.format === "image/*"),
      prompt,
    );
  }
  for (const prompt of [
    "Explique o que é áudio digital.",
    "Como eu crio um MP3?",
    "Não gere um áudio, só explique o texto.",
  ])
    assert.ok(
      !taskCriteria({ kind: "agent", prompt }).some(
        (criterion) => criterion.format === "audio/mpeg",
      ),
      prompt,
    );
});

test("completion rejects prose and invalid audio bytes, then accepts the generated MP3", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", {
    prompt: "Gere um áudio em português sobre modelos de linguagem.",
  });
  assert.notEqual(
    (await server.agent.verification.assess("owner", task.id, 0, "O áudio está pronto.")).status,
    "verified",
  );
  const invalid = await server.files.importAttachment(
    "owner",
    "broken.mp3",
    Buffer.from("not audio"),
    "Uploaded audio",
  );
  await server.db.put("owner", "tasks", { ...task, artifactIds: [invalid.id] });
  assert.notEqual(
    (await server.agent.verification.assess("owner", task.id, 0, "O áudio está pronto.")).status,
    "verified",
  );
  const media = new MediaService(
    server.db,
    server.files,
    server.agent.config,
    fetch,
    async () => new Uint8Array(await mp3()),
  );
  const receipt = await media.createSpeech(
    "owner",
    { text: "Modelos de linguagem geram texto a partir do contexto.", operationId: "model-audio" },
    `task:${task.id}`,
  );
  await server.db.put("owner", "tasks", { ...task, artifactIds: [receipt.fileId] });
  assert.equal(
    (await server.agent.verification.assess("owner", task.id, 0, "O áudio está pronto.")).status,
    "verified",
  );
});

test("a stopped speech provider failure records failed rather than leaving an uncertain effect", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", { prompt: "Gere um áudio curto." });
  const media = new MediaService(server.db, server.files, server.agent.config, fetch, async () => {
    throw new Error("Microsoft speech service rejected the connection (HTTP 403)");
  });
  const worker = new TaskWorker(server.db, async (owner, running) => {
    const tool = mediaTools(media, server.agent.computer, owner, `task:${running.id}`, {
      model: () => undefined,
    }).find((entry) => entry.name === "text_to_speech")!;
    const args = { text: "Olá", operationId: "failed-voice" };
    const result = await server.agent.journal.run(
      owner,
      running,
      { id: "voice-call", name: "text_to_speech", args },
      () => (tool.execute as (args: unknown) => Promise<unknown>)(args),
      true,
    );
    assert.ok(result && typeof result === "object" && "error" in result);
    return { status: "failed", error: "Provider unavailable" };
  });
  t.after(() => worker.stop());
  await worker.tick();
  const ops = await server.agent.journal.operations("owner", task.id);
  assert.ok(ops.length);
  assert.ok(
    ops.every((op) => op.status === "failed"),
    JSON.stringify(ops.map((op) => ({ name: op.toolName, status: op.status }))),
  );
});

test("a crash during audio publication recovers the same bytes without repeating synthesis", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", { prompt: 'Gere um áudio contendo "Olá".' });
  let syntheses = 0;
  const media = new MediaService(server.db, server.files, server.agent.config, fetch, async () => {
    syntheses++;
    return new Uint8Array(await mp3());
  });
  const put = server.db.put.bind(server.db);
  let crash = true;
  t.mock.method(
    server.db,
    "put",
    async (owner: string, kind: string, value: Parameters<typeof put>[2]) => {
      if (kind === "files" && crash) {
        crash = false;
        throw new Error("Crash after writing MP3");
      }
      return put(owner, kind, value);
    },
  );
  const worker = new TaskWorker(server.db, async (owner, running) => {
    const tool = mediaTools(media, server.agent.computer, owner, `task:${task.id}`, {
      model: () => undefined,
    }).find((entry) => entry.name === "text_to_speech")!;
    const args = { text: "Olá", operationId: "recover-voice" };
    await assert.rejects(
      server.agent.journal.run(
        owner,
        running,
        { id: "recover-audio", name: "text_to_speech", args },
        () => (tool.execute as (args: unknown) => Promise<unknown>)(args),
        true,
      ),
      TaskOutcomeUnknownError,
    );
    return { status: "waiting_input", question: "Reconcile audio publication" };
  });
  await worker.tick();
  await worker.stop();
  const ids = await server.agent.journal.reconcileFiles("owner", task.id, server.files);
  assert.equal(ids.length, 1);
  assert.deepEqual(await server.files.bytes("owner", ids[0]), await mp3());
  assert.equal(syntheses, 1);
  const [generation] = (
    await server.db.list<{ fileId: string; status: string }>("owner", "speech-generations")
  ).filter((entry) => entry.fileId === ids[0]);
  assert.equal(generation?.status, "succeeded");
});
