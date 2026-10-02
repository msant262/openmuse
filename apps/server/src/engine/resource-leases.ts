import { randomUUID } from "node:crypto";
import {
  type ResourceLease,
  type ResourceRequest,
  resourceLeaseSchema,
  resourceRequestSchema,
} from "../../../../packages/domain/src/runtime.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";

export class ResourceBusyError extends AppError {
  constructor(readonly requests: ResourceRequest[]) {
    super("A required resource is currently leased by other work. This task will wait.", 409);
    this.name = "ResourceBusyError";
  }
}

export class ResourceLeases {
  constructor(
    private readonly db: Store,
    private readonly options: { now?: () => number; leaseMs?: number } = {},
  ) {}

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  async acquire(
    owner: string,
    taskId: string,
    requests: ResourceRequest[],
    claimant?: string,
  ): Promise<ResourceLease[] | null> {
    const validated = requests.map((request) => resourceRequestSchema.parse(request));
    if (validated.some((request) => request.units !== 1))
      throw new AppError("This runtime supports one unit per resource lease", 422);
    if (new Set(validated.map((request) => request.key)).size !== validated.length)
      throw new AppError("A resource may appear only once in a lease request", 422);
    const now = this.now();
    const expiry = new Date(now + (this.options.leaseMs ?? 60_000)).toISOString();
    const claimed = await this.db.acquireResourceLeases(
      owner,
      taskId,
      validated.map((request) => ({
        ...request,
        id: randomUUID(),
        ...(claimant ? { claimant } : {}),
      })),
      new Date(now).toISOString(),
      expiry,
    );
    return claimed?.map((lease) => resourceLeaseSchema.parse(lease)) ?? null;
  }

  async renew(lease: ResourceLease): Promise<ResourceLease | null> {
    const now = this.now();
    const renewed = await this.db.renewResourceLease(
      resourceLeaseSchema.parse(lease),
      new Date(now).toISOString(),
      new Date(now + (this.options.leaseMs ?? 60_000)).toISOString(),
    );
    return renewed ? resourceLeaseSchema.parse(renewed) : null;
  }

  async release(lease: ResourceLease): Promise<void> {
    await this.db.releaseResourceLease(resourceLeaseSchema.parse(lease));
  }

  async releaseTask(taskId: string): Promise<void> {
    await this.db.releaseTaskResourceLeases(taskId);
  }

  async holdTask(taskId: string): Promise<void> {
    await this.db.holdTaskResourceLeases(taskId);
  }

  hold(lease: ResourceLease): Promise<boolean> {
    return this.db.holdResourceLease(resourceLeaseSchema.parse(lease));
  }

  listForTask(taskId: string): Promise<ResourceLease[]> {
    return this.db.resourceLeasesForTask(taskId);
  }
}
