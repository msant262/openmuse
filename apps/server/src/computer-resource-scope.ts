import { AsyncLocalStorage } from "node:async_hooks";
import type { ResourceLease } from "../../../packages/domain/src/runtime.ts";

export type ComputerResourceScope = {
  owner: string;
  resourceHoldTaskId: string;
  leases: ResourceLease[];
  trackNativeOperation?: (operationId: string) => Promise<void>;
};
export const physicalComputerResources = new AsyncLocalStorage<ComputerResourceScope>();
/** Exact M3 handles at the final backend boundary; this grants no authority. */
export function currentComputerResourceScope(owner: string) {
  const scope = physicalComputerResources.getStore();
  return scope?.owner === owner ? scope : undefined;
}
export async function trackNativeComputerOperation(owner: string, id: string) {
  await currentComputerResourceScope(owner)?.trackNativeOperation?.(id);
}
