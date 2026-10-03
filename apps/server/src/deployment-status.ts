import type { AgentTask } from "../../../packages/domain/src/agent.ts";
import type { Store } from "./db.ts";
import { DeploymentMaintenance } from "./deployment-maintenance.ts";
import { RuntimePause } from "./engine/runtime-pause.ts";
import type { ExecutorDelivery } from "./executors/registry.ts";

/** Operator backup preflight. Counts are deliberately global: a second owner
 * cannot be omitted from a stopped-writer consistency decision. No payloads,
 * tokens, source contents or account information are returned. */
export async function deploymentStatus(db: Store, now = Date.now(), activeRequests = () => 0) {
  const [pause, maintenance, tasks, admissions, leases, deliveries, operations] = await Promise.all(
    [
      new RuntimePause(db).get(""),
      new DeploymentMaintenance(db).current(now),
      db.scan<AgentTask>("tasks"),
      db.scan<{ hold?: boolean; expiresAt: string }>("work-admissions"),
      db.scan<{ hold?: boolean; expiresAt: string }>("resource-leases"),
      db.list<ExecutorDelivery>("__executors__", "deliveries"),
      db.scan<{ status: string; receipt?: { cleanupConfirmed?: boolean } }>("task-operations"),
    ],
  );
  const occupied = (row: { hold?: boolean; expiresAt: string }) =>
    row.hold === true || Date.parse(row.expiresAt) > now;
  const activeTasks = tasks.filter(({ value }) =>
    ["running", "waiting_job"].includes(value.status),
  ).length;
  const heldResources = leases.filter(({ value }) => occupied(value)).length;
  const workAdmissions = admissions.filter(({ value }) => occupied(value)).length;
  const activeOperations = operations.filter(
    ({ value }) =>
      ["dispatching", "running"].includes(value.status) ||
      (value.status === "outcome_unknown" && value.receipt?.cleanupConfirmed !== true),
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
