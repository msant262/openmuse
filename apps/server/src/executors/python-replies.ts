import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors.ts";
import type { ExecutorOperation } from "./protocol.ts";
import { safeOperationId } from "./protocol.ts";
import {
  nativePythonArgsSchema,
  nativePythonReplyArgsSchema,
  PYTHON_WIRE_BYTES,
  type PythonReplyValue,
  parsePythonRpc,
  pythonReplyValueSchema,
} from "./python-protocol.ts";
import type { ExecutorRegistry } from "./registry.ts";

type Grant = {
  owner: string;
  parent: ExecutorOperation;
  args: z.infer<typeof nativePythonReplyArgsSchema>;
  json: string;
  expiresAt: number;
  claimedBy?: string;
};
const grants = new WeakMap<ExecutorRegistry, Map<string, Grant>>();
const hash = (json: string) => createHash("sha256").update(json).digest("hex");
function currentGrants(registry: ExecutorRegistry) {
  let pending = grants.get(registry);
  if (!pending) {
    pending = new Map();
    grants.set(registry, pending);
  }
  for (const [id, grant] of pending) if (grant.expiresAt <= Date.now()) pending.delete(id);
  return pending;
}

/** A private reply is subordinate to one currently claimed cell and its root-
 * generated request. This also refreshes the canonical task/run/resource fence. */
export async function currentPythonRequest(
  registry: ExecutorRegistry,
  owner: string,
  parent: ExecutorOperation,
) {
  const registration = registry.registration(parent.executorId);
  if (registration.owner !== owner) throw new AppError("Python cell belongs to another owner", 403);
  const node = await registry.node(parent.executorId);
  const delivery = await registry.delivery(owner, parent.id);
  if (
    !node?.connected ||
    !node.reconciled ||
    node.epoch !== parent.executorEpoch ||
    delivery?.state !== "claimed" ||
    delivery.operation.bindingHash !== parent.bindingHash ||
    delivery.operation.executorId !== parent.executorId ||
    delivery.operation.executorEpoch !== parent.executorEpoch ||
    delivery.operation.kind !== "command" ||
    delivery.operation.capability !== "python" ||
    delivery.operation.capabilityVersion !== 1 ||
    delivery.receipt?.status !== "running"
  )
    throw new AppError("Python cell has no current claimed request", 409);
  const cell = nativePythonArgsSchema.parse(delivery.operation.args).pythonCell;
  const request = parsePythonRpc(delivery.receipt.data?.pythonRpc);
  if (
    cell.owner !== owner ||
    !cell.tools.includes(request.name) ||
    request.sequence > cell.maxToolCalls
  )
    throw new AppError("Python request is outside the cell's bound tool catalog", 403);
  await registry.validateDispatch(owner, delivery.operation);
  return request;
}

/** Full tool output is private and bounded; canonical control envelopes carry
 * only a reference/digest. A restart loses this grant and never replays code. */
export async function stagePythonReply(
  registry: ExecutorRegistry,
  owner: string,
  parent: ExecutorOperation,
  rawRequest: unknown,
  value: PythonReplyValue,
) {
  const expected = parsePythonRpc(rawRequest);
  const current = await currentPythonRequest(registry, owner, parent);
  if (
    current.sequence !== expected.sequence ||
    current.sha256 !== expected.sha256 ||
    current.json !== expected.json
  )
    throw new AppError("Python tool request changed before its reply", 409);
  const normalized =
    "result" in value && value.result === undefined ? { ...value, result: null } : value;
  const json = JSON.stringify(pythonReplyValueSchema.parse(normalized));
  if (Buffer.byteLength(json) > PYTHON_WIRE_BYTES)
    throw new AppError("Python tool reply exceeds its private byte budget", 413);
  pythonReplyValueSchema.parse(JSON.parse(json));
  const pending = currentGrants(registry);
  if (pending.size >= 8) throw new AppError("Python private reply delivery is busy", 503);
  const args = nativePythonReplyArgsSchema.parse({
    operation: "python-reply",
    operationId: parent.id,
    requestSequence: current.sequence,
    requestHash: current.sha256,
    replyReference: randomUUID(),
    replyHash: hash(json),
    replyBytes: Buffer.byteLength(json),
  });
  pending.set(args.replyReference, { owner, parent, args, json, expiresAt: Date.now() + 45_000 });
  return args;
}

export function releasePythonReply(registry: ExecutorRegistry, reference: string) {
  grants.get(registry)?.delete(reference);
}

export async function consumePythonReply(
  registry: ExecutorRegistry,
  executorId: string,
  reference: string,
  raw: unknown,
) {
  z.uuid().parse(reference);
  const input = z
    .object({
      epoch: z.number().int().positive(),
      operationId: safeOperationId,
      parentOperationId: safeOperationId,
      requestSequence: z.number().int().min(1).max(200),
    })
    .strict()
    .parse(raw);
  const registration = registry.registration(executorId);
  const delivery = await registry.delivery(registration.owner, input.operationId);
  if (
    delivery?.state !== "claimed" ||
    delivery.operation.kind !== "session" ||
    delivery.operation.capability !== "python" ||
    delivery.operation.capabilityVersion !== 1 ||
    !delivery.operation.inspection ||
    delivery.operation.executorId !== executorId ||
    delivery.operation.executorEpoch !== input.epoch
  )
    throw new AppError("Python reply has no current claimed control", 403);
  const args = nativePythonReplyArgsSchema.parse(delivery.operation.args);
  if (
    args.replyReference !== reference ||
    args.operationId !== input.parentOperationId ||
    args.requestSequence !== input.requestSequence
  )
    throw new AppError("Python reply control request binding changed", 403);
  const grant = currentGrants(registry).get(reference);
  if (!grant || grant.owner !== registration.owner || grant.expiresAt <= Date.now())
    throw new AppError(
      "Python reply expired or is unavailable; the host effect must not be replayed",
      409,
    );
  const parent = grant.parent;
  if (
    parent.executorId !== executorId ||
    parent.executorEpoch !== input.epoch ||
    parent.id !== input.parentOperationId ||
    parent.taskId !== delivery.operation.taskId ||
    parent.revision !== delivery.operation.revision ||
    parent.resourceKey !== delivery.operation.resourceKey ||
    parent.resourceFence !== delivery.operation.resourceFence ||
    grant.args.requestSequence !== args.requestSequence ||
    grant.args.requestHash !== args.requestHash ||
    grant.args.replyHash !== args.replyHash ||
    grant.args.replyBytes !== args.replyBytes ||
    hash(grant.json) !== args.replyHash ||
    Buffer.byteLength(grant.json) !== args.replyBytes ||
    (grant.claimedBy !== undefined && grant.claimedBy !== input.operationId)
  )
    throw new AppError("Python private reply binding changed", 409);
  const current = await currentPythonRequest(registry, registration.owner, parent);
  if (current.sequence !== args.requestSequence || current.sha256 !== args.requestHash)
    throw new AppError("Python reply is no longer for the current tool request", 409);
  await registry.validateDispatch(registration.owner, delivery.operation);
  // An identical claimed control may recover a dropped HTTP response, without
  // executing the host tool again. Another control cannot consume this grant.
  grant.claimedBy = input.operationId;
  return { json: grant.json };
}
