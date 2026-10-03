import { createHash, randomUUID } from "node:crypto";
import type { ComputerCommand } from "../../../packages/domain/src/computer.ts";
import type { ResourceLease } from "../../../packages/domain/src/runtime.ts";
import { type ActionLog, type LogAction, unknownOutcome } from "./action-log.ts";
import { workspacePath } from "./computer.ts";
import {
  type ComputerBackend,
  type ComputerDispatchOptions,
  computerCommandCleanupConfirmed,
} from "./computer-contract.ts";
import { physicalComputerResources as physicalResources } from "./computer-resource-scope.ts";
import { ResourceBusyError, ResourceLeases } from "./engine/resource-leases.ts";
import type { RuntimePause } from "./engine/runtime-pause.ts";
import { authorizeTaskEffect } from "./engine/task-journal.ts";
import { AppError } from "./errors.ts";
import { backgroundFailure } from "./log.ts";

export { currentComputerResourceScope } from "./computer-resource-scope.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

// The selected deployment has one API/embedded worker. A maintenance tick may
// observe a prepared row while its own request is still awaiting local I/O.
// Track the whole attempt, including acquisition before handle publication.
const activePreflights = new Set<string>();
const activeNativeFileHolds = new Set<string>();
type NativeFileHold = {
  id: string;
  resourceHoldTaskId: string;
  leases: ResourceLease[];
  complete: boolean;
};
async function finishNativeFileHold(
  backend: ComputerBackend,
  log: ActionLog,
  resources: ResourceLeases | undefined,
  owner: string,
  hold: NativeFileHold,
) {
  if (hold.complete || !backend.physicalOperation) return;
  const state = await backend.physicalOperation(owner, hold.id);
  if (!state.cleanupConfirmed) return;
  await Promise.all(hold.leases.map((lease) => resources?.release(lease)));
  await log.db.compareAndSwap(
    owner,
    "computer-file-holds",
    hold.id,
    { complete: false },
    { complete: true },
  );
}
async function withActivePreflight<T>(operation: (attemptId: string) => Promise<T>) {
  const attemptId = randomUUID();
  activePreflights.add(attemptId);
  try {
    return await operation(attemptId);
  } finally {
    activePreflights.delete(attemptId);
  }
}

type ComputerAudit = LogAction & {
  id: string;
  operationId: string;
  phase: "prepared" | "dispatching" | "abandoned" | "complete";
  attemptId?: string;
  leases?: ResourceLease[];
  complete?: boolean;
};
const auditClaim = (audit: ComputerAudit) => ({
  phase: audit.phase,
  ...(audit.attemptId ? { attemptId: audit.attemptId } : {}),
});

/** Fence out a live preflight before freeing its exact handles. Retain the
 * abandoned selector until cleanup succeeds, including across restart. */
async function abandonPreflight(
  log: ActionLog,
  resources: ResourceLeases | undefined,
  owner: string,
  audit: ComputerAudit,
  ownedRollback = false,
) {
  if (!ownedRollback && audit.attemptId && activePreflights.has(audit.attemptId)) return;
  const claimed =
    audit.phase === "abandoned"
      ? audit
      : await log.db.compareAndSwap<ComputerAudit>(
          owner,
          "computer-audit",
          audit.id,
          auditClaim(audit),
          { phase: "abandoned" },
        );
  if (!claimed) return;
  const handles = claimed.leases ?? (await resources?.listForTask(audit.id)) ?? [];
  const cleanup = await Promise.allSettled(handles.map((handle) => resources?.release(handle)));
  if (cleanup.some((result) => result.status === "rejected")) return;
  await log.finish(owner, claimed, "rejected_not_dispatched");
  await log.db.compareAndSwap(owner, "computer-audit", audit.id, auditClaim(claimed), {
    complete: true,
    phase: "complete",
  });
}

