import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type { ComputerCommand } from "../../../../packages/domain/src/computer.ts";
import { type ComputerBackend, computerCommandCleanupConfirmed } from "../computer-contract.ts";
import type { Store } from "../db.ts";
import { ResourceLeases } from "./resource-leases.ts";
import type { TaskJournal } from "./task-journal.ts";
import type { WorkAdmission } from "./work-admission.ts";

export async function readComputerCommand(
  computer: ComputerBackend,
  owner: string,
  id: string,
): Promise<ComputerCommand | undefined> {
  if (computer.command) return computer.command(owner, id);
  return (await computer.snapshot(owner)).commands.find((command) => command.id === id);
}

/** Release abandoned task slots only after a durable computer receipt proves termination. */
export async function reconcileWaitingComputerTasks(
  db: Store,
  computer: ComputerBackend,
  admission: WorkAdmission,
  resources = new ResourceLeases(db),
  journal?: Pick<TaskJournal, "reconcileComputerReceipt">,
) {
  const resumable = new Set([
    "running",
    "queued",
    "scheduled",
    "waiting_job",
    "waiting_resource",
    "waiting_global_pause",
    "waiting_approval",
  ]);
  for (const { owner, value: task } of await db.taskMaintenanceCandidates<AgentTask>("computer")) {
    const id =
      typeof task.state.computerCleanupPendingId === "string"
        ? task.state.computerCleanupPendingId
        : typeof task.state.waitingComputerCommandId === "string"
          ? task.state.waitingComputerCommandId
          : Array.isArray(task.state.reconcilingOperationIds) &&
              task.state.completedComputerJob &&
              typeof task.state.completedComputerJob === "object"
            ? (task.state.completedComputerJob as { id?: unknown }).id
            : undefined;
    if (typeof id !== "string" || resumable.has(task.status)) continue;
    let receipt: ComputerCommand | undefined;
    try {
      receipt = await readComputerCommand(computer, owner, id);
    } catch {
      // A failed poll cannot establish that the physical process has stopped.
      continue;
    }
    if (!receipt || !computerCommandCleanupConfirmed(receipt)) continue;
    // Reconcile the SDK intention and its physical primitive as well as the
    // resource hold; otherwise a confirmed failed command blocks every later effect.
    await journal?.reconcileComputerReceipt(owner, task.id, receipt);
    const selector =
      typeof task.state.computerCleanupPendingId === "string"
        ? { computerCleanupPendingId: id }
        : { waitingComputerCommandId: id };
    const updated = await db.compareAndSwapTask<AgentTask>(
      owner,
      task.id,
      {
        status: task.status,
        state: selector,
      },
      {
        state: {
          waitingComputerCommandId: id,
          computerCleanupPendingId: id,
          uncertainComputerCommand: false,
          completedComputerJob: {
            id: receipt.id,
            status: receipt.status,
            exitCode: receipt.exitCode,
            stdout: receipt.stdout.slice(0, 12000),
            stderr: receipt.stderr.slice(0, 4000),
            truncated: receipt.truncated || receipt.stdout.length > 12000,
            cleanupConfirmed: receipt.cleanupConfirmed,
            outcomeUnknown: receipt.outcomeUnknown,
          },
        },
      },
    );
    if (!updated) continue;
    await resources.releaseTask(id);
    await admission.releaseHeld(task.id);
    const latest = await db.get<AgentTask>(owner, "tasks", task.id);
    if (!latest || resumable.has(latest.status)) continue;
    const remainingAdmission = await db.get("__runtime__", "work-admissions", task.id);
    if (remainingAdmission) continue;
    await db.compareAndSwapTask(
      owner,
      task.id,
      { status: latest.status, state: { computerCleanupPendingId: id } },
      {
        state: {
          waitingComputerCommandId: null,
          computerCleanupPendingId: null,
        },
      },
    );
  }
}
