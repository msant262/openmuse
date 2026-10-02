import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ActionService } from "../apps/server/src/actions.ts";
import type { ComputerBackend } from "../apps/server/src/computer-contract.ts";
import { computerTools } from "../apps/server/src/computer-tools.ts";
import { createStore } from "../apps/server/src/db.ts";
import { RuntimePause } from "../apps/server/src/engine/runtime-pause.ts";
import { WorkAdmission } from "../apps/server/src/engine/work-admission.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";

test("global pause persists, is revisioned, and atomically gates new work claims", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-runtime-pause-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const now = Date.parse("2026-10-02T10:00:00.000Z");
  const pause = new RuntimePause(db, () => now);
  const admission = new WorkAdmission(db, { now: () => now, leaseMs: 1_000 });
  try {
    assert.deepEqual(await pause.get("owner"), {
      paused: false,
      revision: 0,
      changedAt: "1970-01-01T00:00:00.000Z",
    });
    const paused = await pause.set("owner", { paused: true, expectedRevision: 0 });
    assert.deepEqual(paused, {
      paused: true,
      revision: 1,
      changedAt: new Date(now).toISOString(),
    });
    assert.deepEqual(await pause.set("owner", { paused: true, expectedRevision: 0 }), paused);
    assert.equal(await admission.claim("task-paused", "background", "task-paused"), false);

    await assert.rejects(() => pause.set("owner", { paused: false, expectedRevision: 0 }), {
      status: 409,
    });
    const resumed = await pause.set("owner", { paused: false, expectedRevision: paused.revision });
    assert.equal(resumed.revision, 2);
    assert.equal(await admission.claim("task-1", "background", "task-1"), true);

    const race = await Promise.all([
      pause.set("owner", { paused: true, expectedRevision: resumed.revision }),
      admission.claim("task-2", "background", "task-2"),
    ]);
    assert.equal(race[0].paused, true);
    assert.equal(await admission.claim("task-3", "background", "task-3"), false);

    await db.close();
    const reopened = await createStore({ dataDir: join(directory, "db") });
    try {
      assert.equal((await new RuntimePause(reopened).get("owner")).paused, true);
    } finally {
      await reopened.close();
    }
  } finally {
    await db.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("global pause racing an automatic action leaves it reviewable and explicitly not dispatched", async () => {
  const db = await createStore();
  const pause = new RuntimePause(db);
  let checks = 0;
  let dispatches = 0;
  const actions = new ActionService(db, {
    policy: "all",
    connected: async () => true,
    execute: async () => {
      dispatches++;
      return "sent";
    },
    guardEffects: async (owner) => {
      checks++;
      if (checks === 2) await pause.set(owner, { paused: true, expectedRevision: 0 });
      await pause.assertResumed(owner);
    },
  });
  try {
    const proposal = await actions.propose("owner", {
      kind: "email.send",
      data: { to: ["person@example.com"], subject: "Hello", body: "Test" },
    });
    const blocked = await actions.decide("owner", proposal.id, proposal.hash, "approve", "policy");
    assert.equal(dispatches, 0);
    assert.equal(blocked.status, "awaiting_review");
    assert.equal(blocked.error?.includes("globally paused"), true);
    assert.ok(
      (await db.actionLog("owner")).entries.some(
        (entry) => entry.operationId === proposal.id && entry.result === "rejected_not_dispatched",
      ),
    );

    const state = await pause.get("owner");
    await pause.set("owner", { paused: false, expectedRevision: state.revision });
    const manuallyApproved = await actions.decide(
      "owner",
      proposal.id,
      proposal.hash,
      "approve",
      "human",
    );
    assert.equal(manuallyApproved.status, "succeeded");
    assert.equal(dispatches, 1, "a later explicit human approval remains available");
  } finally {
    await actions.close();
    await db.close();
  }
});

test("global resume does not resume a task that was individually paused", async () => {
  const db = await createStore();
  const pause = new RuntimePause(db);
  const now = new Date().toISOString();
  const individuallyPaused: AgentTask = {
    id: "individual-pause",
    title: "Paused task",
    prompt: "Wait",
    kind: "agent",
    status: "paused",
    plan: [],
    evidence: [],
    input: {},
    state: { individuallyPaused: true },
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    leaseId: null,
    leaseUntil: null,
    artifactIds: [],
  };
  await db.put("owner", "tasks", individuallyPaused);
  let executions = 0;
  const worker = new TaskWorker(db, async () => {
    executions++;
    return { status: "succeeded" };
  });
  try {
    const paused = await pause.set("owner", { paused: true, expectedRevision: 0 });
    await pause.set("owner", { paused: false, expectedRevision: paused.revision });
    await worker.tick();
    assert.equal(
      (await db.get<AgentTask>("owner", "tasks", individuallyPaused.id))?.status,
      "paused",
    );
    assert.equal(executions, 0);
  } finally {
    await worker.stop();
    await db.close();
  }
});

test("global pause blocks automated computer tools invoked directly from chat", async () => {
  const db = await createStore();
  const pause = new RuntimePause(db);
  let dispatches = 0;
  const backend = {
    snapshot: async () => ({
      enabled: true,
      provider: "rpc",
      status: "running",
      workspacePath: "/workspace",
      network: "public-only",
      commands: [],
    }),
    start: async () => ({}),
    stop: async () => ({}),
    execute: async () => {
      dispatches++;
      return {
        id: "job",
        command: "echo",
        cwd: "/workspace",
        status: "succeeded",
        stdout: "",
        stderr: "",
        truncated: false,
        startedAt: new Date().toISOString(),
      };
    },
    list: async () => ({ path: "/workspace", entries: [] }),
    read: async () => ({ path: "/workspace/file", text: "" }),
    write: async () => ({ ok: true }),
    mkdir: async () => ({ ok: true }),
    writePdf: async () => ({ ok: true }),
    pdfBytes: async () => ({ name: "out.pdf", bytes: new Uint8Array() }),
    writeBytes: async () => ({ ok: true }),
    fileBytes: async () => ({ name: "out.bin", bytes: new Uint8Array() }),
  } as unknown as ComputerBackend;
  try {
    await pause.set("owner", { paused: true, expectedRevision: 0 });
    const run = computerTools(backend, {} as never, "owner", "chat:turn", {
      effectBefore: async () => {
        await pause.assertResumed("owner");
      },
    }).find((tool) => tool.name === "run_command");
    assert.ok(run);
    await assert.rejects(
      () =>
        (run.execute as (args: unknown) => Promise<unknown>)({
          command: "echo hello",
          operationId: "paused-chat-command",
        }),
      { status: 409 },
    );
    assert.equal(dispatches, 0);
  } finally {
    await db.close();
  }
});
