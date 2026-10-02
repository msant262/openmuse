import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ActionLog } from "../apps/server/src/action-log.ts";
import { ActionService } from "../apps/server/src/actions.ts";
import { auditedComputer, reconcileComputerAudit } from "../apps/server/src/audited-computer.ts";
import type { ComputerBackend } from "../apps/server/src/computer-contract.ts";
import { computerTools } from "../apps/server/src/computer-tools.ts";
import { createStore } from "../apps/server/src/db.ts";
import { reconcileWaitingComputerTasks } from "../apps/server/src/engine/computer-jobs.ts";
import { ResourceLeases } from "../apps/server/src/engine/resource-leases.ts";
import { AgentService } from "../apps/server/src/engine/service.ts";
import { WorkAdmission } from "../apps/server/src/engine/work-admission.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { ComputerCommand } from "../packages/domain/src/computer.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function receipt(id: string, status: ComputerCommand["status"]): ComputerCommand {
  return {
    id,
    command: "render",
    cwd: "/workspace",
    status,
    stdout: "",
    stderr: "",
    truncated: false,
    startedAt: "2026-10-02T10:00:00.000Z",
  };
}

test("uncertain computer timeout holds host resources until reconciliation confirms terminal", async () => {
  const db = await createStore();
  const log = new ActionLog(db);
  const resources = new ResourceLeases(db);
  const idempotencyKey = "task:render:one";
  const id = digest(`computer-command:${idempotencyKey}`);
  let terminal = false;
  let interruptedSnapshot = false;
  let submissions = 0;
  const base = {
    snapshot: async () => ({
      enabled: true,
      provider: "rpc",
      status: "running",
      workspacePath: "/workspace",
      network: "public-only",
      commands: interruptedSnapshot ? [receipt(id, "interrupted")] : [],
    }),
    start: async () => ({}),
    stop: async () => ({}),
    execute: async (
      owner: string,
      _raw: unknown,
      options: {
        idempotencyKey?: string;
        onDispatch?: (commandId: string) => Promise<void>;
      },
    ) => {
      submissions++;
      await options.onDispatch?.(digest(`computer-command:${options.idempotencyKey}`));
      await db.put(owner, "computer-commands", receipt(id, "running"));
      throw Object.assign(new Error("response timed out after submission"), {
        outcomeUnknown: true,
      });
    },
    list: async () => ({ path: "/workspace", entries: [] }),
    read: async () => ({ path: "/workspace/file", text: "" }),
    write: async () => ({ ok: true }),
    mkdir: async () => ({ ok: true }),
    writePdf: async () => ({ ok: true }),
    pdfBytes: async () => ({ name: "out.pdf", bytes: new Uint8Array() }),
    writeBytes: async () => ({ ok: true }),
    fileBytes: async () => ({ name: "out.bin", bytes: new Uint8Array() }),
    command: async (_owner: string, commandId: string) =>
      receipt(commandId, terminal ? "succeeded" : "running"),
  } as unknown as ComputerBackend;
  const computer = auditedComputer(base, log, "docker", resources, "physical-host-test");
  try {
    await assert.rejects(
      () => computer.execute("owner", { command: "render", cwd: "/workspace" }, { idempotencyKey }),
      /timed out after submission/,
    );
    assert.equal(submissions, 1);
    assert.equal(
      (await resources.listForTask(id)).length,
      2,
      "heavy and admin-shared leases stay held",
    );
    assert.equal(
      await resources.acquire("owner", "other-task", [
        { key: "cpu-heavy:physical-host-test", units: 1, mode: "exclusive" },
      ]),
      null,
    );

    interruptedSnapshot = true;
    await computer.snapshot("owner");
    assert.equal(
      (await resources.listForTask(id)).length,
      2,
      "an interrupted snapshot is uncertainty, not terminal confirmation",
    );

    await reconcileComputerAudit(computer, log);
    assert.equal(
      (await resources.listForTask(id)).length,
      2,
      "a running receipt keeps both leases",
    );
    terminal = true;
    await reconcileComputerAudit(computer, log);
    assert.equal(
      (await resources.listForTask(id)).length,
      0,
      "confirmed completion releases held leases",
    );
    assert.ok(
      await resources.acquire("owner", "other-task", [
        { key: "cpu-heavy:physical-host-test", units: 1, mode: "exclusive" },
      ]),
    );
    await reconcileComputerAudit(computer, log);
    assert.equal(
      submissions,
      1,
      "reconciliation observes receipts and never resubmits the command",
    );
  } finally {
    await db.close();
  }
});

