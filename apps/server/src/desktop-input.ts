import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "./errors.ts";
import type { ExecutorRegistry } from "./executors/registry.ts";

type Payload = { owner: string; text: string; hash: string; expiresAt: number };
const payloads = new WeakMap<ExecutorRegistry, Map<string, Payload>>();

/** Native journals carry only a reference and digest. Text exists in server
 * memory for one authenticated consumption, then only in the private IPC. */
export function stageDesktopText(
  registry: ExecutorRegistry,
  owner: string,
  id: string,
  args: Record<string, unknown>,
) {
  const action = args.action as Record<string, unknown> | undefined;
  if (args.operation !== "act" || action?.action !== "type" || typeof action.text !== "string")
    return args;
  const digest = createHash("sha256").update(action.text).digest("hex");
  const reference = `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-8${id.slice(17, 20)}-${id.slice(20, 32)}`;
  let pending = payloads.get(registry);
  if (!pending) {
    pending = new Map();
    payloads.set(registry, pending);
  }
  for (const [key, value] of pending) if (value.expiresAt <= Date.now()) pending.delete(key);
  if (pending.size >= 64 && !pending.has(reference))
    throw new AppError("Desktop input delivery is busy", 503);
  pending.set(reference, {
    owner,
    text: action.text,
    hash: digest,
    expiresAt: Date.now() + 45_000,
  });
  return {
    ...args,
    action: {
      action: "type",
      textReference: reference,
      textHash: digest,
      length: action.text.length,
    },
  };
}

export async function consumeDesktopText(
  registry: ExecutorRegistry,
  executorId: string,
  raw: unknown,
) {
  const input = z
    .object({
      epoch: z.number().int().positive(),
      operationId: z.string().min(1).max(128),
      textReference: z.uuid(),
      sessionId: z.uuid(),
      sessionGeneration: z.uuid(),
    })
    .strict()
    .parse(raw);
  const registration = registry.registration(executorId),
    node = await registry.node(executorId);
  const delivery = await registry.delivery(registration.owner, input.operationId);
  const args = delivery?.operation.args,
    action = args?.action as Record<string, unknown> | undefined;
  if (
    !node ||
    node.epoch !== input.epoch ||
    !node.connected ||
    !node.reconciled ||
    delivery?.state !== "claimed" ||
    delivery.operation.executorId !== executorId ||
    delivery.operation.executorEpoch !== input.epoch ||
    delivery.operation.kind !== "desktop" ||
    args?.operation !== "act" ||
    args.sessionId !== input.sessionId ||
    args.sessionGeneration !== input.sessionGeneration ||
    action?.textReference !== input.textReference
  )
    throw new AppError("Desktop text has no current claimed operation", 403);
  // Recheck the same M4 effect and live resource fence immediately before bytes
  // leave memory. A revoked device/pause cannot consume a queued input payload.
  await registry.validateDispatch(registration.owner, delivery.operation);
  const pending = payloads.get(registry),
    value = pending?.get(input.textReference);
  if (
    !value ||
    value.owner !== registration.owner ||
    value.hash !== action.textHash ||
    value.expiresAt <= Date.now()
  )
    throw new AppError(
      "Desktop text expired or was already consumed; inspect before resending",
      409,
    );
  pending!.delete(input.textReference);
  return { text: value.text, textHash: value.hash };
}
