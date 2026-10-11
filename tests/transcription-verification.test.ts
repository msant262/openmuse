import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { JournalOperation } from "../apps/server/src/engine/task-journal.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

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