test("a running production computer tool holds its task slot until the receipt is terminal", async () => {
  const db = await createStore();
  const log = new ActionLog(db);
  const resources = new ResourceLeases(db);
  let terminal = false;
  let receiptId = "";
  let commandSubmissions = 0;
  const gates = Array.from({ length: 3 }, () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
  });
  const base = {
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
    execute: async (
      owner: string,
      _raw: unknown,
      options: {
        idempotencyKey?: string;
        onDispatch?: (receiptId: string) => Promise<void>;
      },
    ) => {
      commandSubmissions++;
      receiptId = digest(`${owner}:${options.idempotencyKey}`);
      await options.onDispatch?.(receiptId);
      const pending = receipt(receiptId, "running");
      await db.put(owner, "computer-commands", pending);
      return pending;
    },
    list: async () => ({ path: "/workspace", entries: [] }),
    read: async () => ({ path: "/workspace/file", text: "" }),
    write: async () => ({ ok: true }),
    mkdir: async () => ({ ok: true }),
    writePdf: async () => ({ ok: true }),
    pdfBytes: async () => ({ name: "out.pdf", bytes: new Uint8Array() }),
    writeBytes: async () => ({ ok: true }),
    fileBytes: async () => ({ name: "out.bin", bytes: new Uint8Array() }),
    command: async (_owner: string, commandId: string) =>
      receipt(commandId, terminal ? "succeeded" : "running"),
  } as unknown as ComputerBackend;
  const computer = auditedComputer(base, log, "rpc", resources, "physical-host-test");
  const makeTask = (id: string, age: number): AgentTask => {
    const now = new Date(Date.now() - age).toISOString();
    return {
      id,
      title: id,
      prompt: "run a background job",
      kind: "agent",
      status: "queued",
      plan: [],
      evidence: [],
      input: {},
      state: {},
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      leaseId: null,
      leaseUntil: null,
      artifactIds: [],
    };
  };
  for (const [index, id] of ["physical-task", "held-1", "held-2", "held-3", "fifth-task"].entries())
    await db.put("owner", "tasks", makeTask(id, 1000 - index));

  const worker = new TaskWorker(
    db,
    async (owner, task, context) => {
      if (typeof task.state.waitingComputerCommandId === "string") {
        const status = await computer.command?.(owner, task.state.waitingComputerCommandId);
        if (status?.status !== "succeeded" && status?.status !== "failed")
          return { status: "waiting_job", state: task.state };
        return { status: "succeeded", state: { ...task.state, waitingComputerCommandId: null } };
      }
      if (task.id.startsWith("held-")) {
        await gates[Number(task.id.slice(-1)) - 1]?.promise;
        return { status: "succeeded" };
      }
      if (task.id === "fifth-task") return { status: "succeeded" };
      let state = task.state;
      const tools = computerTools(computer, {} as never, owner, `task:${task.id}`, {
        before: context.guard,
        effectBefore: context.guard,
        onComputerDispatch: async (id) => {
          state = (
            await context.checkpoint({
              state: { ...state, waitingComputerCommandId: id },
            })
          ).state;
          await context.holdAdmission();
        },
        onComputerReceipt: async (completed) => {
          state = (
            await context.checkpoint({
              state: {
                ...state,
                waitingComputerCommandId: null,
                completedComputerJob: { id: completed.id, status: completed.status },
              },
            })
          ).state;
        },
        onWaitingJob: async ({ id, uncertain }) => {
          state = (
            await context.checkpoint({
              state: {
                ...state,
                waitingComputerCommandId: id,
                ...(uncertain ? { uncertainComputerCommand: true } : {}),
              },
            })
          ).state;
        },
      });
      const run = tools.find((tool) => tool.name === "run_command");
      assert.ok(run);
      await (run.execute as (args: unknown) => Promise<unknown>)({
        command: "sleep 30",
        cwd: "/workspace",
        background: true,
        operationId: "background-one",
      });
      return { status: "waiting_job", state };
    },
    { jobPollMs: 0 },
  );
  const firstTick = worker.tick();
  try {
    const deadline = Date.now() + 2_000;
    while (
      (await db.get<AgentTask>("owner", "tasks", "physical-task"))?.status !== "waiting_job" &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(
      (await db.get<AgentTask>("owner", "tasks", "physical-task"))?.status,
      "waiting_job",
    );
    assert.equal(
      (await db.get<AgentTask>("owner", "tasks", "physical-task"))?.state.waitingComputerCommandId,
      receiptId,
    );
    assert.equal((await resources.listForTask(receiptId)).length, 2);
    assert.equal((await db.list("__runtime__", "work-admissions")).length, 4);
    await worker.tick();
    assert.equal((await db.get<AgentTask>("owner", "tasks", "fifth-task"))?.status, "queued");

    terminal = true;
    await worker.tick();
    assert.equal((await db.get<AgentTask>("owner", "tasks", "physical-task"))?.status, "succeeded");
    assert.equal((await resources.listForTask(receiptId)).length, 0);
    assert.equal(commandSubmissions, 1, "receipt polling never resubmits a physical command");
    await worker.tick();
    assert.equal(
      (await db.get<AgentTask>("owner", "tasks", "fifth-task"))?.status,
      "succeeded",
      JSON.stringify(await db.list("__runtime__", "work-admissions")),
    );
  } finally {
    for (const gate of gates) gate.resolve();
    await Promise.allSettled([firstTick]);
    await worker.stop();
    await db.close();
  }
});

