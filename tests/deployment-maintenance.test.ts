import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { DeploymentMaintenance } from "../apps/server/src/deployment-maintenance.ts";
import { WorkAdmission } from "../apps/server/src/engine/work-admission.ts";
import { browserFallbackFixture } from "./helpers/browser-fallback.ts";

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
