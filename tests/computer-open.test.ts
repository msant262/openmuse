import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { RpcComputerService } from "../apps/server/src/computer-rpc.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { attachmentLimit } from "../packages/domain/src/attachments.ts";
import { config as offline } from "./helpers/computer.ts";

const config: Config = {
  ...offline,
  computerBackend: "rpc",
  computerProfile: "open",
  computerUrl: "http://computer:8811",
  computerToken: "x".repeat(32),
  computerCommandTimeoutMs: 1800000,
};
function remote() {
  const records = new Map<string, Record<string, unknown>>();
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  let guarded = true;
  const upstream: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${config.computerToken}`);
    calls.push({ path, body });
    if (!guarded) return Response.json({ error: "guard failure" }, { status: 503 });
    if (path === "/rpc/jobs") {
      const receipt = {
        id: body.id,
        command: body.command,
        cwd: body.cwd,
        kind: body.kind,
        timeoutMs: body.timeoutMs,
        background: body.background,
        status: "running",
        stdout: "",
        stderr: "",
        truncated: false,
        startedAt: new Date().toISOString(),
      };
      records.set(body.id, receipt);
      return Response.json(receipt);
    }
    if (path === "/rpc/status" || path === "/rpc/start" || path === "/rpc/stop")
      return Response.json({ status: "running", commands: [...records.values()] });
    const receipt = records.get(path.split("/")[3]);
    if (!receipt) return Response.json({ error: "missing" }, { status: 404 });
    if (path.endsWith("/cancel")) receipt.status = "interrupted";
    return Response.json(receipt);
  };
  return {
    records,
    calls,
    upstream,
    failGuard: () => {
      guarded = false;
    },
  };
}
test("open helpers execute real local command/files; firewall is injected, never host kernel rules", {
  timeout: 20000,
}, async () => {
  const result = await promisify(execFile)("python3", ["apps/computer/test_contracts.py"], {
    env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
    timeout: 18000,
  });
  assert.match(result.stderr, /OK/);
});
test("RPC backgrounds survive API adapter restart, bind ownership and never repeat an operation", async () => {
  const db = await createStore();
  const mock = remote();
  const service = new RpcComputerService(db, config, mock.upstream);
  try {
    const receipt = await service.execute(
      "owner",
      { command: "sleep 1", background: true },
      { idempotencyKey: "once" },
    );
    assert.equal(receipt.status, "running");
    const restarted = new RpcComputerService(db, config, mock.upstream);
    assert.equal((await restarted.snapshot("owner")).commands[0].status, "running");
    const saved = mock.records.get(receipt.id);
    assert.ok(saved);
    saved.status = "succeeded";
    saved.stdout = "done";
    assert.equal(
      (
        await restarted.execute(
          "owner",
          { command: "sleep 1", background: true },
          { idempotencyKey: "once" },
        )
      ).stdout,
      "done",
    );
    assert.equal(mock.calls.filter((c) => c.path === "/rpc/jobs").length, 1);
    await assert.rejects(
      () =>
        restarted.execute(
          "owner",
          { command: "different", background: true },
          { idempotencyKey: "once" },
        ),
      /different arguments/,
    );
    await assert.rejects(() => restarted.command("other-owner", receipt.id), /another owner/);
    await assert.rejects(
      async () => restarted.execute("owner", { command: "true", timeoutMs: 1800001 }),
      /Too big/,
    );
  } finally {
    await db.close();
  }
});
test("lost submission and missing receipt never cause an automatic command retry", async () => {
  const db = await createStore();
  const mock = remote();
  const service = new RpcComputerService(db, config, mock.upstream);
  try {
    mock.failGuard();
    await assert.rejects(
      () =>
        service.execute(
          "owner",
          { command: "true", background: true },
          { idempotencyKey: "unknown" },
        ),
      /protection/,
    );
    assert.equal(
      (
        await service.execute(
          "owner",
          { command: "true", background: true },
          { idempotencyKey: "unknown" },
        )
      ).status,
      "interrupted",
    );
    assert.equal(mock.calls.filter((c) => c.path === "/rpc/jobs").length, 1);
  } finally {
    await db.close();
  }
});

test("RPC exports validate large binary limits and strict padding without exhausting the stack", async () => {
  const db = await createStore();
  let encoded = "";
  let calls = 0;
  const service = new RpcComputerService(db, config, async (_input, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.operation, "read_binary");
    return Response.json({ path: body.path, base64: encoded });
  });
  try {
    for (const size of [0, 128 * 1024, 1024 * 1024, 8 * 1024 * 1024, attachmentLimit]) {
      const bytes = Buffer.alloc(size, 173);
      encoded = bytes.toString("base64");
      const exported = await service.fileBytes("owner", "/workspace/large.bin");
      assert.deepEqual(exported.bytes, bytes, `${size}-byte export`);
    }
    const callsBeforeOtherOwner = calls;
    await assert.rejects(
      () => service.fileBytes("other-owner", "/workspace/large.bin"),
      /another owner/,
    );
    assert.equal(calls, callsBeforeOtherOwner);
    for (const invalid of [
      "A",
      "AA=",
      "A===",
      "AA=A",
      "=AAA",
      "AAAA====",
      "AA-_",
      "AA\n=",
      "AB==",
      "AAF=",
    ]) {
      encoded = invalid;
      await assert.rejects(
        () => service.fileBytes("owner", "/workspace/large.bin"),
        /invalid or oversized base64/,
        invalid,
      );
    }
    for (const excess of [1, 3]) {
      encoded = Buffer.alloc(attachmentLimit + excess, 173).toString("base64");
      await assert.rejects(() => service.fileBytes("owner", "/workspace/large.bin"));
    }
  } finally {
    await db.close();
  }
});
