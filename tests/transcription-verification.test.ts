import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { JournalOperation } from "../apps/server/src/engine/task-journal.ts";
import { taskCriteria } from "../apps/server/src/engine/task-verification.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("background execution is not a request to author a plan", () => {
  const prompt = "Transcreva o áudio anexado em segundo plano e me entregue o texto.";
  assert.ok(
    !taskCriteria({ kind: "agent", prompt }).some(
      (criterion) => criterion.id === "requested-artifact",
    ),
  );
  assert.ok(
    taskCriteria({
      kind: "agent",
      prompt: "Crie em segundo plano um plano de estudo de quatro semanas.",
    }).some((criterion) => criterion.id === "requested-artifact"),
  );
});

test("a resumed background transcription collects its complete TXT once before model delivery", async (t) => {
  const text = "Um modelo de linguagem reconhece padrões e pode cometer erros.";
  const fixture = await modelFixture(t, () => ({
    name: "finish_task",
    arguments: { summary: text },
  }));
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const receipt = {
    id: "owned-background-job",
    kind: "transcribe" as const,
    command: "transcribe",
    cwd: "/workspace",
    status: "succeeded" as const,
    exitCode: 0,
    stdout: "",
    stderr: "",
    truncated: false,
    background: true,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    cleanupConfirmed: true,
    result: {
      text,
      language: "pt",
      duration: 5,
      truncated: false,
      textPath: "/workspace/complete-transcript.txt",
    },
  };
  let reads = 0;
  f.agent.computer.command = async (_owner: string, id: string) => {
    assert.equal(id, receipt.id);
    return receipt;
  };
  t.mock.method(f.agent.computer, "fileBytes", async (_owner: string, path: string) => {
    assert.equal(path, receipt.result.textPath);
    reads++;
    return { name: "complete-transcript.txt", bytes: Buffer.from(text) };
  });
  const task = await f.agent.createTask("owner", {
    prompt: "Transcreva em segundo plano e me entregue o arquivo TXT.",
  });
  await f.db.put("owner", "tasks", {
    ...task,
    state: {
      ...task.state,
      waitingComputerCommandId: receipt.id,
      computerCleanupPendingId: receipt.id,
    },
  });
  await f.agent.worker.tick();
  const completed = await f.agent.getTask("owner", task.id);
  assert.equal(completed.status, "succeeded", completed.error ?? completed.question);
  assert.equal(completed.artifactIds.length, 1);
  assert.equal(
    Buffer.from(await f.files.bytes("owner", completed.artifactIds[0])).toString(),
    text,
  );
  assert.equal(reads, 1);
  assert.equal(
    fixture.requests.length,
    1,
    "the model need not rediscover or poll an already completed job",
  );
  await f.agent.media.completed("owner", f.agent.computer, receipt);
  assert.equal(reads, 1, "later status inspection reuses the owned published file");
});

test("a completed native transcription certifies its observed text without inventing a report", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", { prompt: "Agora transcreva esse áudio." });
  const id = randomUUID();
  const callId = randomUUID();
  const primitiveId = randomUUID();
  const createdAt = new Date().toISOString();
  const text = "Um modelo de linguagem reconhece padrões e pode cometer erros.";
  const receipt = {
    id,
    command: "transcribe",
    cwd: "/workspace",
    kind: "transcribe",
    status: "succeeded",
    exitCode: 0,
    stdout: "",
    stderr: "",
    truncated: false,
    startedAt: createdAt,
    completedAt: createdAt,
    cleanupConfirmed: true,
    result: {
      text,
      textPath: "/workspace/transcript.txt",
      duration: 5,
      language: "pt",
      truncated: false,
    },
  };
  const base = {
    taskId: task.id,
    revision: 0,
    executorId: "native",
    executorEpoch: 1,
    resourceFence: 0,
    runToken: "test",
    resourceLeaseIds: [],
    createdAt,
    status: "succeeded" as const,
    bindingHash: "a".repeat(64),
    effect: true,
  };
  const call = {
    ...base,
    id: callId,
    toolName: "transcribe",
    args: { path: "/workspace/audio.mp3", operationId: "asr" },
    receipt,
  };
  await server.agent.journal.prepare("owner", call);
  assert.notEqual(
    (await server.agent.verification.assess("owner", task.id, 0, text)).status,
    "verified",
    "an unbound tool claim cannot establish physical transcription",
  );
  await server.agent.journal.prepare("owner", {
    ...base,
    id: primitiveId,
    toolName: "primitive.transcribe",
    parentOperationId: callId,
    args: call.args,
    receipt,
  });
  const native: JournalOperation = {
    ...base,
    id,
    toolName: "native.media",
    parentOperationId: primitiveId,
    args: {
      mediaKind: "transcribe",
      parameters: {
        path: "/workspace/audio.mp3",
        textPath: "/workspace/transcript.txt",
        language: "pt",
      },
    },
    nativeEnvelope: {
      id,
      taskId: task.id,
      revision: 0,
      executorId: "native",
      executorEpoch: 1,
      resourceFence: 0,
      createdAt,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      kind: "media",
      capability: "transcribe",
      capabilityVersion: 1,
      resourceKey: "cpu-heavy",
      inspection: false,
      bindingHash: "a".repeat(64),
    },
    receipt: { status: "succeeded", data: receipt },
  };
  await server.agent.journal.prepare("owner", native);
  assert.equal(
    (await server.agent.verification.assess("owner", task.id, 0, text)).status,
    "verified",
  );
  for (const invalid of [
    { ...receipt, result: { ...receipt.result, text: "" } },
    { ...receipt, result: { ...receipt.result, truncated: true } },
    { ...receipt, outcomeUnknown: true },
    { ...receipt, cleanupConfirmed: false },
    { ...receipt, result: { ...receipt.result, text: "Different physical result" } },
  ]) {
    await server.db.put("owner", "task-operations", { ...call, receipt: invalid });
    assert.notEqual(
      (await server.agent.verification.assess("owner", task.id, 0, text)).status,
      "verified",
      JSON.stringify(invalid),
    );
  }
  await server.db.put("owner", "task-operations", call);
  for (const invalid of [
    { ...native, revision: 1 },
    { ...native, parentOperationId: "another-call" },
    { ...native, nativeEnvelope: { ...native.nativeEnvelope, capability: "preview" } },
    {
      ...native,
      receipt: {
        status: "succeeded",
        data: { ...receipt, result: { ...receipt.result, text: "Different physical result" } },
      },
    },
  ]) {
    await server.db.put("owner", "task-operations", invalid);
    assert.notEqual(
      (await server.agent.verification.assess("owner", task.id, 0, text)).status,
      "verified",
      "unrelated or altered native receipts cannot certify transcription",
    );
  }
});
