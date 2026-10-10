import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { ActionLog } from "../apps/server/src/action-log.ts";
import {
  auditedComputer,
  currentComputerResourceScope,
} from "../apps/server/src/audited-computer.ts";
import { computerTools } from "../apps/server/src/computer-tools.ts";
import { withNativePythonHostCall } from "../apps/server/src/engine/python-call-scope.ts";
import { currentExecutorContext } from "../apps/server/src/engine/task-executor-authority.ts";
import { taskCriteria } from "../apps/server/src/engine/task-verification.ts";
import type { ExecutorOperation } from "../apps/server/src/executors/protocol.ts";
import { dispatchPythonRequests } from "../apps/server/src/executors/python-dispatch.ts";
import { pythonHostCallId, pythonRpcWire } from "../apps/server/src/executors/python-protocol.ts";
import type { ExecutorRegistry } from "../apps/server/src/executors/registry.ts";
import { RemoteComputerBackend } from "../apps/server/src/executors/remote-computer.ts";
import { executorRoutes } from "../apps/server/src/executors/routes.ts";
import { nodeToken } from "./helpers/executors.ts";
import { pythonRuntime } from "./helpers/python-runtime.ts";

/** Actual API/native protocol and interpreter integration. OS launch is local
 * by default; opt-in staged QA uses the registered native user/systemd units.
 * Provider/review values remain fixtures. Natural model selection and actual
 * user reviews are separate acceptance checks. No protocol receipts are faked. */
