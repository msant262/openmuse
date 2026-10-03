import { z } from "zod";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import type { ExecutorRegistry } from "./executors/registry.ts";

const liveFrameSchema = z.object({
  epoch: z.number().int().positive(),
  operationId: z.string().min(1).max(128),
  sessionId: z.uuid(),
  sessionGeneration: z.uuid(),
  sequence: z.number().int().positive(),
  observedAt: z.iso.datetime().optional(),
  image: z
    .string()
    .max(11_184_812)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  mimeType: z.enum(["image/png", "image/jpeg"]),
  width: z.number().int().min(1).max(3840),
  height: z.number().int().min(1).max(2160),
  frameId: z.uuid().optional(),
  imageHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type LiveDesktopFrame = z.infer<typeof liveFrameSchema> & { id: string };
/** A single newest frame per registered executor/channel. Images never enter task checkpoints. */
export async function acceptDesktopFrame(
  registry: ExecutorRegistry,
  executorId: string,
  raw: unknown,
) {
  const frame = liveFrameSchema.parse(raw),
    registration = registry.registration(executorId);
  const delivery = await registry.delivery(registration.owner, frame.operationId),
    node = await registry.node(executorId);
  if (
    !node ||
    node.epoch !== frame.epoch ||
    !node.connected ||
    !node.reconciled ||
    delivery?.state !== "claimed" ||
    delivery.operation.executorId !== executorId ||
    delivery.operation.executorEpoch !== frame.epoch ||
    !["desktop", "browser"].includes(delivery.operation.kind) ||
    !delivery.operation.inspection ||
    delivery.operation.args.sessionId !== frame.sessionId ||
    delivery.operation.args.sessionGeneration !== frame.sessionGeneration
  )
    throw new AppError("Desktop frame has no current authenticated observation authority", 409);
  const id = `${executorId}:${delivery.operation.kind}`;
  const existing = await registry.db.get<LiveDesktopFrame>(
    registration.owner,
    "desktop-live-frames",
    id,
  );
  const value = { ...frame, id, observedAt: frame.observedAt ?? new Date().toISOString() };
  if (
    existing &&
    existing.epoch === frame.epoch &&
    existing.sessionGeneration === frame.sessionGeneration &&
    existing.sequence >= frame.sequence
  )
    throw new AppError("Desktop frame is older than the current image", 409);
  const saved = existing
    ? await registry.db.compareAndSwap(
        registration.owner,
        "desktop-live-frames",
        id,
        {
          epoch: existing.epoch,
          sequence: existing.sequence,
          sessionGeneration: existing.sessionGeneration,
        },
        value,
      )
    : await registry.db.insertIfAbsent(registration.owner, "desktop-live-frames", value);
  if (!saved) throw new AppError("A newer desktop frame arrived concurrently", 409);
  return { accepted: true, frameId: frame.frameId };
}
export async function loadLiveDesktopFrame(
  db: Store,
  owner: string,
  executorId: string,
  kind: string,
  operationId: string,
) {
  const frame = await db.get<LiveDesktopFrame>(
    owner,
    "desktop-live-frames",
    `${executorId}:${kind}`,
  );
  if (!frame || frame.operationId !== operationId)
    throw new AppError("Desktop image was superseded; observe a fresh frame", 409);
  return frame;
}
