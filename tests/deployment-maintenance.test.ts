import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { DeploymentMaintenance } from "../apps/server/src/deployment-maintenance.ts";
import { deploymentStatus } from "../apps/server/src/deployment-status.ts";
import { WorkAdmission } from "../apps/server/src/engine/work-admission.ts";
import { browserFallbackFixture } from "./helpers/browser-fallback.ts";

test("deployment status never hydrates inactive tasks and historical operation outputs", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  await db.put("owner", "task-operations", {
    id: "old-read",
    status: "succeeded",
    receipt: { text: "LARGE_HISTORICAL_OUTPUT".repeat(100_000) },
  });
  await db.put("other-owner", "task-operations", {
    id: "uncertain-effect",
    status: "outcome_unknown",
    receipt: { cleanupConfirmed: false },
  });
  await db.put("owner", "tasks", {
    id: "old-task",
    status: "succeeded",
    state: { providerCheckpoint: { text: "LARGE_HISTORICAL_CONTEXT".repeat(100_000) } },
  });
  const scan = db.scan.bind(db);
  t.mock.method(db, "scan", async (kind: string) => {
    if (["tasks", "task-operations"].includes(kind))
      throw new Error("Deployment preflight must query bounded activity metadata");
    return scan(kind);
  });
  const status = await deploymentStatus(db);
  assert.equal(status.activeTasks, 0);
  assert.equal(
    status.activeOperations,
    1,
    "another owner's uncertain work still prevents clean backup",
  );
});

test("backup preflight counts active conversation leases across owners and waits for their release", async () => {
  const db = await createStore();
  try {
    await new DeploymentMaintenance(db).update("operator", randomUUID(), "begin");
    const now = Date.now();
    const future = new Date(now + 60_000).toISOString();
    for (const [owner, id, runToken, leaseUntil] of [
      ["operator", "local-chat", "local-run", future],
      ["another-owner", "remote-chat", "remote-run", future],
      ["another-owner", "expired-chat", "expired-run", new Date(now).toISOString()],
      ["another-owner", "released-chat", null, future],
      ["another-owner", "no-lease", "old-run", null],
    ] as const)
      await db.put(owner, "threads", { id, runToken, leaseUntil });

    const busy = await deploymentStatus(db, now);
    assert.equal(busy.activeConversations, 2);
    assert.equal(busy.activeTasks, 0);
    assert.equal(busy.activeHttpRequests, 0);
    assert.equal(busy.readyForStoppedWriterBackup, false);

    await db.compareAndSwap(
      "operator",
      "threads",
      "local-chat",
      { runToken: "local-run" },
      { runToken: null, leaseUntil: null },
    );
    const otherOwnerStillRunning = await deploymentStatus(db, now);
    assert.equal(otherOwnerStillRunning.activeConversations, 1);
    assert.equal(otherOwnerStillRunning.readyForStoppedWriterBackup, false);

    await db.compareAndSwap(
      "another-owner",
      "threads",
      "remote-chat",
      { runToken: "remote-run" },
      { runToken: null, leaseUntil: null },
    );
    const drained = await deploymentStatus(db, now);
    assert.equal(drained.activeConversations, 0);
    assert.equal(drained.readyForStoppedWriterBackup, true);
  } finally {
    await db.close();
  }
});

test("connected maintenance drains an actual task without abort, blocks new admissions and preserves user pause", async (t) => {
  const server = await browserFallbackFixture(t);
  const device = await server.auth.session(undefined, "deployment operator");
  const request = (path: string, body?: unknown) =>
    server.app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${device.token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  let started!: () => void;
  const running = new Promise<void>((r) => {
    started = r;
  });
  let complete!: () => void;
  const drain = new Promise<void>((r) => {
    complete = r;
  });
  t.after(() => complete());
  let aborted = false;
  const task = server.runTask(async (_invoke, _task, context) => {
    started();
    await drain;
    aborted = context.signal.aborted;
  });
  await running;
  const id = randomUUID();
  assert.equal(
    (await request("/api/deployment/maintenance", { id, operation: "begin" })).status,
    200,
  );
  const busy = await (await request("/api/deployment/status")).json();
  assert.equal(busy.pause.paused, false);
  assert.equal(busy.readyForStoppedWriterBackup, false);
  assert(busy.workAdmissions > 0);
  assert.equal(
    (await request("/api/agent/tasks", { prompt: "Must wait for maintenance" })).status,
    503,
  );
  const second = await server.agent.createTask("local-user", {
    kind: "agent",
    prompt: "Queued existing work",
  });
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask("local-user", second.id)).status, "queued");
  complete();
  await task;
  assert.equal(aborted, false);
  const idle = await (await request("/api/deployment/status")).json();
  assert.equal(idle.readyForStoppedWriterBackup, true);
  assert.equal(idle.pause.paused, false);
  assert.equal(
    (await request("/api/agent/runtime-pause", { paused: true, expectedRevision: 0 })).status,
    200,
  );
  assert.equal(
    (await request("/api/deployment/maintenance", { id, operation: "finish" })).status,
    200,
  );
  assert.equal((await (await request("/api/deployment/status")).json()).pause.paused, true);
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask("local-user", second.id)).status, "queued");
});

