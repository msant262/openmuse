import type { AgentTask } from "../../../packages/domain/src/agent.ts";
import type { Store } from "./db.ts";
import { DeploymentMaintenance } from "./deployment-maintenance.ts";
import { RuntimePause } from "./engine/runtime-pause.ts";
import type { ExecutorDelivery } from "./executors/registry.ts";

/** Operator backup preflight. Counts are deliberately global: a second owner
 * cannot be omitted from a stopped-writer consistency decision. No payloads,
 * tokens, source contents or account information are returned. */
export async function deploymentStatus(db: Store, now = Date.now(), activeRequests = () => 0) {
  const [pause, maintenance, tasks, admissions, leases, deliveries, operations, avatars] =
    await Promise.all([
      new RuntimePause(db).get(""),
      new DeploymentMaintenance(db).current(now),
      db.scan<AgentTask>("tasks"),
      db.scan<{ hold?: boolean; expiresAt: string }>("work-admissions"),
      db.scan<{ hold?: boolean; expiresAt: string }>("resource-leases"),
      db.list<ExecutorDelivery>("__executors__", "deliveries"),
      db.scan<{
        id: string;
        status: string;
        toolName?: string;
        effect?: boolean;
        nativeEnvelope?: { id?: string; kind?: string };
        receipt?: {
          cleanupConfirmed?: boolean;
          data?: { cleanupConfirmed?: boolean };
          enabled?: boolean;
          provider?: string;
          status?: string;
          workspacePath?: string;
          network?: string;
          commands?: unknown[];
          error?: unknown;
        };
      }>("task-operations"),
      db.scan<{
        status: string;
        leaseUntil?: number;
        dispatching?: boolean;
        providerRequestId?: string | null;
      }>("avatar-generations"),
    ]);
  const occupied = (row: { hold?: boolean; expiresAt: string }) =>
    row.hold === true || Date.parse(row.expiresAt) > now;
  const activeTasks = tasks.filter(({ value }) =>
    ["running", "waiting_job"].includes(value.status),
  ).length;
  const heldResources = leases.filter(({ value }) => occupied(value)).length;
  const workAdmissions = admissions.filter(({ value }) => occupied(value)).length;
  const activeAvatarOperations = avatars.filter(
    ({ value }) =>
      value.status === "running" &&
      (Boolean(value.providerRequestId) ||
        Boolean(value.dispatching) ||
        (value.leaseUntil ?? 0) > now),
  ).length;
  const activeOperations =
    activeAvatarOperations +
    operations.filter(
      ({ value }) =>
        // Older journals copied the computer's running state onto a completed
        // read. Preserve that history while counting only actual pending work.
        !(
          value.status === "running" &&
          value.effect === false &&
          value.toolName === "computer_status" &&
          !value.receipt?.error &&
          typeof value.receipt?.enabled === "boolean" &&
          ["docker", "rpc", "native"].includes(value.receipt.provider ?? "") &&
          value.receipt.status === "running" &&
          value.receipt.workspacePath === "/workspace" &&
          ["disabled", "public-only"].includes(value.receipt.network ?? "") &&
          Array.isArray(value.receipt.commands)
        ) &&
        (["dispatching", "running"].includes(value.status) ||
          (value.status === "outcome_unknown" &&
            value.receipt?.cleanupConfirmed !== true &&
            !(
              // Native cleanup confirms resources are released, not that the
              // original effect succeeded. Its immutable result stays uncertain.
              (
                value.nativeEnvelope?.id === value.id &&
                value.toolName === `native.${value.nativeEnvelope?.kind}` &&
                value.receipt?.status === "outcome_unknown" &&
                value.receipt.data?.cleanupConfirmed === true
              )
            ))),
    ).length;
  const nativeDeliveries = deliveries.filter(
    (value) =>
      value.state === "claimed" ||
      value.receipt?.status === "running" ||
      (value.receipt?.status === "outcome_unknown" &&
        value.receipt.data?.cleanupConfirmed !== true),
  ).length;
  const activeHttpRequests = activeRequests();
  return {
    format: 1,
    pause,
    maintenance: maintenance ? { id: maintenance.id, expiresAt: maintenance.expiresAt } : null,
    activeTasks,
    workAdmissions,
    heldResources,
    activeOperations,
    nativeDeliveries,
    activeHttpRequests,
    readyForStoppedWriterBackup:
      (pause.paused || Boolean(maintenance)) &&
      !activeTasks &&
      !workAdmissions &&
      !heldResources &&
      !activeOperations &&
      !nativeDeliveries &&
      !activeHttpRequests,
  };
}
