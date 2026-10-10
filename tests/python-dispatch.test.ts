import assert from "node:assert/strict";
import test from "node:test";
import { withNativePythonHostCall } from "../apps/server/src/engine/python-call-scope.ts";
import {
  authorizeTaskEffect,
  TaskOutcomeUnknownError,
} from "../apps/server/src/engine/task-journal.ts";
import type { ExecutorOperation } from "../apps/server/src/executors/protocol.ts";
import { dispatchPythonRequests } from "../apps/server/src/executors/python-dispatch.ts";
import { pythonHostCallId, pythonRpcWire } from "../apps/server/src/executors/python-protocol.ts";
import { consumePythonReply } from "../apps/server/src/executors/python-replies.ts";
import { RemoteComputerBackend } from "../apps/server/src/executors/remote-computer.ts";
import { pythonRuntime } from "./helpers/python-runtime.ts";

const result = {
  status: "ok",
  reused: false,
  state_reset: false,
  state_lost: false,
  cleanup_confirmed: false,
  stdout: "42\n",
  stderr: "",
  duration_seconds: 0.01,
  host_call_pending: false,
  tool_calls: [],
};

test("the RPC driver uses ordinary task dispatch once and delivers the complete result by a claimed private control", async (t) => {
  await pythonRuntime(t, async ({ server, registry, task, operation, rpc }) => {
    await rpc("write_sample", { text: "owned" });
    let calls = 0;
    const pending = dispatchPythonRequests(
      registry,
      "owner",
      operation,
      {
        shouldContinue: () => true,
        call: (parent, request) =>
          withNativePythonHostCall(
            server.agent.journal,
            "owner",
            parent,
            pythonRpcWire(request),
            () =>
              server.agent.journal.run(
                "owner",
                task,
                {
                  id: "driver:write",
                  toolCallId: pythonHostCallId(parent.id, request),
                  name: request.name,
                  args: request.args,
                },
                async () => {
                  await authorizeTaskEffect();
                  calls++;
                  return { values: Array.from({ length: 20_000 }, (_, n) => n) };
                },
                true,
              ),
          ),
      },
      1,
    );
    let control: ExecutorOperation | undefined;
    for (let n = 0; n < 100 && !control; n++) {
      control = (await registry.claimOperations(operation.executorId, operation.executorEpoch))
        .operations[0];
      if (!control) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(control, "host reply must become a claimed native control");
    const payload = await consumePythonReply(
      registry,
      operation.executorId,
      String(control.args.replyReference),
      {
        epoch: operation.executorEpoch,
        operationId: control.id,
        parentOperationId: operation.id,
        requestSequence: 1,
      },
    );
    assert.equal(JSON.parse(payload.json).result.values.length, 20_000);
    await registry.submitReceipt(operation.executorId, operation.executorEpoch, control.id, 1, {
      status: "succeeded",
      data: { replyAccepted: true, continue: true },
    });
    // A waiting cell's unchanged RPC frame is not another host call.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1);
    await registry.submitReceipt(operation.executorId, operation.executorEpoch, operation.id, 2, {
      status: "succeeded",
      data: { result, cellSettled: true, cleanupConfirmed: false },
    });
    assert.equal((await pending).status, "succeeded");
    const backend = new RemoteComputerBackend(registry, {
      executorId: operation.executorId,
      pythonEnabled: true,
    });
    const observed = await backend.command("owner", operation.id);
    assert.equal(observed.status, "succeeded");
    assert.equal(observed.stdout, "42\n");
    assert.equal(observed.stderr, "");
    assert.equal(
      observed.cleanupConfirmed,
      false,
      "the idle persistent process remains physically budgeted",
    );
    assert.equal(await backend.pythonAvailable("owner"), true);
    assert.equal(
      await new RemoteComputerBackend(registry, {
        executorId: operation.executorId,
      }).pythonAvailable("owner"),
      false,
    );
  });
});

test("a host pause returns its real review receipt, forbids further callbacks and permits no false successful command", async (t) => {
  await pythonRuntime(t, async ({ registry, operation, rpc }) => {
    await rpc("write_sample", {});
    let proceed = true,
      calls = 0;
    const pending = dispatchPythonRequests(
      registry,
      "owner",
      operation,
      {
        shouldContinue: () => proceed,
        call: async () => {
          calls++;
          proceed = false;
          return { paused: true, actionId: "owned-review" };
        },
      },
      1,
    );
    let control: ExecutorOperation | undefined;
    for (let n = 0; n < 100 && !control; n++) {
      control = (await registry.claimOperations(operation.executorId, operation.executorEpoch))
        .operations[0];
      if (!control) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(control);
    const payload = await consumePythonReply(
      registry,
      operation.executorId,
      String(control.args.replyReference),
      {
        epoch: operation.executorEpoch,
        operationId: control.id,
        parentOperationId: operation.id,
        requestSequence: 1,
      },
    );
    assert.deepEqual(JSON.parse(payload.json), {
      result: { paused: true, actionId: "owned-review" },
      continue: false,
    });
    await registry.submitReceipt(operation.executorId, operation.executorEpoch, control.id, 1, {
      status: "succeeded",
      data: { replyAccepted: true, continue: false },
    });
    await registry.submitReceipt(operation.executorId, operation.executorEpoch, operation.id, 2, {
      status: "failed",
      data: {
        result: { ...result, status: "paused", state_lost: true, cleanup_confirmed: true },
        cellSettled: true,
        cleanupConfirmed: true,
      },
    });
    assert.equal((await pending).status, "failed");
    const backend = new RemoteComputerBackend(registry, {
      executorId: operation.executorId,
      pythonEnabled: true,
    });
    assert.equal((await backend.command("owner", operation.id)).status, "failed");
    assert.equal(calls, 1);
  });
});

test("Python success requires an observed settled interpreter result", async (t) => {
  await pythonRuntime(t, async ({ registry, operation }) => {
    await registry.submitReceipt(operation.executorId, operation.executorEpoch, operation.id, 1, {
      status: "succeeded",
      data: {},
    });
    const backend = new RemoteComputerBackend(registry, { executorId: operation.executorId });
    await assert.rejects(backend.command("owner", operation.id), /malformed/i);
  });
});

test("fresh Python source cannot bypass another running or uncertain effect in the same task", async (t) => {
  await pythonRuntime(t, async ({ registry, operation, context }) => {
    const next = {
      id: "second-cell",
      executorId: operation.executorId,
      kind: "command" as const,
      capability: "python" as const,
      capabilityVersion: 1,
      args: operation.args,
      inspection: false,
    };
    await assert.rejects(registry.enqueue("owner", next, context), TaskOutcomeUnknownError);
    await registry.submitReceipt(operation.executorId, operation.executorEpoch, operation.id, 1, {
      status: "outcome_unknown",
      data: { cellSettled: true, cleanupConfirmed: true },
    });
    await assert.rejects(registry.enqueue("owner", next, context), TaskOutcomeUnknownError);
    assert.equal(await registry.delivery("owner", next.id), null);
  });
});
