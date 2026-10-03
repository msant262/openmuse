import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ComputerPendingError, ComputerRequests } from "../src/computer-requests.ts";
import type { MessageStorage } from "../src/message-storage.ts";

function fixture() {
  const records = new Map<string, string>();
  const storage: MessageStorage = {
    read: async (key) => records.get(key) ?? null,
    write: async (key, value) => {
      records.set(key, value);
    },
    update: async (key, change) => {
      const value = change(records.get(key) ?? null);
      records.set(key, value);
      return value;
    },
  };
  let sequence = 0;
  const create = () =>
    new ComputerRequests(
      storage,
      async (value) => createHash("sha256").update(value).digest("hex"),
      () => `request-${++sequence}`,
    );
  return { create, storage, records };
}
test("queued native request survives reopen and polls its exact receipt before a dependent export", async () => {
  const f = fixture();
  const calls: string[] = [];
  const api = async (path: string, _body?: unknown, id?: string) => {
    calls.push(`${path}:${id}`);
    return { pending: true, taskId: "task-one" };
  };
  await assert.rejects(
    f
      .create()
      .request("paired-phone", "/api/computer/preview", { path: "/workspace/report.docx" }, api),
    ComputerPendingError,
  );
  const result = await f
    .create()
    .request(
      "paired-phone",
      "/api/computer/preview",
      { path: "/workspace/report.docx" },
      async (path, _body, id) => {
        calls.push(`${path}:${id}`);
        return {
          taskId: "task-one",
          result: { status: "succeeded", outputPath: "/workspace/report.pdf" },
        };
      },
    );
  assert.deepEqual(result, { status: "succeeded", outputPath: "/workspace/report.pdf" });
  assert.deepEqual(calls, [
    "/api/computer/preview:request-1",
    "/api/computer/requests/task-one:request-1",
  ]);
});
test("terminal error received from the task poll is preserved for the UI", async () => {
  const f = fixture();
  const request = f.create();
  const send = async (path: string) =>
    path === "/api/computer/transcribe-attachment"
      ? { pending: true, taskId: "task-failed" }
      : { taskId: "task-failed", status: "error", error: "Transcript output was unavailable" };

  await assert.rejects(
    request.request("phone", "/api/computer/transcribe-attachment", { fileId: "audio-1" }, send),
    ComputerPendingError,
  );
  assert.deepEqual(
    await f
      .create()
      .request("phone", "/api/computer/transcribe-attachment", { fileId: "audio-1" }, send),
    { taskId: "task-failed", status: "error", error: "Transcript output was unavailable" },
  );
});
test("lost acceptance response reuses original intention after restart; acknowledged new request gets another id", async () => {
  const f = fixture();
  const ids: (string | undefined)[] = [];
  let fail = true;
  const send = async (_path: string, _body?: unknown, id?: string) => {
    ids.push(id);
    if (fail) {
      fail = false;
      throw new Error("connection lost after acceptance");
    }
    return { path: "/workspace/saved.txt" };
  };
  await assert.rejects(
    f.create().request("phone", "/api/computer/files/write", { text: "hello" }, send),
  );
  await f.create().request("phone", "/api/computer/files/write", { text: "hello" }, send);
  await f.create().request("phone", "/api/computer/files/write", { text: "hello" }, send);
  assert.deepEqual(ids, ["request-1", "request-1", "request-2"]);
});
test("storage failure prevents dispatch; concurrent double tap shares one call and pairing scopes stay separate", async () => {
  const f = fixture();
  f.storage.update = async () => {
    throw new Error("disk full");
  };
  let calls = 0;
  await assert.rejects(
    f.create().request("phone", "/api/computer/commands", { command: "pwd" }, async () => ++calls),
    /disk full/,
  );
  assert.equal(calls, 0);
  const good = fixture();
  const client = good.create();
  const send = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { ok: true };
  };
  await Promise.all([
    client.request("one", "/api/computer/start", {}, send),
    client.request("one", "/api/computer/start", {}, send),
    client.request("two", "/api/computer/start", {}, send),
  ]);
  assert.equal(calls, 2);
});
