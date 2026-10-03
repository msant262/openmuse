import { createHash } from "node:crypto";
import type { Store } from "../../apps/server/src/db.ts";
import type {
  ExecutorAuthority,
  ExecutorOperation,
  ExecutorRequest,
} from "../../apps/server/src/executors/protocol.ts";

export const nodeToken = "native-fixture-token-scoped-to-lenovo-123456";
export const registration = {
  executorId: "lenovo-okami",
  hostId: "lenovo",
  osAccountId: "1003",
  owner: "owner",
  tokenHash: createHash("sha256").update(nodeToken).digest("hex"),
  trustMode: "full-trust" as const,
};
export const readiness = {
  account: { state: "ready" as const },
  runtime: { state: "ready" as const },
  files: { state: "ready" as const },
  display: { state: "unavailable" as const, reason: "Xvnc absent" },
  capture: { state: "unavailable" as const },
  input: { state: "unavailable" as const },
  browser: { state: "starting" as const },
  trustMode: "full-trust" as const,
  containmentGuaranteed: false,
  quarantined: false,
};
export const hello = {
  hostId: "lenovo",
  executorId: "lenovo-okami",
  osAccountId: "1003",
  bootId: "boot-a",
  instanceId: "instance-a",
  minProtocolVersion: 1,
  maxProtocolVersion: 1,
  capabilities: [
    { name: "command" as const, version: 1 },
    { name: "files" as const, version: 1 },
  ],
  readiness,
};
export const request = (id = "9".repeat(64)): ExecutorRequest => ({
  id,
  executorId: "lenovo-okami",
  kind: "command",
  capability: "command",
  capabilityVersion: 1,
  args: { command: "printf ok", cwd: "/workspace", timeoutMs: 1000, background: true },
});
export const context = {
  kind: "task" as const,
  taskId: "task",
  desiredRevision: 3,
  runToken: "fixture-trusted-task-token",
  resourceLeaseIds: ["host:lenovo"],
};

/** Test authority writes the same persistent record used by its dispatch barrier.
 * Production must compose M4's actual journal; this fixture never becomes fallback code.
 */
export function authority(
  db: Store,
  options: { paused?: boolean; deny?: boolean } = {},
): ExecutorAuthority {
  return {
    async authorize(owner, input, epoch) {
      const bindingHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const operation: ExecutorOperation = {
        ...input,
        capabilityVersion: input.capabilityVersion ?? 1,
        inspection: input.inspection ?? false,
        bindingHash,
        taskId: "task",
        revision: 3,
        executorEpoch: epoch,
        resourceFence: 7,
        resourceKey: "host:lenovo",
        expiresAt: "2999-01-01T00:00:00.000Z",
        createdAt: "2026-10-02T00:00:00.000Z",
      };
      const prior = await db.get<ExecutorOperation>(
        owner,
        "fixture-authoritative-operations",
        input.id,
      );
      if (prior && prior.bindingHash !== bindingHash) throw new Error("binding conflict");
      await db.insertIfAbsent(owner, "fixture-authoritative-operations", {
        ...operation,
        status: "queued",
      });
      return prior ?? operation;
    },
    async beforeDispatch(owner, operation) {
      if (options.deny) throw new Error("desired revision superseded");
      await db.compareAndSwap(
        owner,
        "fixture-authoritative-operations",
        operation.id,
        {},
        { status: "dispatching" },
      );
    },
    async recordReceipt(owner, operation, receipt) {
      await db.compareAndSwap(
        owner,
        "fixture-authoritative-operations",
        operation.id,
        {},
        { status: receipt.status },
      );
    },
    async reconcileMissing(owner, operation) {
      await db.compareAndSwap(
        owner,
        "fixture-authoritative-operations",
        operation.id,
        {},
        { status: "outcome_unknown" },
      );
    },
    async pause() {
      return {
        paused: Boolean(options.paused),
        revision: options.paused ? 2 : 0,
        changedAt: "2026-10-02T00:00:00.000Z",
      };
    },
  };
}
