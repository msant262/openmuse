import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import { bindingHash } from "../conversation-inbox.ts";
import { AppError } from "../errors.ts";
import type { ExecutorOperation } from "../executors/protocol.ts";
import {
  nativePythonArgsSchema,
  type PythonRpc,
  parsePythonRpc,
  pythonHostCallId,
  pythonResourceKey,
  pythonRpcSchema,
} from "../executors/python-protocol.ts";
import type { JournalOperation, TaskJournal } from "./task-journal.ts";

type Frame = { journal: TaskJournal; owner: string; parent: ExecutorOperation; request: PythonRpc };
const hostCallScope = new AsyncLocalStorage<Frame>();

async function validate(frame: Frame) {
  const { journal, owner, parent, request } = frame;
  const stored = await journal.db.get<JournalOperation>(owner, "task-operations", parent.id);
  if (
    stored?.status !== "running" ||
    stored.bindingHash !== parent.bindingHash ||
    stored.executorId !== parent.executorId ||
    stored.executorEpoch !== parent.executorEpoch ||
    stored.taskId !== parent.taskId ||
    stored.revision !== parent.revision ||
    stored.resourceFence !== parent.resourceFence ||
    stored.nativeEnvelope?.kind !== "command" ||
    stored.nativeEnvelope.capability !== "python" ||
    stored.nativeEnvelope.capabilityVersion !== 1 ||
    stored.nativeEnvelope.resourceKey !== parent.resourceKey
  )
    throw new AppError("Python host call has no current canonical parent scope", 409);
  const cell = nativePythonArgsSchema.parse(stored.args).pythonCell;
  if (
    cell.owner !== owner ||
    parent.resourceKey !== pythonResourceKey(parent.executorId, owner, cell.sessionId) ||
    !cell.tools.includes(request.name) ||
    request.sequence > cell.maxToolCalls
  )
    throw new AppError("Python host call is outside the owned tool catalog", 403);
  const receipt = stored.receipt as { status?: string; data?: { pythonRpc?: unknown } } | undefined;
  if (receipt?.status !== "running")
    throw new AppError("Python parent request receipt is no longer current", 409);
  // Canonical presentation history intentionally clips long JSON strings. Its
  // sequence/digest, not that clipped preview, binds the complete private RPC.
  const current = pythonRpcSchema.parse(receipt.data?.pythonRpc);
  if (current.sequence !== request.sequence || current.sha256 !== request.sha256)
    throw new AppError("Python host request changed during execution", 409);
  await journal.authorizeDispatch(
    owner,
    stored.id,
    stored.revision,
    stored.runToken,
    undefined,
    true,
  );
  return stored;
}

/** Only API composition can enter this scope after receiving a native request.
 * The child kernel supplies no host operation IDs or pending-effect exemptions. */
export async function withNativePythonHostCall<T>(
  journal: TaskJournal,
  owner: string,
  parent: ExecutorOperation,
  rawRequest: unknown,
  execute: () => Promise<T>,
) {
  const frame = { journal, owner, parent, request: parsePythonRpc(rawRequest) };
  await validate(frame);
  return hostCallScope.run(frame, execute);
}

/** The ordinary dispatcher may ignore its own waiting native cell, once, for
 * this exact tool call. All other pending/uncertain effects still block it. */
export async function nativePythonParentForCall(
  journal: TaskJournal,
  owner: string,
  task: AgentTask,
  call: { id: string; toolCallId?: string; name: string; args: unknown },
) {
  const frame = hostCallScope.getStore();
  if (!frame) return undefined;
  if (
    frame.journal !== journal ||
    frame.owner !== owner ||
    frame.parent.taskId !== task.id ||
    frame.parent.revision !== Number(task.state.appliedRevision ?? 0) ||
    (call.toolCallId ?? call.id) !== pythonHostCallId(frame.parent.id, frame.request) ||
    call.name !== frame.request.name ||
    bindingHash({ name: call.name, args: call.args }) !==
      bindingHash({ name: frame.request.name, args: frame.request.args })
  )
    throw new AppError("Python host call binding does not match its trusted request scope", 403);
  const parent = await validate(frame);
  if (parent.runToken !== task.leaseId)
    throw new AppError("Python host call task run changed", 409);
  return parent.id;
}
