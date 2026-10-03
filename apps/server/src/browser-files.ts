import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type BrowserUpload,
  browserUploadSchema,
} from "../../../packages/domain/src/browser-file.ts";
import { AppError } from "./errors.ts";
import type { ExecutorRegistry } from "./executors/registry.ts";

const pendingFiles = new WeakMap<
  ExecutorRegistry,
  Map<string, { owner: string; file: BrowserUpload; expiresAt: number }>
>();

/** Upload bytes never enter ExecutorRequest.args/native journals. Their bounded
 * memory payload can leave only for the exact claimed M4 operation, once. */
export function stageBrowserFile(
  registry: ExecutorRegistry,
  owner: string,
  id: string,
  args: Record<string, unknown>,
) {
  if (args.operation !== "upload") return args;
  const file = browserUploadSchema.parse(args.body);
  const bytes = Buffer.from(file.base64, "base64");
  if (
    bytes.length !== file.size ||
    createHash("sha256").update(bytes).digest("hex") !== file.sha256
  )
    throw new AppError("Browser upload bytes do not match the bound file", 422);
  const reference = `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-8${id.slice(17, 20)}-${id.slice(20, 32)}`;
  let pending = pendingFiles.get(registry);
  if (!pending) {
    pending = new Map();
    pendingFiles.set(registry, pending);
  }
  for (const [key, item] of pending) if (item.expiresAt <= Date.now()) pending.delete(key);
  if (pending.size >= 8 && !pending.has(reference))
    throw new AppError("Browser upload delivery is busy", 503);
  pending.set(reference, { owner, file, expiresAt: Date.now() + 45_000 });
  const { base64: _bytes, ...metadata } = file;
  return { ...args, body: { ...metadata, fileReference: reference } };
}

export async function consumeBrowserFile(
  registry: ExecutorRegistry,
  executorId: string,
  reference: string,
  raw: unknown,
) {
  z.uuid().parse(reference);
  const input = z
    .object({
      epoch: z.number().int().positive(),
      operationId: z.string().min(1).max(128),
      sessionId: z.uuid(),
      sessionGeneration: z.uuid(),
    })
    .strict()
    .parse(raw);
  const registration = registry.registration(executorId),
    node = await registry.node(executorId);
  const delivery = await registry.delivery(registration.owner, input.operationId);
  const args = delivery?.operation.args,
    body = args?.body as Record<string, unknown> | undefined;
  if (
    !node?.connected ||
    !node.reconciled ||
    node.epoch !== input.epoch ||
    delivery?.state !== "claimed" ||
    delivery.operation.executorId !== executorId ||
    delivery.operation.executorEpoch !== input.epoch ||
    delivery.operation.kind !== "browser" ||
    args?.operation !== "upload" ||
    args.browserSessionId !== input.sessionId ||
    args.sessionGeneration !== input.sessionGeneration ||
    body?.fileReference !== reference
  )
    throw new AppError("Browser upload has no current claimed operation", 403);
  await registry.validateDispatch(registration.owner, delivery.operation);
  const pending = pendingFiles.get(registry),
    value = pending?.get(reference);
  if (
    !value ||
    value.owner !== registration.owner ||
    value.expiresAt <= Date.now() ||
    value.file.sha256 !== body.sha256 ||
    value.file.snapshotId !== body.snapshotId ||
    value.file.element !== body.element
  )
    throw new AppError("Browser upload expired or was consumed; inspect before resending", 409);
  pending?.delete(reference);
  return value.file;
}