/** Covers app and model calls at the shared backend boundary, without command/output payloads. */
export function auditedComputer(
  backend: ComputerBackend,
  log: ActionLog,
  provider: "rpc" | "docker" | "native" = "docker",
  resources?: ResourceLeases,
  hostId = "openmuse-server",
  runtimePause?: RuntimePause,
): ComputerBackend {
  const readCommand = backend.command?.bind(backend);
  const cancelCommand = backend.cancel?.bind(backend);
  const mediaCommand = backend.media?.bind(backend);
  const inspectArtifact = backend.artifact?.bind(backend);
  const canonicalFilePath = (path: string) => {
    try {
      return workspacePath(path);
    } catch {
      // Preserve the backend's audited validation error for invalid paths.
      return path;
    }
  };
  const fileResource = (owner: string, path: string, mode: "shared" | "exclusive") => ({
    key: `file:${hostId}:${hash(owner).slice(0, 20)}:${hash(canonicalFilePath(path)).slice(0, 32)}`,
    units: 1,
    mode,
  });
  const run = async <T>(
    owner: string,
    tool: string,
    operation: () => Promise<T>,
    request?: ReturnType<typeof fileResource>,
  ) => {
    const lockId = `computer-operation:${randomUUID()}`;
    const lease = request && resources ? await resources.acquire(owner, lockId, [request]) : [];
    if (request && resources && !lease) throw new ResourceBusyError([request]);
    const nativeOperations = new Set<string>();
    try {
      return await log.run(
        owner,
        { tool: `computer.${tool}`, target: "Private workspace", summary: `Computer ${tool}` },
        async () => {
          if (!["read", "list", "export", "stop", "cancel"].includes(tool))
            await runtimePause?.assertResumed(owner);
          await authorizeTaskEffect(lease ?? [], lockId);
          return physicalResources.run(
            {
              owner,
              resourceHoldTaskId: lockId,
              leases: lease ?? [],
              trackNativeOperation: async (id) => {
                if (provider !== "native" || !request) return;
                nativeOperations.add(id);
                activeNativeFileHolds.add(`${owner}:${id}`);
                await log.db.insertIfAbsent<NativeFileHold>(owner, "computer-file-holds", {
                  id,
                  resourceHoldTaskId: lockId,
                  leases: lease ?? [],
                  complete: false,
                });
                for (const handle of lease ?? [])
                  if (!(await resources?.hold(handle))) throw new ResourceBusyError([request]);
              },
            },
            operation,
          );
        },
      );
    } finally {
      try {
        if (nativeOperations.size) {
          for (const id of nativeOperations) {
            const hold = await log.db.get<NativeFileHold>(owner, "computer-file-holds", id);
            if (hold) await finishNativeFileHold(backend, log, resources, owner, hold);
          }
        } else if (request && resources)
          await Promise.all((lease ?? []).map((handle) => resources.release(handle)));
      } finally {
        for (const id of nativeOperations) activeNativeFileHolds.delete(`${owner}:${id}`);
      }
    }
  };
  const finish = async (owner: string, receipt: ComputerCommand) => {
    if (receipt.status === "running") return;
    const action = await log.db.get<ComputerAudit>(owner, "computer-audit", receipt.id);
    if (action)
      await log.finish(
        owner,
        action,
        receipt.status === "succeeded"
          ? "succeeded"
          : receipt.status === "rejected_not_dispatched"
            ? "rejected_not_dispatched"
            : receipt.status === "interrupted" || receipt.status === "timed_out"
              ? "outcome_unknown"
              : "failed",
      );
    // Interrupted/timed-out receipts are explicitly uncertain. Keep the heavy
    // lease until a later backend receipt confirms the process is terminal.
    if (computerCommandCleanupConfirmed(receipt)) {
      if (receipt.status === "rejected_not_dispatched") {
        const current = await log.db.get<ComputerCommand>(owner, "computer-commands", receipt.id);
        if (current?.status !== receipt.status || action?.phase === "prepared") return;
      }
      const handles = action?.leases ?? (await resources?.listForTask(receipt.id)) ?? [];
      await Promise.all(handles.map((lease) => resources?.release(lease)));
      if (action && receipt.status === "rejected_not_dispatched")
        await log.db.compareAndSwap(owner, "computer-audit", receipt.id, auditClaim(action), {
          phase: "complete",
          complete: true,
        });
    }
  };
  const command = async (
    owner: string,
    tool: string,
    options: ComputerDispatchOptions,
    operation: (bound: typeof options) => Promise<ComputerCommand>,
  ) =>
    withActivePreflight(async (attemptId) => {
      let dispatchStarted = false;
      const bound = { ...options, idempotencyKey: options.idempotencyKey ?? randomUUID() };
      const receiptId = createHash("sha256")
        .update(
          provider === "rpc" || provider === "native"
            ? `${owner}:${bound.idempotencyKey}`
            : `computer-command:${bound.idempotencyKey}`,
        )
        .digest("hex");
      const requests = [
        { key: `cpu-heavy:${hostId}`, units: 1, mode: "exclusive" as const },
        { key: `system-admin:${hostId}`, units: 1, mode: "shared" as const },
      ];
      const priorReceipt = await log.db.get<ComputerCommand>(owner, "computer-commands", receiptId);
      if (priorReceipt && priorReceipt.status !== "rejected_not_dispatched") {
        // A replay borrows physical ownership; it cannot prepare or clean up the
        // running command's leases. Let the adapter validate the argument binding.
        const borrowed = (await resources?.listForTask(receiptId)) ?? [];
        const receipt = await physicalResources.run(
          { owner, resourceHoldTaskId: receiptId, leases: borrowed },
          () =>
            operation({
              ...bound,
              onDispatch: async () => {
                throw new AppError("Existing command cannot acquire new dispatch ownership", 409);
              },
            }),
        );
        await bound.onDispatch?.(receipt.id);
        await finish(owner, receipt);
        return receipt;
      }
      const action = {
        tool: `computer.${tool}`,
        target: "Private workspace",
        summary: `Computer ${tool}`,
        operationId: receiptId,
      };
      const audit: ComputerAudit = {
        ...action,
        id: receiptId,
        attemptId,
        phase: "prepared",
        complete: false,
        leases: [],
      };
      const previousAudit = await log.db.get<ComputerAudit>(owner, "computer-audit", receiptId);
      const prepared = previousAudit
        ? previousAudit.phase === "complete"
          ? await log.db.compareAndSwap(
              owner,
              "computer-audit",
              receiptId,
              auditClaim(previousAudit),
              audit,
            )
          : null
        : await log.db.insertIfAbsent(owner, "computer-audit", audit);
      if (!prepared) throw new AppError("Computer preflight ownership is already claimed", 409);
      let leases: ResourceLease[] = [];
      try {
        const acquired = resources
          ? await resources.acquire(owner, receiptId, requests, attemptId)
          : [];
        if (!acquired) throw new ResourceBusyError(requests);
        leases = acquired;
        const saved = await log.db.compareAndSwap<ComputerAudit>(
          owner,
          "computer-audit",
          receiptId,
          auditClaim(audit),
          { leases },
        );
        if (!saved) throw new AppError("Computer preflight ownership was withdrawn", 409);
        audit.leases = leases;
        for (const lease of leases) {
          if (!(await resources?.hold(lease)))
            throw new AppError("Computer preflight resource ownership was lost", 409);
        }
        await log.append(owner, action, "started");
      } catch (error) {
        await abandonPreflight(log, resources, owner, audit, true);
        // These handles were acquired only after winning the unique preflight.
        // Releasing by ID/fence cannot delete a successor's claim.
        if (audit.leases !== leases)
          await Promise.allSettled(leases.map((lease) => resources?.release(lease)));
        throw error;
      }
      let receipt: ComputerCommand;
      const backendOptions = {
        idempotencyKey: bound.idempotencyKey,
        signal: bound.signal,
        dispatchContext: bound.dispatchContext,
        onDispatch: async (actualId: string) => {
          if (actualId !== receiptId)
            throw new Error("Computer backend receipt ID did not match the audited operation");
          if (dispatchStarted) return;
          const claimed = await log.db.compareAndSwap(
            owner,
            "computer-audit",
            receiptId,
            auditClaim(audit),
            { phase: "dispatching" },
          );
          if (!claimed) throw new AppError("Computer dispatch ownership was withdrawn", 409);
          await bound.onDispatch?.(actualId);
          dispatchStarted = true;
        },
        dispatchGuard: async () => {
          await runtimePause?.assertResumed(owner);
          await bound.dispatchGuard?.();
          await authorizeTaskEffect(leases, receiptId);
        },
      };
      try {
        await backendOptions.dispatchGuard();
        receipt = await physicalResources.run(
          { owner, resourceHoldTaskId: receiptId, leases },
          () => operation(backendOptions),
        );
        // Test and third-party backends may not expose a pre-dispatch hook. If
        // they return a receipt, conservatively persist occupancy before using it.
        await backendOptions.onDispatch(receipt.id);
      } catch (error) {
        const saved = await log.db.get<ComputerCommand>(owner, "computer-commands", receiptId);
        if (
          !dispatchStarted ||
          saved?.status === "failed" ||
          saved?.status === "rejected_not_dispatched"
        ) {
          await Promise.all(leases.map((lease) => resources?.release(lease)));
          await log.finish(owner, action, "rejected_not_dispatched");
          throw error;
        }
        const uncertain = saved ? !computerCommandCleanupConfirmed(saved) : unknownOutcome(error);
        if (!uncertain) await Promise.all(leases.map((lease) => resources?.release(lease)));
        await log.finish(owner, action, uncertain ? "outcome_unknown" : "failed");
        if (uncertain) {
          const pending =
            error instanceof Error ? error : new Error("Computer command outcome is unknown");
          Object.assign(pending, { computerCommandId: receiptId });
          throw pending;
        }
        throw error;
      }
      await finish(owner, receipt);
      return receipt;
    });
  const recovery =
    backend.recovery &&
    new Proxy(backend.recovery, {
      get(target, key) {
        if (key === "capture" || key === "trash" || key === "restore")
          return async (...args: unknown[]) => {
            const owner = String(args[0]);
            const record = await log.db.get<{ path: string }>(
              owner,
              key === "restore" ? "file-versions" : "native-artifacts",
              String(args[key === "restore" ? 1 : 2]),
            );
            if (!record)
              throw new AppError("Owned native recovery artifact/version not found", 404);
            return run(
              owner,
              `file_version_${key}`,
              () => Reflect.apply(target[key], target, args),
              fileResource(owner, record.path, "exclusive"),
            );
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return {
    ...(recovery && { recovery }),
    ...(backend.physicalOperation && {
      physicalOperation: backend.physicalOperation.bind(backend),
    }),
    ...(inspectArtifact && {
      artifact: (owner: string, path: string) =>
        run(owner, "read", () => inspectArtifact(owner, path), fileResource(owner, path, "shared")),
    }),
    snapshot: async (owner) => {
      const value = await backend.snapshot(owner);
      for (const receipt of value.commands) await finish(owner, receipt);
      return value;
    },
    start: (owner) =>
      run(owner, "start", () => backend.start(owner), {
        key: `system-admin:${hostId}`,
        units: 1,
        mode: "exclusive",
      }),
    stop: (owner) =>
      run(owner, "stop", () => backend.stop(owner), {
        key: `system-admin:${hostId}`,
        units: 1,
        mode: "exclusive",
      }),
    execute: (owner, raw, options = {}) =>
      command(owner, "command", options, (bound) => backend.execute(owner, raw, bound)),
    list: (owner, path) =>
      run(
        owner,
        "list",
        () => backend.list(owner, path),
        fileResource(owner, path ?? "/workspace", "shared"),
      ),
    read: (owner, path) =>
      run(owner, "read", () => backend.read(owner, path), fileResource(owner, path, "shared")),
    write: (owner, path, text) =>
      run(
        owner,
        "write",
        () => backend.write(owner, path, text),
        fileResource(owner, path, "exclusive"),
      ),
    mkdir: (owner, path) =>
      run(owner, "mkdir", () => backend.mkdir(owner, path), fileResource(owner, path, "exclusive")),
    writePdf: (owner, path, bytes) =>
      run(
        owner,
        "import",
        () => backend.writePdf(owner, path, bytes),
        fileResource(owner, path, "exclusive"),
      ),
    pdfBytes: (owner, path) =>
      run(
        owner,
        "export",
        () => backend.pdfBytes(owner, path),
        fileResource(owner, path, "shared"),
      ),
    writeBytes: (owner, path, bytes) =>
      run(
        owner,
        "import",
        () => backend.writeBytes(owner, path, bytes),
        fileResource(owner, path, "exclusive"),
      ),
    fileBytes: (owner, path) =>
      run(
        owner,
        "export",
        () => backend.fileBytes(owner, path),
        fileResource(owner, path, "shared"),
      ),
    ...(readCommand && {
      command: async (owner: string, id: string) => {
        const receipt = await readCommand(owner, id);
        await finish(owner, receipt);
        return receipt;
      },
    }),
    ...(cancelCommand && {
      cancel: (owner: string, id: string) =>
        run(owner, "cancel", async () => {
          const receipt = await cancelCommand(owner, id);
          await finish(owner, receipt);
          return receipt;
        }),
    }),
    ...(mediaCommand && {
      media: (
        owner: string,
        kind: "transcribe" | "preview",
        raw: unknown,
        options: ComputerDispatchOptions = {},
      ) => command(owner, kind, options, (bound) => mediaCommand(owner, kind, raw, bound)),
    }),
  };
}

/** Reconcile background results from their owned backend receipts, without rerunning commands. */
export async function reconcileComputerAudit(backend: ComputerBackend, log: ActionLog) {
  const resources = new ResourceLeases(log.db);
  for (const { owner, value } of await log.db.scan<NativeFileHold>("computer-file-holds")) {
    if (value.complete || activeNativeFileHolds.has(`${owner}:${value.id}`)) continue;
    try {
      await finishNativeFileHold(backend, log, resources, owner, value);
    } catch (error) {
      backgroundFailure("native file hold reconciliation", error);
    }
  }
  for (const { owner, value } of await log.db.scan<ComputerAudit>("computer-audit")) {
    if (value.complete) continue;
    if (value.phase === "abandoned") {
      await abandonPreflight(log, resources, owner, value);
      continue;
    }
    const saved = await log.db.get<{ status: string }>(owner, "computer-commands", value.id);
    if (!saved) {
      if (value.phase === "prepared") await abandonPreflight(log, resources, owner, value);
      // A dispatching operation with no receipt remains uncertain.
      continue;
    }
    try {
      const receipt = backend.command
        ? await backend.command(owner, value.id)
        : (await backend.snapshot(owner)).commands.find((command) => command.id === value.id);
      if (!receipt) continue;
      if (computerCommandCleanupConfirmed(receipt))
        await log.db.compareAndSwap(owner, "computer-audit", value.id, auditClaim(value), {
          complete: true,
          phase: "complete",
        });
    } catch (error) {
      backgroundFailure("computer audit reconciliation", error);
    }
  }
}
