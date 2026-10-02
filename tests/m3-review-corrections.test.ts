import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ActionLog } from "../apps/server/src/action-log.ts";
import { ActionService } from "../apps/server/src/actions.ts";
import { auditedComputer, reconcileComputerAudit } from "../apps/server/src/audited-computer.ts";
import { ComputerService } from "../apps/server/src/computer.ts";
import { RpcComputerService } from "../apps/server/src/computer-rpc.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ResourceLeases } from "../apps/server/src/engine/resource-leases.ts";
import { RuntimePause } from "../apps/server/src/engine/runtime-pause.ts";
import { AppError } from "../apps/server/src/errors.ts";
import { fixture, config as offline } from "./helpers/computer.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const rpcConfig: Config = {
  ...offline,
  computerBackend: "rpc",
  computerProfile: "open",
  computerUrl: "http://computer:8811",
  computerToken: "x".repeat(32),
  computerCommandTimeoutMs: 1800000,
};

test("persisted global pause is rechecked at the real RPC handoff", async () => {
  const db = await createStore();
  const pause = new RuntimePause(db);
  const resources = new ResourceLeases(db);
  const sent: string[] = [];
  const rpc = new RpcComputerService(db, rpcConfig, async (url) => {
    sent.push(new URL(String(url)).pathname);
    return Response.json({});
  });
  const computer = auditedComputer(rpc, new ActionLog(db), "rpc", resources, "pause-host", pause);
  const id = digest("owner:pause-at-handoff");
  try {
    await assert.rejects(
      () =>
        computer.execute(
          "owner",
          { command: "echo should-not-run", background: true },
          {
            idempotencyKey: "pause-at-handoff",
            onDispatch: async () => {
              await pause.set("owner", { paused: true, expectedRevision: 0 });
            },
          },
        ),
      (error: unknown) => error instanceof AppError && /globally paused/.test(error.message),
    );
    assert.deepEqual(sent, [], "the backend handoff is skipped after the final pause check");
    assert.equal(
      (await db.get<{ status: string }>("owner", "computer-commands", id))?.status,
      "rejected_not_dispatched",
    );
    assert.equal((await resources.listForTask(id)).length, 0);
  } finally {
    await db.close();
  }
});

test("persisted global pause is rechecked before local Docker command handoff", async () => {
  const db = await createStore();
  const pause = new RuntimePause(db);
  const resources = new ResourceLeases(db);
  const docker = fixture();
  const local = new ComputerService(db, offline, docker.runner);
  const computer = auditedComputer(
    local,
    new ActionLog(db),
    "docker",
    resources,
    "local-pause-host",
    pause,
  );
  const id = digest("computer-command:local-pause-at-handoff");
  try {
    await assert.rejects(
      () =>
        computer.execute(
          "owner",
          { command: "echo should-not-run" },
          {
            idempotencyKey: "local-pause-at-handoff",
            onDispatch: async () => {
              await pause.set("owner", { paused: true, expectedRevision: 0 });
            },
          },
        ),
      /globally paused/,
    );
    assert.equal(
      docker.calls.some((call) => call.args[0] === "exec"),
      false,
    );
    assert.equal(
      (await db.get<{ status: string }>("owner", "computer-commands", id))?.status,
      "rejected_not_dispatched",
    );
    assert.equal((await resources.listForTask(id)).length, 0);
  } finally {
    await db.close();
  }
});

test("busy is a retryable explicit rejection while uncertain RPC failures remain one-shot", async () => {
  const db = await createStore();
  const resources = new ResourceLeases(db);
  let submissions = 0;
  const rpc = new RpcComputerService(db, rpcConfig, async (url, init) => {
    if (new URL(String(url)).pathname !== "/rpc/jobs") return Response.json({});
    submissions++;
    if (submissions === 1)
      return Response.json({ code: "busy", notDispatched: true }, { status: 409 });
    const body = JSON.parse(String(init?.body));
    return Response.json({
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
    });
  });
  const computer = auditedComputer(rpc, new ActionLog(db), "rpc", resources, "busy-host");
  const id = digest("owner:busy-retry");
  try {
    const rejected = await computer.execute(
      "owner",
      { command: "echo retry", background: true },
      { idempotencyKey: "busy-retry" },
    );
    assert.equal(rejected.status, "rejected_not_dispatched");
    assert.equal((await resources.listForTask(id)).length, 0);

    const retried = await computer.execute(
      "owner",
      { command: "echo retry", background: true },
      { idempotencyKey: "busy-retry" },
    );
    assert.equal(retried.status, "running");
    assert.equal(submissions, 2);
    assert.equal((await resources.listForTask(id)).length, 2);
    const savedAudit = await db.get<{ phase: string; complete?: boolean }>(
      "owner",
      "computer-audit",
      id,
    );
    assert.equal(savedAudit?.phase, "dispatching");
    assert.equal(savedAudit?.complete, false);
  } finally {
    await db.close();
  }
});

