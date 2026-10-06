import assert from "node:assert/strict";
import test from "node:test";
import type { ComputerBackend } from "../apps/server/src/computer-contract.ts";
import { reconcileWaitingComputerTasks } from "../apps/server/src/engine/computer-jobs.ts";
import {
  authorizeTaskEffect,
  type JournalOperation,
} from "../apps/server/src/engine/task-journal.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import { fixture, ok } from "./helpers/computer.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("confirmed failed physical receipts reconcile the blocked intention without replaying it", async (t) => {
  const f = await taskRuntime(t);
  const task = await f.agent.createTask("owner", { prompt: "Compute the published values" });
  const now = new Date().toISOString();
  const receipt = {
    id: "physical-job",
    command: "python broken.py",
    cwd: "/workspace",
    status: "failed" as const,
    exitCode: 1,
    stderr: "KeyError: 'top'",
    stdout: "",
    truncated: false,
    startedAt: now,
    completedAt: now,
    cleanupConfirmed: true,
  };
  const base = {
    taskId: task.id,
    revision: 0,
    executorId: "vps",
    executorEpoch: 1,
    resourceFence: 0,
    runToken: "old-run",
    resourceLeaseIds: [],
    createdAt: now,
    bindingHash: "a".repeat(64),
    args: { command: receipt.command },
    effect: true,
    status: "outcome_unknown" as const,
    receipt: { id: receipt.id, outcomeUnknown: true },
  };
  await f.agent.journal.prepare("owner", { ...base, id: "call", toolName: "run_computer_command" });
  await f.agent.journal.prepare("owner", {
    ...base,
    id: "primitive",
    toolName: "primitive.run_computer_command",
    parentOperationId: "call",
    physicalOperationId: receipt.id,
  });
  await f.db.put("owner", "tasks", {
    ...task,
    status: "waiting_input",
    state: {
      ...task.state,
      reconcilingOperationIds: ["call"],
      completedComputerJob: receipt,
      waitingComputerCommandId: null,
      computerCleanupPendingId: null,
    },
  });
  let polls = 0;
  await reconcileWaitingComputerTasks(
    f.db,
    {
      command: async (_owner: string, id: string) => {
        assert.equal(id, receipt.id);
        polls++;
        return receipt;
      },
      execute: async () => assert.fail("Reconciliation must not replay the failed command"),
    } as unknown as ComputerBackend,
    f.agent.workAdmission,
    f.agent.resourceLeases,
    f.agent.journal,
  );
  const records = await f.agent.journal.operations("owner", task.id);
  assert.ok(records.every((op) => op.status === "failed"));
  assert.equal(polls, 1);
});

test("a confirmed computer start completes its journal and permits the next authorized command", async (t) => {
  await modelFixture(
    t,
    (i) =>
      [
        { name: "start_computer", arguments: {} },
        {
          name: "run_computer_command",
          arguments: { command: "printf 100", operationId: "compute" },
        },
        { name: "finish_task", arguments: { summary: "The computation returned 100." } },
      ][i],
  );
  const docker = fixture({ command: async () => ok("100") });
  const f = await taskRuntime(
    t,
    {
      agentBackend: "model",
      model: "openai/fixture",
      computerEnabled: true,
    },
    { docker: docker.runner },
  );
  const task = await f.agent.createTask("owner", {
    prompt: "Start the computer and run the command printf 100. What is the output?",
  });
  await f.agent.worker.tick();
  const result = await f.agent.detail("owner", task.id);
  assert.equal(
    result.task.status,
    "succeeded",
    JSON.stringify({
      completion: result.task.completion,
      criteria: result.task.criteria,
      error: result.task.error,
    }),
  );
  const start = result.operations.find((op) => op.toolName === "start_computer");
  assert.ok(start);
  assert.equal(start.status, "succeeded");
  assert.equal((start.receipt as { computer: { status: string } }).computer.status, "running");
  const primitives = result.operations.filter((op) => op.parentOperationId === start.id);
  assert.equal(primitives.length, 1);
  assert.ok(primitives.every((op) => op.status === "succeeded"));
  const command = result.operations.find((op) => op.toolName === "run_computer_command");
  assert.ok(command);
  assert.equal(command.status, "succeeded");
  assert.equal((command.receipt as { stdout: string }).stdout, "100");
  assert.equal(docker.calls.filter((call) => call.args[0] === "exec").length, 1);
});

