import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

export type DeploymentMaintenanceState = {
  id: string;
  owner: string;
  active: boolean;
  expiresAt: string;
};

/** Admission drain only. Existing effects remain authorized to finish under
 * their current task leases; this never aborts/freezes them or changes user pause. */
export class DeploymentMaintenance {
  private readonly db: Store;
  activeRequests = 0;
  constructor(db: Store) {
    this.db = db;
  }
  request() {
    this.activeRequests++;
    return () => {
      this.activeRequests--;
    };
  }
  async current(now = Date.now()) {
    const value = await this.db.get<DeploymentMaintenanceState>(
      "__runtime__",
      "deployment-maintenance",
      "global",
    );
    return value?.active && Date.parse(value.expiresAt) > now ? value : null;
  }
  async update(
    owner: string,
    id: string,
    operation: "begin" | "renew" | "finish",
    ttlMs = 120_000,
  ) {
    const now = Date.now();
    const state = await this.db.updateDeploymentMaintenance<DeploymentMaintenanceState>(
      owner,
      id,
      operation,
      new Date(now).toISOString(),
      new Date(now + ttlMs).toISOString(),
    );
    if (!state) throw new AppError("Deployment maintenance lease changed or expired", 409);
    return state;
  }
}