async function peer(registry: ExecutorRegistry, operation: ExecutorOperation) {
  const directory = await mkdtemp(join(tmpdir(), "okami-python-native-peer-"));
  const staged = process.env.OKAMI_PYTHON_NATIVE_QA_SOURCE_PATH;
  if (staged) assert.match(staged, /^\/opt\/okami-python-integration-[a-f0-9]{12}$/);
  const child = spawn(
    staged ? "sudo" : "python3",
    staged
      ? [
          "-n",
          "ssh",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=8",
          "-o",
          "StrictHostKeyChecking=yes",
          "lenovo-okami-bot",
          "sudo",
          "-n",
          "python3",
          `${staged}/python-native-peer.py`,
          `/var/lib/okami-executor/python-integration-qa/${randomUUID()}`,
          "--registered",
        ]
      : ["tests/helpers/python-native-peer.py", directory],
    {
      env: { PATH: process.env.PATH, PYTHONPATH: resolve("apps/computer"), LANG: "C.UTF-8" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const routes = executorRoutes(registry);
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let stopped = false;
  let failure: Error | undefined;
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += String(data).slice(0, 2000);
  });
  const exited = new Promise<void>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolveExit() : reject(new Error(`Native test peer exited ${code}: ${stderr}`)),
    );
  });
  // Observe early exit while the ready/command promise is still pending.
  void exited.catch((error) => {
    failure = error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  let readyResolve!: () => void;
  const ready = new Promise<void>((resolveReady) => {
    readyResolve = resolveReady;
  });
  const post = async (route: string, body: unknown) => {
    const response = await routes.request(`/${operation.executorId}/${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${nodeToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  let receipts = Promise.resolve();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.kind === "ready") readyResolve();
    else if (message.kind === "result") {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error));
      else waiter?.resolve(message.value);
    } else if (message.kind === "receipt") {
      receipts = receipts
        .then(async () => {
          await post("receipt", {
            epoch: operation.executorEpoch,
            operationId: message.operationId,
            sequence: message.sequence,
            receipt: message.receipt,
          });
          send({ kind: "ack", operationId: message.operationId, sequence: message.sequence });
        })
        .catch((error) => {
          failure = error;
        });
    } else if (message.kind === "http") {
      void post(message.route, message.body).then(
        (value) => send({ kind: "http-result", id: message.id, value }),
        (error) => {
          failure = error;
          send({ kind: "http-result", id: message.id, error: String(error) });
        },
      );
    }
  });
  const command = (input: Record<string, unknown>) =>
    new Promise<unknown>((resolveCommand, reject) => {
      if (failure) {
        reject(failure);
        return;
      }
      const id = randomUUID();
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Native test peer command timed out"));
      }, 25_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolveCommand(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      send({ ...input, id });
    });
  await Promise.race([
    ready,
    exited.then(() => {
      throw new Error("Native test peer exited before ready");
    }),
  ]);
  const lease = (await post("claim", { epoch: operation.executorEpoch, waitMs: 0 })) as {
    epoch: number;
    pause: unknown;
    operations: ExecutorOperation[];
  };
  assert.equal(
    lease.operations.length,
    0,
    "the initial cell was already claimed by actual task authority",
  );
  await command({
    kind: "lease",
    epoch: lease.epoch,
    pause: lease.pause,
    watchdogMs: registry.watchdogMs,
  });
  const pumping = (async () => {
    while (!stopped) {
      const claimed = (await post("claim", { epoch: operation.executorEpoch, waitMs: 0 })) as {
        operations: ExecutorOperation[];
      };
      for (const next of claimed.operations) await command({ kind: "operation", operation: next });
      await new Promise((done) => setTimeout(done, 5));
    }
  })().catch((error) => {
    failure = error;
  });
  return {
    command,
    start: () => command({ kind: "operation", operation }),
    async close() {
      stopped = true;
      await pumping;
      send({ kind: "close" });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        await exited;
        await receipts;
      } finally {
        clearTimeout(timeout);
        lines.close();
        await rm(directory, { recursive: true, force: true });
      }
      if (failure) throw failure;
    },
  };
}

test("real native Python RPC uses canonical host dispatch and exports a real owned attachment", {
  timeout: 45_000,
}, async (t) => {
  await pythonRuntime(
    t,
    async ({ server, registry, task, operation }) => {
      const native = await peer(registry, operation);
      try {
        const backend = new RemoteComputerBackend(registry, {
          executorId: operation.executorId,
          pythonEnabled: true,
          pollMs: 5,
          context: (owner, id) =>
            currentExecutorContext(owner, id, undefined, currentComputerResourceScope(owner)),
        });
        const computer = auditedComputer(
          backend,
          new ActionLog(server.db),
          "native",
          server.agent.resourceLeases,
          "lenovo",
        );
        const attachments: string[] = [];
        const exportTool = computerTools(computer, server.files, "owner", "native-python-file", {
          artifact: async (id) => {
            attachments.push(id);
          },
        }).find((tool) => tool.name === "export_computer_file");
        assert.ok(exportTool?.execute);
        const calls: string[] = [];
        const driven = dispatchPythonRequests(
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
                      id: `actual-native:${pythonHostCallId(parent.id, request)}`,
                      toolCallId: pythonHostCallId(parent.id, request),
                      name: request.name,
                      args: request.args,
                    },
                    async () => {
                      calls.push(request.name);
                      if (request.name === "read_sample")
                        return { values: Array.from({ length: 20_000 }, (_, n) => n) };
                      assert.equal(request.name, "export_computer_file");
                      return (exportTool.execute as (args: unknown) => Promise<unknown>)(
                        request.args,
                      );
                    },
                    request.name === "export_computer_file",
                  ),
              ),
          },
          5,
        );
        await native.start();
        const observed = await driven;
        assert.equal(observed.status, "succeeded", JSON.stringify(observed));
        assert.deepEqual(calls, ["read_sample", "export_computer_file"]);
        assert.equal(attachments.length, 1);
        assert.equal(
          Buffer.from(await server.files.bytes("owner", attachments[0])).toString(),
          "199990000",
        );
        const result = observed.data?.result as { stdout_spill_path: string };
        assert.equal(
          (await backend.command("owner", operation.id)).stdout.split("\n")[0],
          attachments[0],
        );
        const spillPath = `/workspace/${result.stdout_spill_path.split("/").slice(-2).join("/")}`;
        await server.agent.journal.run(
          "owner",
          task,
          {
            id: "actual-native:export-long-output",
            name: "export_computer_file",
            args: { path: spillPath },
          },
          () => (exportTool.execute as (args: unknown) => Promise<unknown>)({ path: spillPath }),
          true,
        );
        assert.equal(attachments.length, 2);
        const fullOutput = Buffer.from(
          await server.files.bytes("owner", attachments[1]),
        ).toString();
        assert.equal(fullOutput, `${attachments[0]}\n${"á".repeat(100_000)}\n`);
        if (process.env.OKAMI_PYTHON_NATIVE_QA_SOURCE_PATH) {
          const units = (await native.command({ kind: "units" })) as Array<{
            memoryBytes: number;
            properties: Record<string, string>;
            reservation: { bytes: number };
          }>;
          assert.equal(units.length, 1);
          assert.equal(units[0].memoryBytes, 512 * 1024 ** 2);
          assert.equal(units[0].reservation.bytes, 512 * 1024 ** 2);
          assert.equal(units[0].properties.User, "okami-bot");
          assert.equal(units[0].properties.Group, "1004");
          assert.equal(units[0].properties.MemoryMax, "536870912");
          assert.equal(units[0].properties.KillMode, "control-group");
          assert.equal(units[0].properties.ActiveState, "active");
          assert.ok(
            units[0].properties.BindsTo.split(" ").includes("okami-executor@lenovo-okami.service"),
          );
          assert.match(units[0].properties.ControlGroup, /okami-bots-u1003\.slice\/okami-python-/);
        }
        assert.deepEqual(await native.command({ kind: "operation", operation }), {
          replayed: true,
        });
        assert.deepEqual(await native.command({ kind: "inspect", path: "report.txt" }), {
          exists: true,
          children: 1,
        });
        assert.deepEqual(
          calls,
          ["read_sample", "export_computer_file"],
          "delivery replay must not repeat host effects",
        );
        await assert.rejects(() => server.files.bytes("other-owner", attachments[0]));
      } finally {
        await native.close();
      }
    },
    ["read_sample", "export_computer_file"],
    {
      timeoutMs: 15_000,
      code: "from hermes_tools import read_sample, export_computer_file\nfrom pathlib import Path\nvalues = read_sample({'query': 'owned numbers'})['values']\nPath('report.txt').write_text(str(sum(values)))\nattached = export_computer_file({'path': 'report.txt'})\nprint(attached['fileId'])\nprint('á' * 100000)",
    },
  );
});

test("real native Python stops before later source when the original host dispatcher pauses for review", {
  timeout: 45_000,
}, async (t) => {
  await pythonRuntime(
    t,
    async ({ server, registry, task, operation }) => {
      const native = await peer(registry, operation);
      let proceed = true;
      const calls: string[] = [];
      try {
        const driven = dispatchPythonRequests(
          registry,
          "owner",
          operation,
          {
            shouldContinue: () => proceed,
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
                      id: `review-native:${pythonHostCallId(parent.id, request)}`,
                      toolCallId: pythonHostCallId(parent.id, request),
                      name: request.name,
                      args: request.args,
                    },
                    async () => {
                      calls.push(request.name);
                      proceed = false;
                      return { approvalRequired: true, actionId: "test-owned-review" };
                    },
                    true,
                  ),
              ),
          },
          5,
        );
        await native.start();
        const observed = await driven;
        assert.equal(observed.status, "failed", JSON.stringify(observed));
        assert.equal(observed.data?.stoppedByHost, true);
        assert.equal(observed.data?.cleanupConfirmed, true);
        assert.deepEqual(calls, ["write_sample"]);
        assert.deepEqual(await native.command({ kind: "inspect", path: "after-review.txt" }), {
          exists: false,
          children: 1,
        });
      } finally {
        await native.close();
      }
    },
    ["write_sample"],
    {
      timeoutMs: 15_000,
      code: "from hermes_tools import write_sample\nfrom pathlib import Path\nwrite_sample({'target': 'owned fictional item'})\nPath('after-review.txt').write_text('must not execute')\nwrite_sample({'target': 'second effect'})",
    },
  );
});

test("an API-owned cancellation stops the actual Python process and retains the interrupted outcome", {
  timeout: 45_000,
}, async (t) => {
  await pythonRuntime(
    t,
    async ({ registry, operation, context }) => {
      const native = await peer(registry, operation);
      try {
        const backend = new RemoteComputerBackend(registry, {
          executorId: operation.executorId,
          pythonEnabled: true,
          pollMs: 5,
          context: async () => context,
        });
        const driven = dispatchPythonRequests(
          registry,
          "owner",
          operation,
          {
            shouldContinue: () => true,
            call: async () => assert.fail("the cancelled cell has no host tools"),
          },
          5,
        );
        await native.start();
        let warm = false;
        for (let n = 0; n < 100 && !warm; n++) {
          warm = (
            (await native.command({ kind: "inspect", path: "started.txt" })) as { exists: boolean }
          ).exists;
          if (!warm) await new Promise((done) => setTimeout(done, 10));
        }
        assert.equal(warm, true, "cancel only after the actual interpreter starts");
        const stopped = await backend.cancel("owner", operation.id);
        assert.equal(stopped.status, "interrupted");
        assert.equal(stopped.cleanupConfirmed, true);
        assert.equal(
          stopped.outcomeUnknown,
          true,
          "stopping the process does not undo source effects",
        );
        const observed = await driven;
        assert.equal(observed.status, "outcome_unknown");
        assert.equal(observed.data?.cleanupConfirmed, true);
        assert.equal(observed.data?.stateLost, true);
        assert.deepEqual(
          await native.command({ kind: "inspect", path: "after-cancellation.txt" }),
          { exists: false, children: 1 },
        );
        await assert.rejects(() => backend.cancel("other-owner", operation.id));
      } finally {
        await native.close();
      }
    },
    [],
    {
      timeoutMs: 15_000,
      code: "from pathlib import Path\nimport time\nPath('started.txt').write_text('actual process running')\ntime.sleep(60)\nPath('after-cancellation.txt').write_text('must not execute')",
    },
  );
});

test("completion verifies actual native Python results and refuses an unbound script claim", {
  timeout: 45_000,
}, async (t) => {
  const code = "primos_qa = [2, 3, 5]\nprint(sum(primos_qa))";
  await pythonRuntime(
    t,
    async ({ server, registry, task, operation }) => {
      const native = await peer(registry, operation);
      try {
        const driven = dispatchPythonRequests(
          registry,
          "owner",
          operation,
          {
            shouldContinue: () => true,
            call: async () => assert.fail("this calculation has no host callbacks"),
          },
          5,
        );
        await native.start();
        assert.equal((await driven).status, "succeeded");
        const backend = new RemoteComputerBackend(registry, { executorId: operation.executorId });
        const parent = (await server.agent.journal.operations("owner", task.id)).find(
          (op) => op.toolName === "execute_code",
        );
        assert.ok(parent);
        const delivered = (await registry.delivery("owner", operation.id))?.receipt;
        assert.ok(delivered?.data?.result);
        const receipt = {
          command: await backend.command("owner", operation.id),
          result: delivered.data.result,
        };
        await server.agent.journal.recordReceipt("owner", parent.id, receipt, "succeeded");
        const verified = await server.agent.verification.assess("owner", task.id, 0);
        assert.equal(verified.status, "verified", JSON.stringify(verified));
        const running = await server.agent.getTask("owner", task.id);
        const prompt = "Run a Python program to calculate the sum of these numbers.";
        await server.db.put("owner", "tasks", {
          ...running,
          prompt,
          criteria: taskCriteria({ ...running, prompt }),
        });
        assert.equal(
          (await server.agent.verification.assess("owner", task.id, 0)).status,
          "verified",
        );
        const sessionPrompt =
          "Use uma sessão Python para somar os números e guarde o resultado para continuar depois.";
        const sessionCriteria = taskCriteria({ ...running, prompt: sessionPrompt });
        assert.ok(sessionCriteria.some((criterion) => criterion.id === "requested-python-session"));
        await server.db.put("owner", "tasks", {
          ...running,
          prompt: sessionPrompt,
          criteria: sessionCriteria,
        });
        const sessionVerified = await server.agent.verification.assess("owner", task.id, 0);
        assert.equal(sessionVerified.status, "verified", JSON.stringify(sessionVerified));
        const genericPrompt = "Execute o programa para somar os números.";
        await server.db.put("owner", "tasks", {
          ...running,
          prompt: genericPrompt,
          criteria: taskCriteria({ ...running, prompt: genericPrompt }),
        });
        assert.equal(
          (await server.agent.verification.assess("owner", task.id, 0)).status,
          "verified",
          "a generic code request also accepts the actual native interpreter",
        );
        for (const explicitPrompt of [
          "Execute o programa JavaScript para somar os números.",
          "Execute o comando shell para somar os números.",
        ]) {
          await server.db.put("owner", "tasks", {
            ...running,
            prompt: explicitPrompt,
            criteria: taskCriteria({ ...running, prompt: explicitPrompt }),
          });
          assert.notEqual(
            (await server.agent.verification.assess("owner", task.id, 0)).status,
            "verified",
            "Python must not replace the explicitly requested runtime",
          );
        }
        await server.db.put("owner", "tasks", {
          ...running,
          prompt: sessionPrompt,
          criteria: sessionCriteria,
        });
        await server.db.put("owner", "task-operations", {
          ...parent,
          status: "succeeded",
          receipt: {
            ...receipt,
            result: { ...(delivered.data.result as object), stdout: "fabricated answer" },
          },
        });
        assert.notEqual(
          (await server.agent.verification.assess("owner", task.id, 0)).status,
          "verified",
        );
        await server.db.put("owner", "task-operations", {
          ...parent,
          status: "succeeded",
          receipt: {
            ...receipt,
            command: { ...receipt.command, id: "unrelated-native-cell" },
          },
        });
        assert.notEqual(
          (await server.agent.verification.assess("owner", task.id, 0)).status,
          "verified",
        );
      } finally {
        await native.close();
      }
    },
    [],
    {
      code,
      logicalArgs: { language: "python", code },
      prompt: "Guarde os números numa sessão Python persistente para eu continuar depois.",
    },
  );
});

test("a Python callback runs the original native command tool while its own cell waits", {
  timeout: 45_000,
}, async (t) => {
  await pythonRuntime(
    t,
    async ({ server, registry, task, operation }) => {
      const native = await peer(registry, operation);
      try {
        const backend = new RemoteComputerBackend(registry, {
          executorId: operation.executorId,
          pythonEnabled: true,
          pollMs: 5,
          context: (owner, id, request) =>
            currentExecutorContext(
              owner,
              id,
              request?.kind === "command" ? { memoryBytes: 3 * 1024 ** 3, heavy: true } : undefined,
              currentComputerResourceScope(owner),
            ),
        });
        const computer = auditedComputer(
          backend,
          new ActionLog(server.db),
          "native",
          server.agent.resourceLeases,
          "lenovo",
        );
        const tool = computerTools(computer, server.files, "owner", "nested-native-command").find(
          (entry) => entry.name === "run_computer_command",
        );
        assert.ok(tool?.execute);
        let calls = 0;
        const driven = dispatchPythonRequests(
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
                      id: `nested-native:${pythonHostCallId(parent.id, request)}`,
                      toolCallId: pythonHostCallId(parent.id, request),
                      name: request.name,
                      args: request.args,
                    },
                    async () => {
                      calls++;
                      return (tool.execute as (args: unknown) => Promise<unknown>)(request.args);
                    },
                    true,
                  ),
              ),
          },
          5,
        );
        await native.start();
        const observed = await driven;
        assert.equal(observed.status, "succeeded", JSON.stringify(observed));
        assert.equal(calls, 1);
        assert.match(
          (await backend.command("owner", operation.id)).stdout,
          /nested-status succeeded 0[\s\S]*126/,
        );
        const operations = await server.agent.journal.operations("owner", task.id);
        const child = operations.find(
          (op) =>
            op.nativeEnvelope?.capability === "command" && op.nativeEnvelope?.kind === "command",
        );
        assert.ok(child);
        assert.equal(child.status, "succeeded");
        assert.equal(child.nativeEnvelope?.resourceKey, "cpu-heavy:lenovo");
        const session = operations.find((op) => op.id === operation.id);
        assert.equal(session?.status, "succeeded");
        assert.equal(
          (await server.db.list("owner", "computer-command-holds")).filter((hold) => !hold.complete)
            .length,
          0,
        );
      } finally {
        await native.close();
      }
    },
    ["run_computer_command"],
    {
      timeoutMs: 15_000,
      code: "from hermes_tools import run_computer_command\nreceipt = run_computer_command({'command': 'printf 126', 'cwd': '/workspace', 'timeoutMs': 10000, 'background': False, 'operationId': 'owned-nested-command'})\nprint('nested-status', receipt['status'], receipt['exitCode'])\nprint(receipt['stdout'])",
    },
  );
});
