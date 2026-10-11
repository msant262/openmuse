import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import type { ComputerBackend } from "../apps/server/src/computer-contract.ts";
import { computerTools } from "../apps/server/src/computer-tools.ts";
import { reconcileWaitingComputerTasks } from "../apps/server/src/engine/computer-jobs.ts";
import { KanbanWorkflow } from "../apps/server/src/engine/kanban-workflow.ts";
import {
  physicalRuntimeMs,
  taskRuntimeLimit,
} from "../apps/server/src/engine/task-runtime-deadline.ts";
import { WorkAdmission } from "../apps/server/src/engine/work-admission.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import type { ComputerCommand } from "../packages/domain/src/computer.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("declared card runtime is dispatched atomically without an automatic default ceiling", async (t) => {
  const f = await taskRuntime(t);
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 0,
    requestId: "enable",
    profile: { toolsets: ["kanban"], maxRuntimeSeconds: 300 },
  });
  const board = new KanbanWorkflow(f.db, "owner", "default", {
    profileExists: (name) => f.agent.executionProfiles.exists("owner", name),
  });
  for (const [key, seconds] of [
    ["explicit", 120],
    ["profile", undefined],
  ] as const) {
    const created = await board.create(
      { role: "orchestrator", profile: "default" },
      { title: key, assignee: "default", maxRuntimeSeconds: seconds },
      `create:${key}`,
    );
    const task = await f.agent.dispatchKanbanCard(
      "owner",
      "default",
      created.id,
      "default",
      `dispatch:${key}`,
    );
    const binding = await f.db.get<{
      configuration: { runtime?: { maxMilliseconds: number; deadlineAt: number } };
    }>("owner", "kanban-executions", task.id);
    assert.equal(binding?.configuration.runtime?.maxMilliseconds, (seconds ?? 300) * 1000);
    assert.ok((binding?.configuration.runtime?.deadlineAt ?? 0) > Date.now());
    assert.equal(
      (
        await f.agent.dispatchKanbanCard(
          "owner",
          "default",
          created.id,
          "default",
          `dispatch:${key}`,
        )
      ).id,
      task.id,
    );
  }
  const ordinary = await f.agent.createTask("owner", { prompt: "Explain organizing a day." });
  assert.equal(await f.db.get("owner", "kanban-executions", ordinary.id), null);
  await f.agent.executionProfiles.set("owner", "default", {
    expectedRevision: 1,
    requestId: "unlimited",
    profile: { toolsets: ["kanban"] },
  });
  const unlimitedCard = await board.create(
    { role: "orchestrator", profile: "default" },
    { title: "Unbounded", assignee: "default" },
    "create:unlimited",
  );
  const unlimited = await f.agent.dispatchKanbanCard(
    "owner",
    "default",
    unlimitedCard.id,
    "default",
    "dispatch:unlimited",
  );
  const unlimitedBinding = await f.db.get<{ configuration: { runtime?: unknown } }>(
    "owner",
    "kanban-executions",
    unlimited.id,
  );
  assert.equal(unlimitedBinding?.configuration.runtime, undefined);
});

test("physical commands receive remaining time before dispatch and refuse a timeout below their protocol minimum", async (t) => {
  const f = await taskRuntime(t);
  let remaining: number | undefined = 2500;
  const calls: number[] = [];
  const computer = {
    execute: async (_owner: string, args: { timeoutMs: number }) => {
      calls.push(args.timeoutMs);
      return { status: "succeeded" };
    },
  } as unknown as ComputerBackend;
  const command = computerTools(computer, f.agent.files, "owner", "task:runtime", {
    remainingRuntimeMs: () => remaining,
  }).find((tool) => tool.name === "run_computer_command");
  assert.ok(command?.execute);
  const invoke = () =>
    command.execute!({ command: "true", operationId: "bounded", timeoutMs: 10000 } as never);
  await invoke();
  assert.deepEqual(calls, [2500]);
  remaining = 500;
  await assert.rejects(invoke, /tempo restante/i);
  assert.deepEqual(calls, [2500]);
  remaining = undefined;
  await invoke();
  assert.deepEqual(calls, [2500, 10000]);
  assert.equal(
    physicalRuntimeMs(900000, 17),
    17,
    "Python's native millisecond timeout is bound before its cell intent",
  );
  assert.equal(taskRuntimeLimit(undefined), undefined);
  assert.throws(() => taskRuntimeLimit(Number.MAX_SAFE_INTEGER), /represented exactly/);
  assert.ok(taskRuntimeLimit(86400 * 365));
});

