import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { ActionService } from "../apps/server/src/actions.ts";
import type { ComputerBackend } from "../apps/server/src/computer-contract.ts";
import { createStore } from "../apps/server/src/db.ts";
import { reconcileWaitingComputerTasks } from "../apps/server/src/engine/computer-jobs.ts";
import { AgentService } from "../apps/server/src/engine/service.ts";
import { TaskJournal } from "../apps/server/src/engine/task-journal.ts";
import { WorkAdmission } from "../apps/server/src/engine/work-admission.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { ComputerCommand } from "../packages/domain/src/computer.ts";

async function fixture(t: TestContext) {
  const db = await createStore();
  t.after(() => db.close());
  const task: AgentTask = {
    id: "background-python-task",
    title: "Wait in Python",
    prompt: "Run Python and wait",
    kind: "agent",
    status: "waiting_job",
    plan: [],
    evidence: [],
    input: {},
    state: { waitingComputerCommandId: "owned-command", computerCleanupPendingId: "owned-command" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attempts: 1,
    leaseId: null,
    leaseUntil: null,
    artifactIds: [],
  };
  await db.put("owner", "tasks", task);
  const admission = new WorkAdmission(db);
  assert.equal(await admission.claim(task.id, "background", "run"), true);
  assert.equal(await admission.hold(task.id), true);
  let command: ComputerCommand = {
    id: "owned-command",
    command: "python3 wait.py",
    cwd: "/workspace",
    status: "running",
    stdout: "",
    stderr: "",
    truncated: false,
    startedAt: task.createdAt,
  };
  let calls = 0;
  let offline = false;
  const computer = {
    command: async (owner: string, id: string) => {
      assert.equal(owner, "owner");
      assert.equal(id, command.id);
      return command;
    },
    cancel: async (owner: string, id: string) => {
      calls++;
      assert.equal(owner, "owner");
      assert.equal(id, command.id);
      assert.equal((await db.get<AgentTask>(owner, "tasks", task.id))?.status, "cancelled");
      if (offline) throw new Error("Executor unavailable after stop request");
      command = { ...command, status: "interrupted", cleanupConfirmed: true, outcomeUnknown: true };
      return command;
    },
  } as unknown as ComputerBackend;
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
  return {
    db,
    task,
    agent,
    computer,
    admission,
    calls: () => calls,
    offline: (value: boolean) => {
      offline = value;
    },
    completed: () => {
      command = { ...command, status: "succeeded", cleanupConfirmed: true };
    },
  };
}

test("cancel task stops an owned background process even when no worker turn is active", async (t) => {
  const f = await fixture(t);
  const task = await f.agent.control("owner", f.task.id, "cancel");
  assert.equal(task.status, "cancelled");
  assert.equal(f.calls(), 1, "changing the presentation status must also request physical stop");
  await reconcileWaitingComputerTasks(f.db, f.computer, f.admission);
  assert.equal((await f.db.list("__runtime__", "work-admissions")).length, 0);
  const settled = await f.db.get<AgentTask>("owner", "tasks", task.id);
  assert.equal(settled?.state.computerCancellationRequestedId, null);
  assert.equal(
    settled?.state.completedComputerJob &&
      (settled.state.completedComputerJob as ComputerCommand).status,
    "interrupted",
  );
});

test("an unavailable stop retains the request and occupancy for autonomous maintenance retry", async (t) => {
  const f = await fixture(t);
  f.offline(true);
  await f.agent.control("owner", f.task.id, "cancel");
  const pending = await f.db.get<AgentTask>("owner", "tasks", f.task.id);
  assert.equal(pending?.state.computerCancellationRequestedId, "owned-command");
  assert.equal(f.calls(), 1);
  await reconcileWaitingComputerTasks(f.db, f.computer, f.admission);
  assert.equal(
    f.calls(),
    2,
    "maintenance retries the same physical stop, never the original source",
  );
  assert.equal((await f.db.list("__runtime__", "work-admissions")).length, 1);
  f.offline(false);
  await reconcileWaitingComputerTasks(f.db, f.computer, new WorkAdmission(f.db));
  assert.equal(f.calls(), 3);
  assert.equal((await f.db.list("__runtime__", "work-admissions")).length, 0);
});

test("completed work and a foreign owner cannot trigger another physical cancellation", async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => f.agent.control("other", f.task.id, "cancel"));
  assert.equal(f.calls(), 0);
  f.completed();
  await f.agent.control("owner", f.task.id, "cancel");
  await reconcileWaitingComputerTasks(f.db, f.computer, f.admission);
  assert.equal(f.calls(), 0, "a terminal receipt wins the race with cancellation");
});