for (const confirmation of [
  "confirmed",
  "running",
  "failed",
  "wrong-kind",
  "unknown",
  "wrong-binding",
] as const) {
  test(`legacy computer startup reconciliation requires independent confirmation: ${confirmation}`, async (t) => {
    const f = await taskRuntime(t);
    const task = await f.agent.createTask("owner", { prompt: "Run a bounded command" });
    let effects = 0;
    const expected = confirmation === "confirmed";
    const worker = new TaskWorker(f.db, async (owner, running) => {
      const base = {
        taskId: task.id,
        revision: 0,
        executorId: "vps",
        executorEpoch: 1,
        resourceFence: 0,
        runToken: String(running.leaseId),
        resourceLeaseIds: [],
        createdAt: new Date().toISOString(),
        bindingHash: "a".repeat(64),
        args: {},
        effect: true,
      };
      const state = {
        status: "running",
        enabled: true,
        commands: [],
        ...(confirmation === "unknown" ? { outcomeUnknown: true } : {}),
      };
      const records: JournalOperation[] = [
        { ...base, id: "start", toolName: "start_computer", status: "running", receipt: state },
        {
          ...base,
          id: "primitive",
          parentOperationId: "start",
          toolName: "primitive.start_computer",
          status: "running",
          receipt: state,
          bindingHash: (confirmation === "wrong-binding" ? "b" : "a").repeat(64),
        },
        {
          ...base,
          id: "native-start",
          parentOperationId: "primitive",
          toolName: "native.session",
          args: { operation: "start" },
          nativeEnvelope: { kind: confirmation === "wrong-kind" ? "command" : "session" },
          status:
            confirmation === "running"
              ? "running"
              : confirmation === "failed"
                ? "failed"
                : "succeeded",
          receipt: {
            status:
              confirmation === "running"
                ? "running"
                : confirmation === "failed"
                  ? "failed"
                  : "succeeded",
            data: { started: true },
          },
        },
      ];
      for (const record of records) await f.agent.journal.prepare(owner, record);
      const dispatch = () =>
        f.agent.journal.run(
          owner,
          running,
          { id: "compute", name: "run_computer_command", args: { command: "printf 100" } },
          async () => {
            await authorizeTaskEffect();
            effects++;
            return { id: "command", status: "succeeded", exitCode: 0, stdout: "100" };
          },
          true,
        );
      if (expected) await dispatch();
      else await assert.rejects(dispatch, { name: "TaskOutcomeUnknownError" });
      return { status: expected ? "succeeded" : "waiting_input" };
    });
    t.after(() => worker.stop());
    await worker.tick();
    const saved = await f.agent.getTask("owner", task.id);
    assert.equal(
      effects,
      expected ? 1 : 0,
      JSON.stringify({ error: saved.error, status: saved.status }),
    );
    assert.equal(
      saved.status,
      expected ? "succeeded" : "waiting_input",
      saved.error ?? saved.question,
    );
    const operations = await f.agent.journal.operations("owner", task.id);
    for (const id of ["start", "primitive"])
      assert.equal(
        operations.find((op) => op.id === id)?.status,
        expected ? "succeeded" : "running",
      );
  });
}

for (const computerBackend of ["docker", "rpc"] as const) {
  test(`${computerBackend} configuration rejection lets research continue without uncertain dispatch`, async (t) => {
    const calls = [
      { name: "start_computer", arguments: {} },
      { name: "write_computer_file", arguments: { path: "/workspace/note.txt", text: "note" } },
      { name: "run_computer_command", arguments: { command: "pwd", operationId: "preflight" } },
      { name: "web_fetch", arguments: { url: "https://news.example/live" } },
      {
        name: "finish_task",
        arguments: {
          summary: "Count: A 52%, B 48%. Source: https://news.example/live",
          outcome: "completed",
        },
      },
    ];
    await modelFixture(t, (i) => calls[i], {
      researchReview: () => ({ complete: true, missing: [], nextSteps: [] }),
    });
    const f = await taskRuntime(t, {
      agentBackend: "model",
      model: "openai/fixture",
      computerBackend,
      // Also cover a nominally enabled RPC backend with missing credentials.
      computerEnabled: computerBackend === "rpc",
    });
    let reads = 0;
    t.mock.method(f.agent.web, "document", async (url: string) => {
      reads++;
      return { url, contentType: "text/html", body: "<main>A 52%, B 48%.</main>" };
    });
    const task = await f.agent.createTask("owner", { prompt: "What is the current count?" });
    await f.agent.worker.tick();
    const saved = await f.agent.getTask("owner", task.id);
    assert.equal(saved.status, "succeeded", saved.error ?? saved.question);
    assert.equal(saved.completion?.status, "verified");
    assert.equal(reads, 1);
    const operations = await f.agent.journal.operations("owner", task.id);
    for (const name of calls.slice(0, 3).map((call) => call.name)) {
      const rejected = operations.find((operation) => operation.toolName === name);
      assert.ok(rejected, name);
      assert.equal(rejected.status, "failed", name);
      assert.equal(rejected.dispatchedAt, undefined, name);
      assert.match(JSON.stringify(rejected.receipt), /configur/i);
      assert.equal(
        operations.some((operation) => operation.parentOperationId === rejected.id),
        false,
      );
    }
    assert.equal(
      operations.some((operation) => operation.status === "outcome_unknown"),
      false,
    );
    assert.deepEqual(await f.db.list("owner", "computer-audit"), []);
  });
}
