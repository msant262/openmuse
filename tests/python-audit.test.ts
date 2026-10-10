import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ActionLog } from "../apps/server/src/action-log.ts";
import {
  auditedComputer,
  currentComputerResourceScope,
} from "../apps/server/src/audited-computer.ts";
import type { ComputerBackend } from "../apps/server/src/computer-contract.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ResourceLeases } from "../apps/server/src/engine/resource-leases.ts";
import { pythonResourceKey } from "../apps/server/src/executors/python-protocol.ts";

test("Python audit holds its conversation lease while a nested native command can acquire the heavy lease", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const resources = new ResourceLeases(db);
  let calls = 0;
  // Receipt fixture verifies the shared audit/admission boundary. Physical
  // interpreter RAM and process cleanup are verified by the native suite.
  const backend = {
    pythonAvailable: async () => true,
    pythonResourceKey: (owner: string, sessionId: string) =>
      pythonResourceKey("node", owner, sessionId),
    python: async (owner, _input, options) => {
      calls++;
      const scope = currentComputerResourceScope(owner);
      assert.ok(scope);
      const held = await Promise.all(
        scope.leases.map((lease) =>
          db.get<{ request: { key: string; mode: string } }>(
            "__runtime__",
            "resource-leases",
            lease.id,
          ),
        ),
      );
      assert.deepEqual(
        held.map((lease) => lease?.request.key).sort(),
        [pythonResourceKey("node", owner, "conversation"), "system-admin:host"].sort(),
      );
      const nested = await resources.acquire(owner, "nested-command", [
        { key: "cpu-heavy:host", mode: "exclusive", units: 1 },
        { key: "system-admin:host", mode: "shared", units: 1 },
      ]);
      assert.ok(nested, "the waiting cell must not hold the nested command's heavy lease");
      await Promise.all(nested.map((lease) => resources.release(lease)));
      assert.equal(options.shouldContinue(), true);
      const id = createHash("sha256").update(`${owner}:${options.idempotencyKey}`).digest("hex");
      await options.onDispatch?.(id);
      const command = {
        id,
        command: "Python cell",
        cwd: "/workspace",
        status: "succeeded" as const,
        stdout: "42\n",
        stderr: "",
        truncated: false,
        startedAt: new Date().toISOString(),
        cleanupConfirmed: false,
      };
      await db.put(owner, "computer-commands", command);
      return { command };
    },
  } as Pick<ComputerBackend, "python" | "pythonResourceKey" | "pythonAvailable">;
  const computer = auditedComputer(
    backend as ComputerBackend,
    new ActionLog(db),
    "native",
    resources,
    "host",
  );
  assert.ok(computer.python);
  const execution = await computer.python(
    "owner",
    {
      sessionId: "conversation",
      code: "print(42)",
      reset: false,
      tools: [],
      wallClockMs: 3000,
      maxToolCalls: 100,
    },
    {
      idempotencyKey: "owned-python-audit",
      call: async () => assert.fail("this cell has no host calls"),
      shouldContinue: () => true,
    },
  );
  assert.equal(calls, 1);
  assert.equal(execution.command.cleanupConfirmed, false);
  assert.equal(
    (await resources.listForTask(execution.command.id)).length,
    0,
    "a settled cell releases its logical leases; native idle RAM remains a separate reservation",
  );
});