test("cancelling a physical job keeps its global slot through restart until terminal receipt", async () => {
  const db = await createStore();
  const log = new ActionLog(db);
  const resources = new ResourceLeases(db);
  let terminal = false;
  let receiptId = "";
  let submissions = 0;
  const base = {
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
    execute: async (
      owner: string,
      _raw: unknown,
      options: {
        idempotencyKey?: string;
        onDispatch?: (commandId: string) => Promise<void>;
      },
    ) => {
      submissions++;
      receiptId = digest(`${owner}:${options.idempotencyKey}`);
      await options.onDispatch?.(receiptId);
      const pending = receipt(receiptId, "running");
      await db.put(owner, "computer-commands", pending);
      return pending;
    },
    list: async () => ({ path: "/workspace", entries: [] }),
    read: async () => ({ path: "/workspace/file", text: "" }),
    write: async () => ({ ok: true }),
    mkdir: async () => ({ ok: true }),
    writePdf: async () => ({ ok: true }),
    pdfBytes: async () => ({ name: "out.pdf", bytes: new Uint8Array() }),
    writeBytes: async () => ({ ok: true }),
    fileBytes: async () => ({ name: "out.bin", bytes: new Uint8Array() }),
    command: async (_owner: string, commandId: string) =>
      receipt(commandId, terminal ? "succeeded" : "running"),
  } as unknown as ComputerBackend;
  const computer = auditedComputer(base, log, "rpc", resources, "physical-host-cancel-test");
  const physical: AgentTask = {
    id: "cancelled-physical-task",
    title: "Long physical command",
    prompt: "Run a background job",
    kind: "agent",
    status: "queued",
    plan: [],
    evidence: [],
    input: {},
    state: {},
    createdAt: new Date(Date.now() - 10_000).toISOString(),
    updatedAt: new Date().toISOString(),
    attempts: 0,
    leaseId: null,
    leaseUntil: null,
    artifactIds: [],
  };
  const makeTask = (id: string, status: AgentTask["status"]): AgentTask => ({
    ...physical,
    id,
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: status === "waiting_job" ? { waitingComputerCommandId: `${id}-receipt` } : {},
    ...(status === "waiting_job" ? { nextRunAt: new Date(Date.now() + 60_000).toISOString() } : {}),
  });
  await db.put("owner", "tasks", physical);
  const admissions = new WorkAdmission(db);
  for (const id of ["other-job-1", "other-job-2", "other-job-3"]) {
    await db.put("owner", "tasks", makeTask(id, "waiting_job"));
    assert.equal(await admissions.claim(id, "background", id), true);
    assert.equal(await admissions.hold(id), true);
  }
  await db.put("owner", "tasks", makeTask("fifth-task", "queued"));

  let continuationRuns = 0;
  const worker = new TaskWorker(
    db,
    async (owner, task, context) => {
      if (task.id !== physical.id) {
        continuationRuns++;
        return { status: "succeeded" };
      }
      let state = task.state;
      const run = computerTools(computer, {} as never, owner, `task:${task.id}`, {
        before: context.guard,
        effectBefore: context.guard,
        onComputerDispatch: async (id) => {
          state = (await context.checkpoint({ state: { ...state, waitingComputerCommandId: id } }))
            .state;
          await context.holdAdmission();
        },
        onWaitingJob: async ({ id }) => {
          state = (await context.checkpoint({ state: { ...state, waitingComputerCommandId: id } }))
            .state;
        },
      }).find((tool) => tool.name === "run_command");
      assert.ok(run);
      await (run.execute as (args: unknown) => Promise<unknown>)({
        command: "sleep 30",
        cwd: "/workspace",
        background: true,
        operationId: "cancel-background-job",
      });
      return { status: "waiting_job", state };
    },
    { jobPollMs: 0 },
  );
  const restart = new TaskWorker(db, async () => {
    continuationRuns++;
    return { status: "succeeded" };
  });
  const agent = new AgentService(
    db,
    { routineTimezone: "UTC", mcpServers: [] } as never,
    {} as never,
    {} as never,
    new ActionService(db, {
      policy: "all",
      connected: async () => true,
      execute: async () => "unused",
    }),
    {} as never,
    computer,
  );
  try {
    await worker.tick();
    assert.equal((await db.get<AgentTask>("owner", "tasks", physical.id))?.status, "waiting_job");
    assert.equal((await db.list("__runtime__", "work-admissions")).length, 4);
    assert.equal(submissions, 1);

    await agent.control("owner", physical.id, "cancel");
    await worker.stop();
    assert.equal((await db.get<AgentTask>("owner", "tasks", physical.id))?.status, "cancelled");

    await restart.tick();
    assert.equal(continuationRuns, 0, "the cancelled task is never resumed after restart");
    assert.equal((await db.get<AgentTask>("owner", "tasks", "fifth-task"))?.status, "queued");
    assert.equal((await db.list("__runtime__", "work-admissions")).length, 4);
    await reconcileWaitingComputerTasks(db, computer, new WorkAdmission(db), resources);
    assert.equal((await db.list("__runtime__", "work-admissions")).length, 4);

    terminal = true;
    const receiptReader = { command: base.command } as unknown as ComputerBackend;
    const readyToCleanup = await db.get<AgentTask>("owner", "tasks", physical.id);
    assert.equal(readyToCleanup?.status, "cancelled");
    assert.equal(readyToCleanup?.state.waitingComputerCommandId, receiptId);
    assert.equal((await receiptReader.command?.("owner", receiptId))?.status, "succeeded");
    const releaseResources = resources.releaseTask.bind(resources);
    let failOnce = true;
    resources.releaseTask = async (id) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("injected cleanup failure");
      }
      return releaseResources(id);
    };
    await assert.rejects(
      reconcileWaitingComputerTasks(db, receiptReader, new WorkAdmission(db), resources),
      /injected cleanup failure/,
    );
    const interruptedCleanup = await db.get<AgentTask>("owner", "tasks", physical.id);
    assert.equal(interruptedCleanup?.state.computerCleanupPendingId, receiptId);
    assert.equal((await db.list("__runtime__", "work-admissions")).length, 4);
    resources.releaseTask = releaseResources;

    // Simulate a second process restarting after it removed the physical
    // leases but before it removed the global admission row. The durable task
    // marker must make this cleanup step safe to repeat too.
    const restartedResources = new ResourceLeases(db);
    const restartedAdmission = new WorkAdmission(db);
    const releaseHeld = restartedAdmission.releaseHeld.bind(restartedAdmission);
    let failAdmissionRelease = true;
    restartedAdmission.releaseHeld = async (taskId) => {
      if (failAdmissionRelease) {
        failAdmissionRelease = false;
        throw new Error("injected admission cleanup failure");
      }
      return releaseHeld(taskId);
    };
    await assert.rejects(
      reconcileWaitingComputerTasks(db, receiptReader, restartedAdmission, restartedResources),
      /injected admission cleanup failure/,
    );
    assert.equal((await restartedResources.listForTask(receiptId)).length, 0);
    assert.equal((await db.list("__runtime__", "work-admissions")).length, 4);
    assert.equal(
      (await db.get<AgentTask>("owner", "tasks", physical.id))?.state.computerCleanupPendingId,
      receiptId,
    );

    // A new set of services represents another process start after that
    // failure. Reconciliation completes the remaining release exactly once.
    await reconcileWaitingComputerTasks(
      db,
      receiptReader,
      new WorkAdmission(db),
      new ResourceLeases(db),
    );
    const cancelled = await db.get<AgentTask>("owner", "tasks", physical.id);
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(cancelled?.state.waitingComputerCommandId, null);
    assert.equal(cancelled?.state.computerCleanupPendingId, null);
    assert.equal((await resources.listForTask(receiptId)).length, 0);
    assert.equal((await db.list("__runtime__", "work-admissions")).length, 3);
    assert.equal(submissions, 1, "reconciliation only polls the existing command receipt");

    await restart.tick();
    assert.equal((await db.get<AgentTask>("owner", "tasks", "fifth-task"))?.status, "succeeded");
    assert.equal(continuationRuns, 1);
  } finally {
    await worker.stop().catch(() => {});
    await restart.stop();
    await agent.stop();
    await db.close();
  }
});