test("deadline aborts a foreground physical process and does not replay the task", async (t) => {
  const f = await taskRuntime(t);
  const task = await f.agent.createTask("owner", { prompt: "Wait for a local QA process." });
  let calls = 0;
  let pid: number | undefined;
  const worker = new TaskWorker(
    f.db,
    async (_owner, _task, ctx) => {
      calls++;
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      pid = child.pid;
      const closed = once(child, "close");
      const stop = () => child.kill("SIGTERM");
      ctx.signal.addEventListener("abort", stop, { once: true });
      if (ctx.signal.aborted) stop();
      try {
        await closed;
      } finally {
        ctx.signal.removeEventListener("abort", stop);
      }
      ctx.signal.throwIfAborted();
      return { status: "succeeded" };
    },
    { runtimeLimit: async () => ({ maxMilliseconds: 400, deadlineAt: Date.now() + 400 }) },
  );
  t.after(() => worker.stop());
  await worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "failed");
  assert.equal(saved.state.runtimeExpired, true);
  assert.match(saved.error ?? "", /tempo|time/i);
  assert.ok(pid);
  assert.throws(() => process.kill(pid!, 0), /ESRCH/);
  await worker.tick();
  assert.equal(calls, 1);
});

test("background deadline survives worker restart and cancels only the same owned job", async (t) => {
  const f = await taskRuntime(t);
  let now = Date.now();
  const deadlineAt = now + 2000;
  const task = await f.agent.createTask("owner", { prompt: "Process a QA file." });
  const admission = new WorkAdmission(f.db);
  let executions = 0;
  const first = new TaskWorker(
    f.db,
    async () => {
      executions++;
      return {
        status: "waiting_job",
        nextRunAt: new Date(now + 1000).toISOString(),
        state: { waitingComputerCommandId: "owned-job" },
      };
    },
    {
      now: () => now,
      workAdmission: admission,
      runtimeLimit: async () => ({ maxMilliseconds: 2000, deadlineAt }),
    },
  );
  await first.tick();
  await first.stop();
  now += 3000;
  const restarted = new TaskWorker(
    f.db,
    async () => {
      executions++;
      return { status: "succeeded" };
    },
    {
      now: () => now,
      workAdmission: new WorkAdmission(f.db),
      runtimeLimit: async () => ({ maxMilliseconds: 2000, deadlineAt }),
    },
  );
  t.after(() => restarted.stop());
  await restarted.tick();
  const expired = await f.agent.getTask("owner", task.id);
  assert.equal(expired.status, "failed");
  assert.equal(expired.state.computerCancellationRequestedId, "owned-job");
  assert.equal(executions, 1, "a poll lease is not a new canonical attempt");
  let offline = true;
  const stops: string[] = [];
  let receipt: ComputerCommand = {
    id: "owned-job",
    command: "QA",
    cwd: "/workspace",
    status: "running",
    stdout: "",
    stderr: "",
    truncated: false,
    startedAt: task.createdAt,
  };
  const computer = {
    command: async (owner: string, id: string) => {
      assert.equal(owner, "owner");
      assert.equal(id, "owned-job");
      return receipt;
    },
    cancel: async (_owner: string, id: string) => {
      stops.push(id);
      if (offline) throw new Error("Disconnected");
      receipt = { ...receipt, status: "interrupted", cleanupConfirmed: true, outcomeUnknown: true };
      return receipt;
    },
  } as unknown as ComputerBackend;
  await reconcileWaitingComputerTasks(f.db, computer, admission);
  assert.equal((await f.db.list("__runtime__", "work-admissions")).length, 1);
  offline = false;
  await reconcileWaitingComputerTasks(f.db, computer, admission);
  assert.deepEqual(stops, ["owned-job", "owned-job"]);
  assert.equal((await f.db.list("__runtime__", "work-admissions")).length, 0);
  assert.equal((await f.agent.getTask("owner", task.id)).state.runtimeExpired, true);
});

test("an expired runtime cannot change a task claimed by another worker", async (t) => {
  const f = await taskRuntime(t);
  const task = await f.agent.createTask("owner", { prompt: "QA ownership." });
  const worker = new TaskWorker(
    f.db,
    async (_owner, current, ctx) => {
      await f.db.compareAndSwapTask(
        "owner",
        current.id,
        { leaseId: current.leaseId },
        { leaseId: "replacement", status: "running" },
      );
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      ctx.signal.throwIfAborted();
      return { status: "succeeded" };
    },
    { runtimeLimit: async () => ({ maxMilliseconds: 200, deadlineAt: Date.now() + 200 }) },
  );
  t.after(() => worker.stop());
  await worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "running");
  assert.equal(saved.leaseId, "replacement");
  assert.equal(saved.state.runtimeExpired, undefined);
});