test("confirmed Python cancellation reconciles its orphaned host primitive without task selectors or rewriting native receipts", async (t) => {
  const f = await fixture(t);
  await f.db.put("owner", "tasks", {
    ...f.task,
    status: "cancelled",
    historyHiddenAt: new Date().toISOString(),
    state: {},
  });
  const primitive = {
    id: "python-primitive",
    taskId: f.task.id,
    revision: 0,
    runToken: "original-run",
    status: "dispatching",
    toolName: "primitive.execute_code",
    args: { language: "python" },
    effect: true,
    bindingHash: "original-binding",
    resourceLeaseIds: [],
    physicalOperationId: "owned-command",
    sequence: 1,
  };
  const native = {
    ...primitive,
    id: "owned-command",
    toolName: "native.command",
    nativeEnvelope: { kind: "command", capability: "python" },
    status: "outcome_unknown",
    receipt: {
      status: "outcome_unknown",
      data: { cleanupConfirmed: true, result: { status: "interrupted", state_lost: true } },
    },
  };
  await f.db.put("owner", "task-operations", primitive);
  await f.db.put("owner", "task-operations", native);
  await f.db.put("other", "task-operations", { ...primitive, id: "foreign-primitive" });
  const command = {
    id: "owned-command",
    command: "Python cell",
    cwd: "/workspace",
    status: "interrupted",
    stdout: "",
    stderr: "",
    truncated: false,
    startedAt: f.task.createdAt,
    cleanupConfirmed: true,
    outcomeUnknown: true,
  } as ComputerCommand;
  let reads = 0;
  let confirmed = false;
  const computer = {
    command: async (owner: string, id: string) => {
      reads++;
      assert.equal(owner, "owner");
      assert.equal(id, command.id);
      return confirmed ? command : { ...command, status: "running", cleanupConfirmed: false };
    },
  } as unknown as ComputerBackend;
  const journal = new TaskJournal(f.db);
  await reconcileWaitingComputerTasks(f.db, computer, f.admission, undefined, journal);
  assert.equal(
    (await f.db.get<typeof primitive>("owner", "task-operations", primitive.id))?.status,
    "dispatching",
    "a selector hint cannot replace a validated physical cleanup receipt",
  );
  confirmed = true;
  await reconcileWaitingComputerTasks(f.db, computer, f.admission, undefined, journal);
  const reconciled = await f.db.get<typeof primitive & { receipt: ComputerCommand }>(
    "owner",
    "task-operations",
    primitive.id,
  );
  assert.equal(reconciled?.status, "outcome_unknown");
  assert.equal(reconciled?.receipt.cleanupConfirmed, true);
  assert.equal(reconciled?.receipt.outcomeUnknown, true);
  assert.deepEqual(await f.db.get("owner", "task-operations", native.id), native);
  assert.deepEqual(await f.db.get("other", "task-operations", "foreign-primitive"), {
    ...primitive,
    id: "foreign-primitive",
  });
  await reconcileWaitingComputerTasks(f.db, computer, f.admission, undefined, journal);
  assert.equal(reads, 2, "settled primitives leave the recovery index; history is not re-polled");
});
