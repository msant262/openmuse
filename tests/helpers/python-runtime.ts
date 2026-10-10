import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { bindingHash } from "../../apps/server/src/conversation-inbox.ts";
import { TaskExecutorAuthority } from "../../apps/server/src/engine/task-executor-authority.ts";
import { TaskWorker } from "../../apps/server/src/engine/worker.ts";
import { pythonResourceKey } from "../../apps/server/src/executors/python-protocol.ts";
import { ExecutorRegistry } from "../../apps/server/src/executors/registry.ts";
import type { AgentTask } from "../../packages/domain/src/agent.ts";
import { hello, registration } from "./executors.ts";
import { taskRuntime } from "./task-runtime.ts";

/** Real M3 task admission, journal, session leases and M4 authority. The native
 * peer's protocol receipts are fixtures; this helper proves no provider effect. */
export async function pythonRuntime(
  t: TestContext,
  run: (f: {
    server: Awaited<ReturnType<typeof taskRuntime>>;
    registry: ExecutorRegistry;
    authority: TaskExecutorAuthority;
    task: AgentTask;
    operation: Awaited<ReturnType<ExecutorRegistry["enqueue"]>>;
    context: {
      kind: "task";
      taskId: string;
      desiredRevision: number;
      runToken: string;
      resourceLeaseIds: string[];
      resourceBudget: { memoryBytes: number; heavy: boolean };
    };
    rpc: (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<{ sequence: number; json: string; sha256: string }>;
  }) => Promise<void>,
  tools = ["write_sample"],
  cell: { code?: string; timeoutMs?: number; logicalArgs?: unknown; prompt?: string } = {},
) {
  const server = await taskRuntime(t);
  const authority = new TaskExecutorAuthority(server.agent.journal, {
    executor: () => ({ hostId: "lenovo" }),
  });
  const registry = new ExecutorRegistry(server.db, { registrations: [registration], authority });
  const { epoch } = await registry.register({
    ...hello,
    capabilities: [...hello.capabilities, { name: "python", version: 1 }],
  });
  await registry.reconcile(registration.executorId, {
    epoch,
    bootId: hello.bootId,
    operations: [],
    contained: true,
  });
  const task = await server.agent.createTask("owner", {
    prompt: cell.prompt ?? "Owned Python protocol fixture",
  });
  let error: unknown;
  let reached = false;
  const worker = new TaskWorker(server.db, async (owner, running, ctx) => {
    try {
      const id = `python-${randomUUID()}`;
      const args = {
        command: "Python cell",
        cwd: "/workspace",
        background: false,
        timeoutMs: cell.timeoutMs ?? 3000,
        pythonCell: {
          owner,
          sessionId: "conversation",
          code: cell.code ?? "print(42)",
          tools,
          reset: false,
          maxToolCalls: 100,
          outputBytes: 131072,
        },
      };
      const leases = await server.agent.resourceLeases.acquire(owner, id, [
        {
          key: pythonResourceKey(registration.executorId, owner, "conversation"),
          units: 1,
          mode: "exclusive",
        },
        { key: "system-admin:lenovo", units: 1, mode: "shared" },
      ]);
      assert.ok(leases);
      for (const lease of leases) assert.equal(await server.agent.resourceLeases.hold(lease), true);
      const parent = `logical-${id}`;
      await server.agent.journal.prepare(owner, {
        id: parent,
        taskId: running.id,
        revision: 0,
        bindingHash: bindingHash(args),
        executorId: "vps",
        executorEpoch: 1,
        resourceFence: 0,
        status: "queued",
        toolName: "execute_code",
        args: cell.logicalArgs ?? args,
        effect: false,
        runToken: String(running.leaseId),
        resourceLeaseIds: [],
        createdAt: new Date().toISOString(),
      });
      await server.agent.journal.bindResources(owner, parent, id, leases);
      const context = {
        kind: "task" as const,
        taskId: running.id,
        desiredRevision: 0,
        runToken: String(running.leaseId),
        resourceLeaseIds: leases.map((lease) => lease.id),
        resourceBudget: { memoryBytes: 512 * 1024 ** 2, heavy: false },
      };
      const operation = await registry.enqueue(
        owner,
        {
          id,
          executorId: registration.executorId,
          kind: "command",
          capability: "python",
          capabilityVersion: 1,
          inspection: false,
          args,
        },
        context,
      );
      const claim = await registry.claimOperations(registration.executorId, epoch);
      assert.equal(claim.operations[0]?.id, operation.id);
      let sequence = 1;
      const rpc = async (name: string, args: Record<string, unknown>) => {
        const json = JSON.stringify({ name, args });
        const request = {
          sequence: sequence++,
          json,
          sha256: createHash("sha256").update(json).digest("hex"),
        };
        await registry.submitReceipt(registration.executorId, epoch, id, request.sequence, {
          status: "running",
          data: { pythonRpc: request, cellSettled: false, cleanupConfirmed: false },
        });
        return request;
      };
      reached = true;
      await run({ server, registry, authority, task: running, operation, context, rpc });
    } catch (caught) {
      error = caught;
    }
    await ctx.holdAdmission();
    return { status: "waiting_job" as const };
  });
  t.after(() => worker.stop());
  await worker.tick();
  if (error) throw error;
  assert.equal(reached, true, JSON.stringify(await server.agent.getTask("owner", task.id)));
}
