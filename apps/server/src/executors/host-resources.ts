import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { hostSnapshotSchema } from "./protocol.ts";
import type { ExecutorNode } from "./registry.ts";

/** Observed native aggregate resource pressure; M3 remains admission authority. */
export class HostResources {
  constructor(
    private readonly db: Store,
    private readonly options: { now?: () => number; maxAgeMs?: number } = {},
  ) {}
  async snapshot(hostId: string) {
    const nodes = (await this.db.list<ExecutorNode>("__executors__", "nodes"))
      .filter((value) => value.hello.hostId === hostId)
      .sort((a, b) => b.lastHeartbeatAt - a.lastHeartbeatAt);
    const node = nodes.find(
      (value) =>
        value.hello.readiness.resources &&
        value.lastHeartbeatAt + (this.options.maxAgeMs ?? 40000) >
          (this.options.now?.() ?? Date.now()),
    );
    if (!node) throw new AppError("Native host resource measurement is unavailable or stale", 503);
    const measured = hostSnapshotSchema.parse(node.hello.readiness.resources);
    if (measured.hostId !== hostId)
      throw new AppError("Native host resource measurement belongs to another host", 503);
    return { ...measured, measuredAt: new Date(node.lastHeartbeatAt).toISOString() };
  }
  static aggregateBudget(memoryTotalBytes: number, reserveBytes = 4 * 1024 ** 3) {
    if (
      !Number.isSafeInteger(memoryTotalBytes) ||
      !Number.isSafeInteger(reserveBytes) ||
      reserveBytes < 3 * 1024 ** 3 ||
      reserveBytes > 4 * 1024 ** 3 ||
      reserveBytes >= memoryTotalBytes
    )
      throw new AppError(
        "Native RAM budget needs measured physical RAM and a 3–4 GiB host reserve",
        422,
      );
    return {
      memoryMaxBytes: memoryTotalBytes - reserveBytes,
      memoryHighBytes: Math.floor((memoryTotalBytes - reserveBytes) * 0.9),
      reserveBytes,
    };
  }
}
