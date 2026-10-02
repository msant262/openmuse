import { randomUUID } from "node:crypto";
import type { WorkClass } from "../../../../packages/domain/src/runtime.ts";
import type { Store } from "../db.ts";

export class WorkAdmission {
  private readonly claimant = randomUUID();
  constructor(
    private readonly db: Store,
    private readonly options: { now?: () => number; leaseMs?: number } = {},
  ) {}

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  claim(taskId: string, workClass: WorkClass, rootTaskId: string): Promise<boolean> {
    const now = this.now();
    return this.db.claimWorkAdmission(
      taskId,
      workClass,
      rootTaskId,
      this.claimant,
      new Date(now).toISOString(),
      new Date(now + (this.options.leaseMs ?? 60_000)).toISOString(),
    );
  }

  renew(taskId: string): Promise<boolean> {
    const now = this.now();
    return this.db.renewWorkAdmission(
      taskId,
      this.claimant,
      new Date(now).toISOString(),
      new Date(now + (this.options.leaseMs ?? 60_000)).toISOString(),
    );
  }

  hold(taskId: string): Promise<boolean> {
    return this.db.holdWorkAdmission(taskId, this.claimant);
  }

  holdForDispatch(taskId: string): Promise<boolean> {
    return this.db.holdWorkAdmissionForRunningTask(taskId, this.claimant);
  }

  /** Rebind a persisted waiting_job slot only after this worker won the task CAS. */
  rebind(taskId: string): Promise<boolean> {
    return this.db.rebindWorkAdmission(taskId, this.claimant);
  }

  release(taskId: string): Promise<boolean> {
    return this.db.releaseWorkAdmission(taskId, this.claimant);
  }

  releaseHeld(taskId: string): Promise<boolean> {
    return this.db.releaseHeldWorkAdmission(taskId);
  }
}
