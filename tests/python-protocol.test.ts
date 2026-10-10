import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  nativePythonArgsSchema,
  nativePythonReplyArgsSchema,
  parsePythonRpc,
  pythonResourceKey,
  pythonResultSchema,
} from "../apps/server/src/executors/python-protocol.ts";

test("Python session resource identity matches the native UTF-8 compact JSON contract", () => {
  // Captured independently from executor.python_transport.python_resource_key.
  assert.equal(
    pythonResourceKey("node", "owner", "conversation"),
    "python-session:75937907dcbcd23981de491c1c38c40b85a5d29b4ba6f25fad7c575265552981",
  );
  assert.notEqual(
    pythonResourceKey("node", "owner", "conversation"),
    pythonResourceKey("node", "other", "conversation"),
  );
});

test("native Unicode previews and replacement-decoded raw bytes remain bounded valid results", () => {
  const result = {
    status: "ok",
    reused: false,
    state_reset: false,
    state_lost: false,
    cleanup_confirmed: false,
    stdout: "42\n",
    stderr: "",
    raw_stdout: "�".repeat(131072),
    duration_seconds: 0.01,
    host_call_pending: false,
    tool_calls: [
      {
        id: "call",
        name: "read_sample",
        args_preview: "🦊".repeat(500),
        status: "error",
        error: "🦊".repeat(2000),
      },
    ],
  };
  assert.equal(pythonResultSchema.safeParse(result).success, true);
  assert.equal(
    pythonResultSchema.safeParse({ ...result, stdout: "🦊".repeat(32769) }).success,
    false,
  );
});

test("native Python requests cannot select a shell, account, background launch or recursive catalog", () => {
  const args = {
    command: "Python cell",
    cwd: "/workspace",
    background: false,
    timeoutMs: 2000,
    pythonCell: {
      owner: "owner",
      sessionId: "conversation",
      code: "print(42)",
      tools: ["read_drive"],
      reset: false,
      maxToolCalls: 100,
      outputBytes: 131072,
    },
  };
  assert.deepEqual(nativePythonArgsSchema.parse(args), args);
  for (const invalid of [
    { ...args, command: "bash unsafe.sh" },
    { ...args, cwd: "/home/personal" },
    { ...args, background: true },
    { ...args, user: "root" },
    { ...args, pythonCell: { ...args.pythonCell, tools: ["execute_code"] } },
    { ...args, pythonCell: { ...args.pythonCell, tools: ["read_drive", "read_drive"] } },
  ])
    assert.equal(nativePythonArgsSchema.safeParse(invalid).success, false);
});

test("RPC identity belongs to verified native JSON, never to arbitrary child IDs or malformed arguments", () => {
  const json = JSON.stringify({ name: "read_drive", args: { query: "MovingDE" } });
  const request = { sequence: 1, json, sha256: createHash("sha256").update(json).digest("hex") };
  assert.deepEqual(parsePythonRpc(request), {
    ...request,
    name: "read_drive",
    args: { query: "MovingDE" },
  });
  assert.throws(() => parsePythonRpc({ ...request, json: json.replace("MovingDE", "other") }));
  for (const body of [
    { id: "chosen-by-child", name: "read_drive", args: {} },
    { name: "read_drive", args: [] },
  ]) {
    const raw = JSON.stringify(body);
    assert.throws(() =>
      parsePythonRpc({
        sequence: 1,
        json: raw,
        sha256: createHash("sha256").update(raw).digest("hex"),
      }),
    );
  }
});

test("reply controls preserve only bounded private delivery metadata", () => {
  const args = {
    operation: "python-reply",
    operationId: "cell",
    requestSequence: 1,
    requestHash: "a".repeat(64),
    replyReference: "9d073d59-b1c0-4f77-8897-20ea2093089c",
    replyHash: "b".repeat(64),
    replyBytes: 12,
  };
  assert.deepEqual(nativePythonReplyArgsSchema.parse(args), args);
  assert.equal(
    nativePythonReplyArgsSchema.safeParse({ ...args, result: { email: "raw" } }).success,
    false,
  );
  assert.equal(
    nativePythonReplyArgsSchema.safeParse({ ...args, requestSequence: 0 }).success,
    false,
  );
  assert.equal(
    nativePythonReplyArgsSchema.safeParse({ ...args, replyBytes: 9 * 1024 ** 2 }).success,
    false,
  );
});
