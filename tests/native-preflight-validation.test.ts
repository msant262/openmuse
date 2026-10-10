import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import test from "node:test";
import {
  authorizeTaskEffect,
  TaskOutcomeUnknownError,
} from "../apps/server/src/engine/task-journal.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import { AppError } from "../apps/server/src/errors.ts";
import { hello, registration } from "./helpers/executors.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

async function nativeRuntime(t: TestContext, pythonAvailable = true) {
  const server = await taskRuntime(t, {
    computerEnabled: true,
    computerBackend: "native",
    nativeExecutorId: registration.executorId,
    nativeExecutors: [registration],
    nativePythonEnabled: true,
    taskWorkerEnabled: false,
  });
  const { epoch } = await server.executors.register({
    ...hello,
    capabilities: [
      ...hello.capabilities,
      ...(pythonAvailable ? [{ name: "python" as const, version: 1 }] : []),
    ],
  });
  await server.executors.reconcile(registration.executorId, {
    epoch,
    bootId: hello.bootId,
    operations: [],
    contained: true,
  });
  return { ...server, epoch };
}

const input = {
  sessionId: "preflight-conversation",
  code: "print(42)",
  tools: [],
  reset: false,
  wallClockMs: 3000,
  maxToolCalls: 100,
};

for (const scenario of [
  "python-unavailable",
  "python-invalid-budget",
  "command-timeout",
  "command-path",
  "media-timeout",
  "file-path",
  "file-size",
  "attachment-size",
  "pdf-format",
  "search-parameters",
] as const) {
  test(`native preflight ${scenario} settles its exact undispatched primitive and permits the next effect`, async (t) => {
    const server = await nativeRuntime(t, scenario !== "python-unavailable");
    const task = await server.agent.createTask("owner", {
      prompt: "Perform the calculation and save its result",
    });
    let observed = false;
    const worker = new TaskWorker(
      server.db,
      async (owner, running) => {
        const computer = server.computer;
        const execute = async () => {
          if (scenario.startsWith("python-")) {
            assert.ok(computer.python);
            return computer.python(
              owner,
              { ...input, maxToolCalls: scenario === "python-invalid-budget" ? 0 : 100 },
              {
                idempotencyKey: scenario,
                shouldContinue: () => true,
                call: async () => assert.fail("rejected source cannot call a host tool"),
              },
            );
          }
          if (scenario === "command-timeout" || scenario === "command-path")
            return computer.execute(
              owner,
              {
                command: "printf 42",
                cwd: scenario === "command-path" ? "/etc" : "/workspace",
                timeoutMs: scenario === "command-timeout" ? 1800001 : 3000,
              },
              { idempotencyKey: scenario },
            );
          if (scenario === "media-timeout") {
            assert.ok(computer.media);
            return computer.media(
              owner,
              "preview",
              { path: "/workspace/input.pdf", timeoutMs: 1800001 },
              { idempotencyKey: scenario },
            );
          }
          if (scenario === "file-path") return computer.mkdir(owner, "/etc/new-directory");
          if (scenario === "file-size")
            return computer.write(owner, "/workspace/file.txt", "x".repeat(262145));
          if (scenario === "attachment-size")
            return computer.writeBytes(
              owner,
              "/workspace/file.bin",
              new Uint8Array(25 * 1024 ** 2 + 1),
            );
          if (scenario === "pdf-format")
            return computer.writePdf(owner, "/workspace/file.pdf", new Uint8Array([1, 2, 3]));
          assert.ok(computer.search);
          return computer.search(owner, "/workspace", {
            pattern: "report",
            target: "content",
            limit: 0,
          } as never);
        };
        await assert.rejects(
          server.agent.journal.run(
            owner,
            running,
            { id: scenario, name: "native_preflight_fixture", args: { scenario } },
            execute,
            true,
          ),
        );
        const operations = await server.agent.journal.operations(owner, task.id);
        assert.equal(operations.length, 2);
        assert.ok(
          operations.every((op) => op.status === "rejected_not_dispatched"),
          JSON.stringify(operations.map(({ toolName, status }) => ({ toolName, status }))),
        );
        assert.ok(operations.every((op) => !op.nativeEnvelope));
        assert.ok(
          operations.every((op) => (op.receipt as { dispatched?: boolean }).dispatched === false),
        );
        assert.equal((await server.executors.deliveries(owner, registration.executorId)).length, 0);
        assert.equal(
          (await server.agent.resourceLeases.listForTask(operations[1].resourceHoldTaskId ?? ""))
            .length,
          0,
        );
        let next = false;
        await server.agent.journal.run(
          owner,
          running,
          { id: `${scenario}:next`, name: "next_effect_fixture", args: {} },
          async () => {
            await authorizeTaskEffect();
            next = true;
            return { checked: true };
          },
          true,
        );
        assert.equal(next, true, "a rejected preparation must not fence later work");
        observed = true;
        return { status: "succeeded" };
      },
      { workAdmission: server.agent.workAdmission },
    );
    t.after(() => worker.stop());
    await worker.tick();
    assert.ok(observed, JSON.stringify(await server.agent.getTask("owner", task.id)));
  });
}

test("a failure after original native enqueue remains uncertain and blocks another effect", async (t) => {
  const server = await nativeRuntime(t);
  const enqueue = server.executors.enqueue.bind(server.executors);
  t.mock.method(server.executors, "enqueue", async (...args: Parameters<typeof enqueue>) => {
    await enqueue(...args);
    throw new AppError("Lost acknowledgement after native publication", 503);
  });
  const task = await server.agent.createTask("owner", { prompt: "Execute one command" });
  let observed = false;
  const worker = new TaskWorker(
    server.db,
    async (owner, running) => {
      await assert.rejects(
        server.agent.journal.run(
          owner,
          running,
          { id: "after-enqueue", name: "run_computer_command", args: { command: "printf 42" } },
          () =>
            server.computer.execute(
              owner,
              { command: "printf 42", cwd: "/workspace", background: true, timeoutMs: 3000 },
              { idempotencyKey: "after-enqueue" },
            ),
          true,
        ),
        /Lost acknowledgement/,
      );
      const operations = await server.agent.journal.operations(owner, task.id);
      const native = operations.find((op) => op.nativeEnvelope);
      assert.ok(native, "the original registry really published a native envelope");
      assert.equal((await server.executors.deliveries(owner, registration.executorId)).length, 1);
      assert.equal(operations.find((op) => !op.parentOperationId)?.status, "outcome_unknown");
      assert.ok(operations.every((op) => op.status !== "rejected_not_dispatched"));
      assert.ok((await server.agent.resourceLeases.listForTask(native.id)).length > 0);
      await assert.rejects(
        server.agent.journal.run(
          owner,
          running,
          { id: "after-enqueue:next", name: "next_effect_fixture", args: {} },
          async () => assert.fail("uncertain native work must fence the next effect"),
          true,
        ),
        TaskOutcomeUnknownError,
      );
      observed = true;
      return { status: "waiting_job" };
    },
    { workAdmission: server.agent.workAdmission },
  );
  t.after(() => worker.stop());
  await worker.tick();
  assert.ok(observed, JSON.stringify(await server.agent.getTask("owner", task.id)));
});