test("real SQL gate serializes admission against maintenance, allows held cleanup, expires and refuses another owner", async (t) => {
  const server = await browserFallbackFixture(t);
  const admission = new WorkAdmission(server.db);
  const maintenance = new DeploymentMaintenance(server.db);
  assert.equal(await admission.claim("retained", "background", "retained"), true);
  assert.equal(await admission.hold("retained"), true);
  const id = randomUUID();
  await maintenance.update("local-user", id, "begin");
  assert.equal(await admission.claim("blocked", "background", "blocked"), false);
  assert.equal(await admission.claim("retained", "background", "retained"), true);
  await assert.rejects(maintenance.update("another-owner", id, "finish"), /changed/);
  await assert.rejects(maintenance.update("local-user", randomUUID(), "begin"), /changed/);
  await admission.releaseHeld("retained");
  await server.db.put("__runtime__", "deployment-maintenance", {
    id: "global",
    owner: "local-user",
    active: true,
    expiresAt: "1970-01-01T00:00:00.000Z",
  });
  assert.equal(await maintenance.current(), null);
  assert.equal(await admission.claim("unblocked", "background", "unblocked"), true);
  await admission.release("unblocked");
});

test("maintenance ignores a completed legacy computer-status read without hiding active work or rewriting its receipt", async (t) => {
  const server = await browserFallbackFixture(t);
  const { deploymentStatus } = await import("../apps/server/src/deployment-status.ts");
  const historical = {
    id: "legacy-read",
    toolName: "computer_status",
    effect: false,
    status: "running",
    receipt: {
      enabled: true,
      provider: "native",
      status: "running",
      workspacePath: "/workspace",
      network: "public-only",
      commands: [],
    },
  };
  await server.db.put("local-user", "task-operations", historical);
  await new DeploymentMaintenance(server.db).update("local-user", randomUUID(), "begin");
  const idle = await deploymentStatus(server.db);
  assert.equal(idle.activeOperations, 0);
  assert.equal(idle.readyForStoppedWriterBackup, true);
  assert.deepEqual(await server.db.get("local-user", "task-operations", historical.id), historical);
  for (const operation of [
    { ...historical, id: "actual-effect", effect: true },
    { ...historical, id: "dispatching-read", status: "dispatching" },
    { ...historical, id: "unfinished-read", receipt: undefined },
    { ...historical, id: "failed-read", receipt: { ...historical.receipt, error: "failed" } },
  ])
    await server.db.put("local-user", "task-operations", operation);
  const busy = await deploymentStatus(server.db);
  assert.equal(busy.activeOperations, 4);
  assert.equal(busy.readyForStoppedWriterBackup, false);
});

test("native cleanup stops counting an uncertain operation while preserving its history and human leases", async (t) => {
  const server = await browserFallbackFixture(t);
  const { deploymentStatus } = await import("../apps/server/src/deployment-status.ts");
  const operation = {
    id: "native-read",
    toolName: "native.browser",
    effect: true,
    status: "outcome_unknown",
    nativeEnvelope: { id: "native-read", kind: "browser" },
    receipt: { status: "outcome_unknown", data: { cleanupConfirmed: true } },
  };
  await server.db.put("local-user", "task-operations", operation);
  await new DeploymentMaintenance(server.db).update("local-user", randomUUID(), "begin");
  assert.equal((await deploymentStatus(server.db)).activeOperations, 0);
  assert.deepEqual(await server.db.get("local-user", "task-operations", operation.id), operation);
  await server.db.put("local-user", "resource-leases", {
    id: "human-control",
    hold: true,
    expiresAt: "1970-01-01T00:00:00.000Z",
  });
  assert.equal((await deploymentStatus(server.db)).readyForStoppedWriterBackup, false);
  for (const row of [
    { ...operation, id: "not-native", nativeEnvelope: undefined },
    { ...operation, id: "wrong-envelope" },
    { ...operation, id: "still-running", status: "running" },
    {
      ...operation,
      id: "not-cleaned",
      nativeEnvelope: { id: "not-cleaned", kind: "browser" },
      receipt: { status: "outcome_unknown", data: {} },
    },
  ])
    await server.db.put("local-user", "task-operations", row);
  assert.equal((await deploymentStatus(server.db)).activeOperations, 4);
});
