import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { ComputerBackend } from "../apps/server/src/computer-contract.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { ComputerCommand } from "../packages/domain/src/computer.ts";
import { hello, nodeToken, registration } from "./helpers/executors.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

type NativeNodeOperation = {
  id: string;
  kind: string;
  args: Record<string, unknown> & { parameters?: Record<string, unknown> };
};
type NativeNodeResponse = {
  epoch?: number;
  operations?: NativeNodeOperation[];
  [key: string]: unknown;
};

async function nativeRuntime() {
  const directory = await mkdtemp(join(tmpdir(), "okami-native-transcription-"));
  const config: Config = {
    mode: "sample",
    agentBackend: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    computerEnabled: true,
    computerBackend: "native",
    nativeExecutorId: registration.executorId,
    nativeExecutors: [{ ...registration, owner: "local-user" }],
    taskWorkerEnabled: false,
  };
  const state: {
    directory: string;
    config: Config;
    db: Store;
    server: Awaited<ReturnType<typeof createApp>>;
    session: Awaited<ReturnType<Awaited<ReturnType<typeof createApp>>["auth"]["session"]>>;
    epoch: number;
    node: (route: string, body: unknown) => Promise<NativeNodeResponse>;
    restart: () => Promise<void>;
    close: () => Promise<void>;
  } = {
    directory,
    config,
    db: await createStore({ dataDir: join(directory, "db") }),
    server: undefined as never,
    session: undefined as never,
    epoch: 0,
    node: async () => ({}),
    restart: async () => {},
    close: async () => {},
  };
  state.server = await createApp(state.db, config);
  state.session = await state.server.auth.session();
  state.node = async (route, body) => {
    const response = await state.server.app.request(
      `/executor/${registration.executorId}/${route}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${nodeToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  const nodeHello = {
    ...hello,
    capabilities: [...hello.capabilities, { name: "transcribe" as const, version: 1 }],
  };
  state.epoch = Number((await state.node("register", nodeHello)).epoch);
  await state.node("reconcile", {
    epoch: state.epoch,
    bootId: nodeHello.bootId,
    operations: [],
    contained: true,
  });
  state.close = async () => {
    await state.server.agent.stop();
    if (state.server.threads && "close" in state.server.threads) await state.server.threads.close();
    await state.db.close();
    await rm(directory, { recursive: true, force: true });
  };
  state.restart = async () => {
    await state.server.agent.stop();
    if (state.server.threads && "close" in state.server.threads) await state.server.threads.close();
    await state.db.close();
    state.db = await createStore({ dataDir: join(directory, "db") });
    state.server = await createApp(state.db, config);
  };
  return state;
}

test("native file export publishes bytes after releasing the remote read lease", async (t) => {
  const native = await nativeRuntime();
  t.after(native.close);
  const bytes = Buffer.from("generated office document bytes");
  const request = native.server.app.request("/api/computer/files/export", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${native.session.token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "native-export-regression",
    },
    body: JSON.stringify({ path: "/workspace/report.docx" }),
  });
  const claim = await native.node("claim", { epoch: native.epoch, waitMs: 5000 });
  const operation = claim.operations?.[0];
  assert.ok(operation);
  assert.equal(operation.args.operation, "read_binary");
  await native.node("receipt", {
    epoch: native.epoch,
    operationId: operation.id,
    sequence: 1,
    receipt: {
      status: "succeeded",
      data: {
        path: "/workspace/report.docx",
        base64: bytes.toString("base64"),
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    },
  });
  const initial = await request;
  let value = await initial.json();
  for (let poll = 0; value.pending && poll < 40; poll++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const response = await native.server.app.request(`/api/computer/requests/${value.taskId}`, {
      headers: { Authorization: `Bearer ${native.session.token}` },
    });
    value = await response.json();
  }
  const artifact = value.result ?? value;
  assert.ok(artifact.id, JSON.stringify(value));
  assert.equal(artifact.name, "report.docx");
  assert.deepEqual(Buffer.from(await native.server.files.bytes("local-user", artifact.id)), bytes);
  const operations = await native.server.agent.journal.operations(
    "local-user",
    (await native.db.list<{ id: string }>("local-user", "tasks"))[0].id,
  );
  assert.ok(operations.length >= 3);
  assert.ok(
    operations.every((item) => item.status === "succeeded"),
    JSON.stringify(operations),
  );
  assert.equal(
    (await native.node("claim", { epoch: native.epoch, waitMs: 0 })).operations?.length ?? 0,
    0,
  );
});

test("concurrent late transcript publication creates one complete VPS text and SRT attachment", async (t) => {
  const server = await taskRuntime(t);
  const output = new Map([
    [
      "/workspace/transcript-full.txt",
      Buffer.from("Complete transcript beyond stdout\nsecond line"),
    ],
    ["/workspace/transcript-full.srt", Buffer.from("1\n00:00:00,000 --> 00:00:01,000\nhello\n")],
  ]);
  const arrivals = new Map<string, number>();
  const releases = new Map<string, () => void>();
  const gates = new Map<string, Promise<void>>();
  const computer = {
    fileBytes: async (_owner: string, path: string) => {
      const gate = gates.get(path) ?? new Promise<void>((resolve) => releases.set(path, resolve));
      gates.set(path, gate);
      const count = (arrivals.get(path) ?? 0) + 1;
      arrivals.set(path, count);
      if (count === 2) releases.get(path)?.();
      await gate;
      const bytes = output.get(path);
      assert.ok(bytes);
      return { name: path.split("/").at(-1) ?? "output.txt", bytes };
    },
  } as unknown as ComputerBackend;
  const receipt: ComputerCommand = {
    id: "stable-media-command",
    command: "transcribe /workspace/voice.m4a",
    cwd: "/workspace",
    kind: "transcribe",
    status: "succeeded",
    exitCode: 0,
    stdout: "TRUNCATED STDOUT MUST NOT BECOME THE TRANSCRIPT",
    stderr: "",
    truncated: true,
    startedAt: new Date(0).toISOString(),
    completedAt: new Date().toISOString(),
    result: {
      text: "TRUNCATED",
      truncated: true,
      textPath: "/workspace/transcript-full.txt",
      srtPath: "/workspace/transcript-full.srt",
      language: "pt",
      languageProbability: 0.97,
      duration: 12,
    },
  };

  const [first, second] = await Promise.all([
    server.agent.media.completed("local-user", computer, receipt),
    server.agent.media.completed("local-user", computer, receipt),
  ]);
  const firstFiles = "attachments" in first ? (first.attachments ?? []) : [];
  const secondFiles = "attachments" in second ? (second.attachments ?? []) : [];
  assert.deepEqual(
    firstFiles.map((file) => file.fileId),
    secondFiles.map((file) => file.fileId),
  );
  assert.deepEqual(
    (await server.files.list("local-user")).map((file) => file.id).sort(),
    firstFiles.map((file) => file.fileId).sort(),
  );
  const outputVersions = await server.db.list<{
    version: string;
    versionId: string;
  }>("local-user", "computer-outputs");
  assert.equal(outputVersions.length, 2);
  assert.ok(outputVersions.every((output) => /^[a-f0-9]{64}$/.test(output.version)));
  assert.ok(outputVersions.every((output) => /^[a-f0-9]{64}$/.test(output.versionId)));
  const transcript = firstFiles.find((file) => file.name.endsWith(".txt"));
  const subtitles = firstFiles.find((file) => file.name.endsWith(".srt"));
  assert.ok(transcript && subtitles);
  assert.equal(
    Buffer.from(await server.files.bytes("local-user", transcript.fileId)).toString(),
    "Complete transcript beyond stdout\nsecond line",
  );
  assert.equal(
    Buffer.from(await server.files.bytes("local-user", subtitles.fileId)).toString(),
    "1\n00:00:00,000 --> 00:00:01,000\nhello\n",
  );
  assert.equal(first.result?.language, "pt");
  assert.equal(first.result?.languageProbability, 0.97);

  const other = await server.auth.devices.pair("other-owner", "foreign reader");
  const denied = await server.app.request(`/api/files/${transcript.fileId}`, {
    headers: { Authorization: `Bearer ${other.token}` },
  });
  assert.equal(denied.status, 404);
});

test("native attachment transcription publishes late full outputs once and survives app restart", async (t) => {
  const native = await nativeRuntime();
  t.after(native.close);
  const threadId = "transcription-chat";
  if (!("ensure" in native.server.threads))
    throw new Error("Test app did not create local threads");
  await native.server.threads.ensure("local-user", threadId);
  const audio = await native.server.files.importAttachment(
    "local-user",
    "meeting.m4a",
    Buffer.from("fixture audio input"),
    "Uploaded by you",
    "audio/mp4",
    "audio-input-operation",
  );
  await native.db.put("local-user", "conversation-inbox", {
    id: "audio-message",
    threadId,
    clientMessageId: "audio-message",
    text: "Please transcribe this audio",
    attachmentIds: [audio.id],
  });
  const body = {
    fileId: audio.id,
    language: "auto",
    includeSubtitles: true,
    threadId,
    requestId: "late-transcription-request",
  };
  const post = () =>
    native.server.app.request("/api/computer/transcribe-attachment", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${native.session.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": body.requestId,
      },
      body: JSON.stringify(body),
    });
  const acceptedRequest = post();
  const upload = await native.node("claim", { epoch: native.epoch, waitMs: 5000 });
  assert.equal(upload.operations?.length, 1);
  assert.equal(upload.operations?.[0].kind, "file");
  assert.equal(upload.operations?.[0].args.operation, "write_binary");
  const uploadOperation = upload.operations?.[0];
  assert.ok(uploadOperation);
  const uploadBytes = Buffer.from(String(uploadOperation.args.base64), "base64");
  const uploadSha = createHash("sha256").update(uploadBytes).digest("hex");
  const uploadedArtifact = {
    artifactId: createHash("sha256").update(String(uploadOperation.args.path)).digest("hex"),
    path: uploadOperation.args.path,
    version: uploadSha,
    sha256: uploadSha,
    size: uploadBytes.length,
    mimeType: "audio/mp4",
    executorLocal: true,
    published: false,
    restoredAsCopy: false,
    generation: 1,
    versionId: "native-upload-version-1",
  };
  await native.node("receipt", {
    epoch: native.epoch,
    operationId: uploadOperation.id,
    sequence: 1,
    receipt: { status: "succeeded", data: uploadedArtifact },
  });
  await native.node("artifact", { epoch: native.epoch, ...uploadedArtifact });
  const media = await native.node("claim", { epoch: native.epoch, waitMs: 5000 });
  assert.equal(media.operations?.length, 1);
  const mediaOperation = media.operations?.[0];
  assert.ok(mediaOperation);
  const mediaParameters = mediaOperation.args.parameters;
  assert.ok(mediaParameters);
  assert.equal(mediaOperation.kind, "media");
  assert.equal(mediaOperation.args.mediaKind, "transcribe");
  assert.equal(mediaParameters.language, "auto");
  assert.equal(typeof mediaParameters.srtPath, "string");
  const acceptedResponse = await acceptedRequest;
  const accepted = (await acceptedResponse.json()) as { taskId: string; pending: boolean };
  assert.equal(acceptedResponse.status, 202, JSON.stringify(accepted));
  assert.equal(accepted.pending, true);
  const duplicateResponse = await post();
  assert.equal(duplicateResponse.status, 202, await duplicateResponse.clone().text());
  const duplicate = (await duplicateResponse.json()) as { taskId: string; pending: boolean };
  assert.equal(duplicate.taskId, accepted.taskId);
  assert.equal(duplicate.pending, true);

  const fullText = Buffer.from("Full transcript from the VPS-published output file.");
  const fullSrt = Buffer.from("1\n00:00:00,000 --> 00:00:01,000\nSubtitle line\n");
  const result = {
    text: "Only the bounded receipt prefix",
    truncated: true,
    textPath: mediaParameters.textPath,
    srtPath: mediaParameters.srtPath,
    language: "de",
    languageProbability: 0.93,
    duration: 12,
  };
  const running = await native.server.computer.command?.("local-user", mediaOperation.id);
  assert.ok(running);
  await native.node("receipt", {
    epoch: native.epoch,
    operationId: mediaOperation.id,
    sequence: 1,
    receipt: {
      status: "succeeded",
      data: {
        ...running,
        status: "succeeded",
        exitCode: 0,
        stdout: JSON.stringify(result),
        truncated: false,
        result,
        completedAt: new Date().toISOString(),
        cleanupConfirmed: true,
      },
    },
  });

  const waitingTask = await native.server.agent.getTask("local-user", accepted.taskId);
  assert.equal(waitingTask.status, "waiting_job");
  await native.db.compareAndSwapTask(
    "local-user",
    waitingTask.id,
    { status: "waiting_job", updatedAt: waitingTask.updatedAt },
    { nextRunAt: new Date(0).toISOString() },
  );
  let resume = native.server.agent.worker.tick();
  const readText = await native.node("claim", { epoch: native.epoch, waitMs: 5000 });
  assert.equal(readText.operations?.length, 1);
  const textOperation = readText.operations?.[0];
  assert.ok(textOperation);
  assert.equal(textOperation.args.operation, "read_binary");
  assert.equal(textOperation.args.path, result.textPath);
  await native.node("receipt", {
    epoch: native.epoch,
    operationId: textOperation.id,
    sequence: 1,
    receipt: {
      status: "succeeded",
      data: {
        path: result.textPath,
        base64: fullText.toString("base64"),
        size: fullText.length,
        sha256: createHash("sha256").update(fullText).digest("hex"),
      },
    },
  });
  const firstSrtRead = await native.node("claim", { epoch: native.epoch, waitMs: 5000 });
  assert.equal(firstSrtRead.operations?.length, 1);
  const failedSrtOperation = firstSrtRead.operations?.[0];
  assert.ok(failedSrtOperation);
  assert.equal(failedSrtOperation.args.operation, "read_binary");
  assert.equal(failedSrtOperation.args.path, result.srtPath);
  await native.node("receipt", {
    epoch: native.epoch,
    operationId: failedSrtOperation.id,
    sequence: 1,
    receipt: { status: "failed", message: "Simulated interrupted subtitle read" },
  });
  await resume;
  const partialTask = await native.server.agent.getTask("local-user", accepted.taskId);
  assert.equal(partialTask.status, "waiting_job");
  assert.equal((await native.server.files.list("local-user")).length, 2);

  await native.restart();
  await native.node("reconcile", {
    epoch: native.epoch,
    bootId: hello.bootId,
    operations: [],
    contained: true,
  });
  const recoveredTask = await native.server.agent.getTask("local-user", accepted.taskId);
  await native.db.compareAndSwapTask(
    "local-user",
    recoveredTask.id,
    { status: "waiting_job", updatedAt: recoveredTask.updatedAt },
    { nextRunAt: new Date(0).toISOString() },
  );
  resume = native.server.agent.worker.tick();
  const retrySrtRead = await native.node("claim", { epoch: native.epoch, waitMs: 5000 });
  assert.equal(retrySrtRead.operations?.length, 1);
  const srtOperation = retrySrtRead.operations?.[0];
  assert.ok(srtOperation);
  assert.equal(srtOperation.args.operation, "read_binary");
  assert.equal(srtOperation.args.path, result.srtPath);
  assert.notEqual(srtOperation.id, failedSrtOperation.id);
  await native.node("receipt", {
    epoch: native.epoch,
    operationId: srtOperation.id,
    sequence: 1,
    receipt: {
      status: "succeeded",
      data: {
        path: result.srtPath,
        base64: fullSrt.toString("base64"),
        size: fullSrt.length,
        sha256: createHash("sha256").update(fullSrt).digest("hex"),
      },
    },
  });
  await resume;
  const verifiedTask = await native.server.agent.getTask("local-user", accepted.taskId);
  assert.equal(verifiedTask.status, "succeeded");
  const reconciled = await native.server.agent.journal.operations("local-user", accepted.taskId);
  const failedRead = reconciled.find((op) => op.id === failedSrtOperation.id);
  assert.equal(failedRead?.status, "failed");
  const failedPrimitive = reconciled.find((op) => op.id === failedRead?.parentOperationId);
  assert.equal(failedPrimitive?.status, "failed");
  assert.equal(
    reconciled.find((op) => op.id === failedPrimitive?.parentOperationId)?.status,
    "failed",
  );
  assert.equal(verifiedTask.completion?.status, "verified");
  assert.ok(verifiedTask.state.completedComputerJob);
  assert.ok(failedRead);
  // Publishing all output files does not resolve an unrelated uncertain read or
  // a possibly dispatched mutation. Their native receipts must still reconcile.
  for (const effect of [false, true]) {
    const unresolvedId = `unresolved-${effect ? "mutation" : "read"}`;
    await native.db.put("local-user", "task-operations", {
      ...failedRead,
      id: unresolvedId,
      parentOperationId: undefined,
      effect,
      status: "outcome_unknown",
      receipt: { outcomeUnknown: true },
    });
    const guarded = await native.server.manualNative?.execute("local-user", verifiedTask, {
      signal: new AbortController().signal,
      guard: async () => {},
      checkpoint: async () => verifiedTask,
      event: async () => {},
      acquireResources: async () => [],
      trackResourceLeases: () => {},
      holdAdmission: async () => {},
    });
    assert.equal(guarded?.status, "waiting_input");
    assert.equal(guarded?.completion?.status, "unverified");
    assert.equal(
      (await native.db.get<{ status: string }>("local-user", "task-operations", unresolvedId))
        ?.status,
      "outcome_unknown",
    );
    await native.db.remove("local-user", "task-operations", unresolvedId);
  }
  const completedResponse = await native.server.app.request(
    `/api/computer/requests/${accepted.taskId}`,
    { headers: { Authorization: `Bearer ${native.session.token}` } },
  );
  assert.equal(completedResponse.status, 200, await completedResponse.clone().text());
  const completed = (await completedResponse.json()) as {
    result: ComputerCommand & {
      attachments?: { fileId: string; name: string; mimeType: string }[];
    };
  };
  assert.equal(completed.result.status, "succeeded");
  assert.equal(completed.result.result?.truncated, true);
  assert.equal(completed.result.result?.language, "de");
  assert.equal(completed.result.result?.languageProbability, 0.93);
  assert.deepEqual(
    completed.result.attachments?.map((file) => file.name.slice(file.name.lastIndexOf("."))).sort(),
    [".srt", ".txt"],
  );
  const fileIds = completed.result.attachments?.map((file) => file.fileId) ?? [];
  assert.equal((await native.server.files.list("local-user")).length, 3);
  const transcriptFile = completed.result.attachments?.find((file) => file.name.endsWith(".txt"));
  const subtitlesFile = completed.result.attachments?.find((file) => file.name.endsWith(".srt"));
  assert.ok(transcriptFile && subtitlesFile);
  assert.equal(
    Buffer.from(await native.server.files.bytes("local-user", transcriptFile.fileId)).toString(),
    fullText.toString(),
  );
  assert.equal(
    Buffer.from(await native.server.files.bytes("local-user", subtitlesFile.fileId)).toString(),
    fullSrt.toString(),
  );
  const library = await native.server.app.request(`/api/conversations/${threadId}/resources`, {
    headers: { Authorization: `Bearer ${native.session.token}` },
  });
  assert.equal(library.status, 200);
  assert.deepEqual(
    ((await library.json()) as { files: { file: { id: string } }[] }).files
      .map((file) => file.file.id)
      .sort(),
    [...fileIds, audio.id].sort(),
  );

  await native.restart();
  const replay = await post();
  assert.equal(replay.status, 200);
  const replayed = (await replay.json()) as { attachments?: { fileId: string }[] };
  assert.deepEqual(replayed.attachments?.map((file) => file.fileId).sort(), fileIds.sort());
  assert.equal((await native.server.files.list("local-user")).length, 3);
  const reopenedLibrary = await native.server.app.request(
    `/api/conversations/${threadId}/resources`,
    { headers: { Authorization: `Bearer ${native.session.token}` } },
  );
  assert.equal(reopenedLibrary.status, 200);
  const reopenedFiles = (await reopenedLibrary.json()) as {
    files: { file: { id: string }; availableOffline: boolean }[];
  };
  for (const id of [...fileIds, audio.id]) {
    const entry = reopenedFiles.files.find((file) => file.file.id === id);
    assert.ok(entry);
    assert.equal(entry.availableOffline, true);
  }
  for (const id of fileIds) {
    const file = await native.server.app.request(`/api/files/${id}/content`, {
      headers: { Authorization: `Bearer ${native.session.token}` },
    });
    assert.equal(file.status, 200);
    assert.ok((await file.arrayBuffer()).byteLength > 0);
  }
  const other = await native.server.auth.devices.pair("other-owner", "foreign reader");
  assert.equal(
    (
      await native.server.app.request(`/api/computer/requests/${accepted.taskId}`, {
        headers: { Authorization: `Bearer ${other.token}` },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await native.server.app.request(`/api/files/${fileIds[0]}/content`, {
        headers: { Authorization: `Bearer ${other.token}` },
      })
    ).status,
    404,
  );
  assert.equal(
    (await native.node("claim", { epoch: native.epoch, waitMs: 0 })).operations?.length ?? 0,
    0,
  );
});

test("an immediately succeeded native transcription receipt publishes without submitting ASR again", async (t) => {
  const native = await nativeRuntime();
  t.after(native.close);
  const audio = await native.server.files.importAttachment(
    "local-user",
    "quick-note.wav",
    Buffer.from("fixture audio input"),
    "Uploaded by you",
    "audio/wav",
    "immediate-audio-input-operation",
  );
  const body = {
    fileId: audio.id,
    language: "auto",
    includeSubtitles: false,
    requestId: "immediate-transcription-request",
  };
  const backend = native.server.computer;
  const originalMedia = backend.media;
  assert.ok(originalMedia);
  let deliverImmediateReceipt: (receipt: ComputerCommand) => void = () => {};
  const immediateReceipt = new Promise<ComputerCommand>((resolve) => {
    deliverImmediateReceipt = resolve;
  });
  backend.media = async (owner, kind, parameters, options) => {
    const initial = await originalMedia.call(backend, owner, kind, parameters, options);
    return initial.status === "running" ? immediateReceipt : initial;
  };
  const post = () =>
    native.server.app.request("/api/computer/transcribe-attachment", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${native.session.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": body.requestId,
      },
      body: JSON.stringify(body),
    });
  const acceptedRequest = post();
  try {
    const upload = await native.node("claim", { epoch: native.epoch, waitMs: 5000 });
    assert.equal(upload.operations?.length, 1);
    const uploadOperation = upload.operations?.[0];
    assert.ok(uploadOperation);
    assert.equal(uploadOperation.args.operation, "write_binary");
    const uploadBytes = Buffer.from(String(uploadOperation.args.base64), "base64");
    const uploadSha = createHash("sha256").update(uploadBytes).digest("hex");
    const uploadedArtifact = {
      artifactId: createHash("sha256").update(String(uploadOperation.args.path)).digest("hex"),
      path: uploadOperation.args.path,
      version: uploadSha,
      sha256: uploadSha,
      size: uploadBytes.length,
      mimeType: "audio/wav",
      executorLocal: true,
      published: false,
      restoredAsCopy: false,
      generation: 1,
      versionId: "immediate-native-upload-v1",
    };
    await native.node("receipt", {
      epoch: native.epoch,
      operationId: uploadOperation.id,
      sequence: 1,
      receipt: { status: "succeeded", data: uploadedArtifact },
    });
    await native.node("artifact", { epoch: native.epoch, ...uploadedArtifact });

    const media = await native.node("claim", { epoch: native.epoch, waitMs: 5000 });
    assert.equal(media.operations?.length, 1);
    const mediaOperation = media.operations?.[0];
    assert.ok(mediaOperation);
    assert.equal(mediaOperation.kind, "media");
    const parameters = mediaOperation.args.parameters;
    assert.ok(parameters);
    const running = await backend.command?.("local-user", mediaOperation.id);
    assert.ok(running);
    const result = {
      text: "bounded receipt text",
      truncated: false,
      textPath: String(parameters.textPath),
      language: "en",
      languageProbability: 0.91,
      duration: 3,
    };
    await native.node("receipt", {
      epoch: native.epoch,
      operationId: mediaOperation.id,
      sequence: 1,
      receipt: {
        status: "succeeded",
        data: {
          ...running,
          status: "succeeded",
          exitCode: 0,
          stdout: JSON.stringify(result),
          stderr: "",
          truncated: false,
          result,
          completedAt: new Date().toISOString(),
          cleanupConfirmed: true,
        },
      },
    });
    const terminal = await backend.command?.("local-user", mediaOperation.id);
    assert.ok(terminal);
    assert.equal(terminal.status, "succeeded");
    deliverImmediateReceipt(terminal);

    const output = Buffer.from("Full immediate transcript output.");
    const read = await native.node("claim", { epoch: native.epoch, waitMs: 5000 });
    assert.equal(read.operations?.length, 1);
    const readOperation = read.operations?.[0];
    assert.ok(readOperation);
    assert.equal(readOperation.args.operation, "read_binary");
    assert.equal(readOperation.args.path, result.textPath);
    await native.node("receipt", {
      epoch: native.epoch,
      operationId: readOperation.id,
      sequence: 1,
      receipt: {
        status: "succeeded",
        data: {
          path: result.textPath,
          base64: output.toString("base64"),
          size: output.length,
          sha256: createHash("sha256").update(output).digest("hex"),
        },
      },
    });

    const acceptedResponse = await acceptedRequest;
    const accepted = (await acceptedResponse.json()) as { taskId?: string; status?: string };
    assert.equal(acceptedResponse.status, 202, JSON.stringify(accepted));
    assert.ok(accepted.taskId);
    let completedResponse: Response | undefined;
    for (let poll = 0; poll < 50; poll++) {
      const response = await native.server.app.request(
        `/api/computer/requests/${accepted.taskId}`,
        { headers: { Authorization: `Bearer ${native.session.token}` } },
      );
      if (response.status === 200) {
        const value = (await response.clone().json()) as {
          status?: string;
          result?: { status?: string };
        };
        if (value.status === "succeeded" || value.result?.status === "succeeded") {
          completedResponse = response;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(completedResponse, "immediate result eventually completes publication");
    const envelope = (await completedResponse.json()) as {
      result?: {
        status: string;
        attachments?: { name: string; fileId: string }[];
      };
      status: string;
      attachments?: { name: string; fileId: string }[];
    };
    const completed = envelope.result ?? envelope;
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.attachments?.length, 1);
    assert.equal(completed.attachments?.[0].name.endsWith(".txt"), true);
    const transcript = completed.attachments?.[0];
    assert.ok(transcript);
    assert.equal(
      Buffer.from(await native.server.files.bytes("local-user", transcript.fileId)).toString(),
      output.toString(),
    );
    assert.equal(
      (await native.node("claim", { epoch: native.epoch, waitMs: 0 })).operations?.length ?? 0,
      0,
    );
  } finally {
    backend.media = originalMedia;
  }
});

test("compound native attachment transcription reconciles a published upload before a pre-enqueue media rejection", async (t) => {
  const native = await nativeRuntime();
  t.after(native.close);

  // Switch to a registered node that supports file transfer but not transcription.
  const { epoch } = await native.node("register", hello);
  native.epoch = Number(epoch);
  await native.node("reconcile", {
    epoch: native.epoch,
    bootId: hello.bootId,
    operations: [],
    contained: true,
  });

  const threadId = "compound-preflight-chat";
  if (!("ensure" in native.server.threads))
    throw new Error("Test app did not create local threads");
  await native.server.threads.ensure("local-user", threadId);
  const audio = await native.server.files.importAttachment(
    "local-user",
    "meeting.m4a",
    Buffer.from("fixture audio input"),
    "Uploaded by you",
    "audio/mp4",
    "compound-preflight-audio",
  );
  const body = {
    fileId: audio.id,
    language: "auto",
    includeSubtitles: true,
    threadId,
    requestId: "compound-preflight-request",
  };
  const acceptedRequest = native.server.app.request("/api/computer/transcribe-attachment", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${native.session.token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": body.requestId,
    },
    body: JSON.stringify(body),
  });

  const upload = await native.node("claim", { epoch: native.epoch, waitMs: 5000 });
  assert.equal(upload.operations?.length, 1);
  const uploadOperation = upload.operations?.[0];
  assert.ok(uploadOperation);
  assert.equal(uploadOperation.kind, "file");
  assert.equal(uploadOperation.args.operation, "write_binary");
  const uploadBytes = Buffer.from(String(uploadOperation.args.base64), "base64");
  const uploadSha = createHash("sha256").update(uploadBytes).digest("hex");
  const uploadedArtifact = {
    artifactId: createHash("sha256").update(String(uploadOperation.args.path)).digest("hex"),
    path: uploadOperation.args.path,
    version: uploadSha,
    sha256: uploadSha,
    size: uploadBytes.length,
    mimeType: "audio/mp4",
    executorLocal: true,
    published: false,
    restoredAsCopy: false,
    generation: 1,
    versionId: "compound-preflight-upload-version",
  };
  await native.node("receipt", {
    epoch: native.epoch,
    operationId: uploadOperation.id,
    sequence: 1,
    receipt: { status: "succeeded", data: uploadedArtifact },
  });
  await native.node("artifact", { epoch: native.epoch, ...uploadedArtifact });

  const response = await acceptedRequest;
  const result = (await response.json()) as { taskId?: string; status?: string };
  assert.ok(result.taskId, JSON.stringify(result));
  for (let attempt = 0; attempt < 100; attempt++) {
    const task = await native.server.agent.getTask("local-user", result.taskId);
    if (["failed", "waiting_input"].includes(task.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const operations = await native.server.agent.journal.operations("local-user", result.taskId);
  const wrapper = operations.find(
    (operation) => operation.toolName === "manual_native.transcribe_attachment",
  );
  assert.ok(wrapper);
  assert.equal(wrapper.status, "failed");
  assert.equal((wrapper.receipt as { dispatched?: boolean }).dispatched, true);
  assert.equal((wrapper.receipt as { partial?: boolean }).partial, true);
  assert.equal((wrapper.receipt as { code?: string }).code, "NATIVE_CAPABILITY_UNAVAILABLE");
  assert.ok(
    operations.some(
      (operation) =>
        operation.parentOperationId === wrapper.id &&
        operation.toolName.startsWith("primitive.") &&
        operation.status === "succeeded",
    ),
    "the prior upload primitive must be reconciled from its succeeded native receipt",
  );
  assert.ok(
    operations.some(
      (operation) =>
        operation.parentOperationId === wrapper.id &&
        operation.toolName.startsWith("primitive.") &&
        operation.status === "rejected_not_dispatched",
    ),
    "only the transcription primitive should be rejected as not dispatched",
  );
  assert.ok(
    !operations.some((operation) =>
      ["dispatching", "running", "outcome_unknown"].includes(operation.status),
    ),
    JSON.stringify(
      operations.map(({ id, toolName, status, parentOperationId }) => ({
        id,
        toolName,
        status,
        parentOperationId,
      })),
    ),
  );
  const deliveries = await native.server.executors.deliveries(
    "local-user",
    registration.executorId,
  );
  assert.equal(deliveries.filter((delivery) => delivery.operation.kind === "media").length, 0);
  assert.ok(deliveries.some((delivery) => delivery.operation.id === uploadOperation.id));
  const artifact = await native.db.get<{ published: boolean; version: string; sha256: string }>(
    "local-user",
    "native-artifacts",
    uploadedArtifact.artifactId,
  );
  assert.equal(artifact?.published, true);
  assert.equal(artifact?.version, uploadSha);
  assert.equal(artifact?.sha256, uploadSha);
});

async function makeCrashSnapshot(
  state: Awaited<ReturnType<typeof nativeRuntime>>,
  addUnknownSibling = false,
) {
  const data = Buffer.from("bytes copied from Lenovo before publication crash");
  const sha256 = createHash("sha256").update(data).digest("hex");
  const { node } = state;
  const requestId = addUnknownSibling
    ? "export-crash-with-unrelated-unknown"
    : "export-crash-recovery";
  const path = "/workspace/report.docx";
  const headers = {
    Authorization: `Bearer ${state.session.token}`,
    "Content-Type": "application/json",
    "Idempotency-Key": requestId,
  };
  const request = state.server.app.request("/api/computer/files/export", {
    method: "POST",
    headers,
    body: JSON.stringify({ path }),
  });
  const claim = await node("claim", { epoch: state.epoch, waitMs: 5000 });
  const nativeRead = claim.operations?.[0];
  assert.ok(nativeRead);
  assert.equal(nativeRead.args.operation, "read_binary");

  const originalPut = state.db.put.bind(state.db);
  let failedAfterPhysicalWrite = false;
  state.db.put = async (owner, kind, value) => {
    if (!failedAfterPhysicalWrite && owner === "local-user" && kind === "files") {
      failedAfterPhysicalWrite = true;
      throw new Error("simulated process failure after publication file write");
    }
    return originalPut(owner, kind, value);
  };
  await node("receipt", {
    epoch: state.epoch,
    operationId: nativeRead.id,
    sequence: 1,
    receipt: {
      status: "succeeded",
      data: {
        path,
        base64: data.toString("base64"),
        size: data.length,
        sha256,
      },
    },
  });
  const firstResponse = await request;
  assert.equal(failedAfterPhysicalWrite, true);
  assert.equal(firstResponse.status, 409);
  const firstBody = await firstResponse.json();
  const taskId = firstBody.taskId;
  const task = await state.db.get<import("../packages/domain/src/agent.ts").AgentTask>(
    "local-user",
    "tasks",
    taskId,
  );
  assert.ok(task);
  assert.equal(task.status, "failed");
  const ops = await state.server.agent.journal.operations("local-user", taskId);
  const wrapper = ops.find((op) => op.toolName === "manual_native.export");
  assert.ok(wrapper);
  const localPublication = ops.find(
    (op) =>
      op.id ===
      `primitive:${wrapper.id}:file-publication:${createHash("sha256").update(`local-user:file:${wrapper.id}:report.docx`).digest("hex")}`,
  );
  assert.ok(localPublication, "real Files.importAttachment publication primitive is present");
  const publication = (
    await state.db.list<{ id: string; operationId: string; status: string }>(
      "local-user",
      "file-publications",
    )
  )[0];
  assert.ok(publication);
  assert.equal(publication.operationId, wrapper.id);
  assert.equal(publication.status, "prepared");
  const savedBytes = await readFile(join(state.directory, "files", `${publication.id}.bin`));
  assert.deepEqual(savedBytes, data, "all published bytes landed before simulated process death");
  assert.equal(localPublication.status, "dispatching");
  // The outer native read fails when our simulated exception is caught. The
  // publication primitive retains the unfinished filesystem write; below we replace
  // both receipts with the state an actual process death would leave.
  assert.equal(wrapper.status, "failed");

  // Recreate the durable state a process death leaves at this exact boundary:
  // the filesystem write and prepare row committed, but wrapper/primitive receipts did not.
  state.db.put = originalPut;
  await originalPut("local-user", "tasks", {
    ...task,
    status: "running",
    leaseId: "crashed-worker-lease",
    leaseUntil: "2000-01-01T00:00:00.000Z",
    error: undefined,
    question: undefined,
  });
  for (const operation of ops) {
    if (operation.id === wrapper.id || operation.id === localPublication.id) {
      const { receipt: _receipt, sequence: _sequence, ...crashed } = operation;
      await originalPut("local-user", "task-operations", { ...crashed, status: "dispatching" });
    }
  }
  if (addUnknownSibling) {
    await originalPut("local-user", "task-operations", {
      ...wrapper,
      id: `primitive:${wrapper.id}:unrelated-mutation`,
      parentOperationId: wrapper.id,
      physicalOperationId: `unrelated-mutation:${taskId}`,
      resourceHoldTaskId: `unrelated-mutation:${taskId}`,
      toolName: "primitive.manual_native.export",
      status: "outcome_unknown",
      effect: true,
      resourceLeaseIds: [],
      receipt: { outcomeUnknown: true },
    });
  }
  await state.restart();
  state.epoch = Number((await node("register", hello)).epoch);
  await node("reconcile", {
    epoch: state.epoch,
    bootId: hello.bootId,
    operations: [],
    contained: true,
  });
  return {
    requestId,
    path,
    taskId,
    wrapperId: wrapper.id,
    publicationId: publication.id,
    headers,
    data,
  };
}

test("manual export recovers a post-write crash from VPS bytes without a second Lenovo read", async (t) => {
  const fx = await nativeRuntime();
  t.after(fx.close);
  const snapshot = await makeCrashSnapshot(fx);
  const response = await fx.server.app.request("/api/computer/files/export", {
    method: "POST",
    headers: snapshot.headers,
    body: JSON.stringify({ path: snapshot.path }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const artifact = await response.json();
  assert.equal(artifact.id, snapshot.publicationId);
  assert.deepEqual(await fx.server.files.bytes("local-user", artifact.id), snapshot.data);
  assert.equal((await fx.db.list("local-user", "files")).length, 1);
  const publication = await fx.db.get<{ status: string }>(
    "local-user",
    "file-publications",
    snapshot.publicationId,
  );
  assert.equal(publication?.status, "published");
  const ops = await fx.server.agent.journal.operations("local-user", snapshot.taskId);
  assert.ok(
    ops.every((op) =>
      ["succeeded", "failed", "rejected_not_dispatched", "superseded"].includes(op.status),
    ),
    JSON.stringify(ops.map(({ id, status }) => ({ id, status }))),
  );
  assert.equal(
    ops.filter(
      (op) =>
        op.toolName === "native.file" &&
        (op.args as { operation?: string })?.operation === "read_binary",
    ).length,
    1,
  );
  assert.equal((await fx.node("claim", { epoch: fx.epoch, waitMs: 0 })).operations?.length ?? 0, 0);
});

test("recovered file publication does not erase a distinct unresolved mutation sibling", async (t) => {
  const fx = await nativeRuntime();
  t.after(fx.close);
  const snapshot = await makeCrashSnapshot(fx, true);
  const response = await fx.server.app.request("/api/computer/files/export", {
    method: "POST",
    headers: snapshot.headers,
    body: JSON.stringify({ path: snapshot.path }),
  });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.status, "waiting_input");
  const ops = await fx.server.agent.journal.operations("local-user", snapshot.taskId);
  const wrapper = ops.find((op) => op.id === snapshot.wrapperId);
  assert.equal(wrapper?.status, "dispatching");
  const unrelated = ops.find(
    (op) => op.id === `primitive:${snapshot.wrapperId}:unrelated-mutation`,
  );
  assert.equal(unrelated?.status, "outcome_unknown");
  assert.equal(
    ops.filter(
      (op) =>
        op.toolName === "native.file" &&
        (op.args as { operation?: string })?.operation === "read_binary",
    ).length,
    1,
  );
  assert.equal((await fx.node("claim", { epoch: fx.epoch, waitMs: 0 })).operations?.length ?? 0, 0);
});