test("computer audit preparation failure cannot strand physical resource capacity", async () => {
  const db = await createStore();
  const resources = new ResourceLeases(db);
  const log = new ActionLog(db);
  const docker = fixture();
  const local = new ComputerService(db, offline, docker.runner);
  log.append = async () => {
    throw new Error("injected audit append failure");
  };
  const originalRelease = db.releaseResourceLease.bind(db);
  let failOneRelease = true;
  let releaseAttempts = 0;
  db.releaseResourceLease = async (lease) => {
    releaseAttempts++;
    if (failOneRelease) {
      failOneRelease = false;
      throw new Error("injected lease cleanup failure");
    }
    return originalRelease(lease);
  };
  const computer = auditedComputer(local, log, "docker", resources, "audit-failure-host");
  const id = digest("computer-command:preflight-audit-failure");
  try {
    await assert.rejects(
      computer.execute(
        "owner",
        { command: "echo x", background: true },
        { idempotencyKey: "preflight-audit-failure" },
      ),
      /injected audit append failure/,
    );
    assert.equal(
      docker.calls.some((call) => call.args[0] === "exec"),
      false,
    );
    assert.equal(failOneRelease, false);
    assert.equal(releaseAttempts, 2);
    assert.equal((await resources.listForTask(id)).length, 1);
    db.releaseResourceLease = originalRelease;
    await reconcileComputerAudit(computer, new ActionLog(db));
    assert.equal((await resources.listForTask(id)).length, 0);
    assert.equal(
      (await db.get<{ complete?: boolean }>("owner", "computer-audit", id))?.complete,
      true,
    );
    assert.ok(
      await resources.acquire("owner", "replacement", [
        { key: "cpu-heavy:audit-failure-host", units: 1, mode: "exclusive" },
      ]),
    );
  } finally {
    await db.close();
  }
});

test("local Docker audit reconciliation reads terminal receipts from its production snapshot", async () => {
  const db = await createStore();
  const docker = fixture();
  const local = new ComputerService(db, offline, docker.runner);
  const log = new ActionLog(db);
  const computer = auditedComputer(
    local,
    log,
    "docker",
    new ResourceLeases(db),
    "local-reconcile-host",
  );
  const id = digest("computer-command:local-snapshot-reconcile");
  try {
    const receipt = await computer.execute(
      "owner",
      { command: "echo terminal" },
      { idempotencyKey: "local-snapshot-reconcile" },
    );
    assert.equal(receipt.status, "succeeded");
    assert.equal("command" in local, false, "the local adapter exposes receipts via snapshot");
    assert.equal(
      (await db.get<{ complete?: boolean }>("owner", "computer-audit", id))?.complete,
      false,
    );

    await reconcileComputerAudit(computer, log);
    assert.equal(
      (await db.get<{ complete?: boolean }>("owner", "computer-audit", id))?.complete,
      true,
    );
  } finally {
    await db.close();
  }
});

test("canonical workspace aliases share the same audited file lease", async () => {
  const db = await createStore();
  const entered = deferred();
  const release = deferred();
  const requests: Record<string, unknown>[] = [];
  const rpc = new RpcComputerService(db, rpcConfig, async (url, init) => {
    if (new URL(String(url)).pathname === "/rpc/files") {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      entered.resolve();
      await release.promise;
      return Response.json({ path: body.path });
    }
    return Response.json({});
  });
  const resources = new ResourceLeases(db);
  const computer = auditedComputer(rpc, new ActionLog(db), "rpc", resources, "file-alias-host");
  const first = computer.write("owner", "/workspace/report.txt", "first");
  try {
    await entered.promise;
    await assert.rejects(
      computer.write("owner", "/workspace/./report.txt", "second"),
      /currently leased/,
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, "/workspace/report.txt");
  } finally {
    release.resolve();
    await first;
    await db.close();
  }
});

test("human approval remains reviewable and audited while global pause is active", async () => {
  const db = await createStore();
  const pause = new RuntimePause(db);
  let dispatches = 0;
  const actions = new ActionService(db, {
    policy: "all",
    execute: async () => "unused",
    connected: async () => true,
    guardEffects: async (owner) => pause.assertResumed(owner).then(() => undefined),
  });
  actions.registerExternal("example.send", async () => {
    dispatches++;
    return "sent";
  });
  try {
    const proposal = await actions.proposeExternal(
      "owner",
      {
        tool: "example.send",
        target: "Example",
        summary: "Send once",
        money: false,
        binding: { to: "private" },
      },
      "paused-review",
    );
    await pause.set("owner", { paused: true, expectedRevision: 0 });
    const result = await actions.decide("owner", proposal.id, proposal.hash, "approve", "human");
    assert.equal(result.status, "awaiting_review");
    assert.equal(dispatches, 0);
    const entries = await db.actionLog("owner", 20);
    assert.ok(
      entries.entries.some(
        (entry) => entry.operationId === proposal.id && entry.result === "rejected_not_dispatched",
      ),
    );
  } finally {
    await db.close();
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
