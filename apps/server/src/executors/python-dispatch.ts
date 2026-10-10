import type { ComputerPythonOptions } from "../computer-contract.ts";
import type { JournalOperation } from "../engine/task-journal.ts";
import { AppError } from "../errors.ts";
import type { ExecutorOperation } from "./protocol.ts";
import { nativePythonArgsSchema, pythonHostCallId, pythonRpcWire } from "./python-protocol.ts";
import { currentPythonRequest, releasePythonReply, stagePythonReply } from "./python-replies.ts";
import type { ExecutorRegistry } from "./registry.ts";

/** Drives an already owned cell. A failed acknowledgement never reruns its
 * source or tool callback. Source effects retain their ordinary host journals. */
export async function dispatchPythonRequests(
  registry: ExecutorRegistry,
  owner: string,
  parent: ExecutorOperation,
  options: ComputerPythonOptions,
  pollMs = 100,
) {
  const args = nativePythonArgsSchema.parse(parent.args);
  const deadline = Date.now() + args.timeoutMs + 10_000;
  let answered = 0;
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted();
    const delivery = await registry.delivery(owner, parent.id);
    if (!delivery)
      throw new AppError("Python cell delivery is missing; source will not be repeated", 503);
    if (delivery.receipt && delivery.receipt.status !== "running") return delivery.receipt;
    if (delivery.receipt?.data?.pythonRpc) {
      const request = await currentPythonRequest(registry, owner, parent);
      if (request.sequence > answered) {
        if (request.sequence !== answered + 1)
          throw new AppError("Python request sequence skipped a host acknowledgement", 409);
        const canonical = await registry.db.get<JournalOperation>(
          owner,
          "task-operations",
          parent.id,
        );
        const observed = canonical?.receipt as
          | { data?: { pythonRpc?: { sequence?: number; sha256?: string } } }
          | undefined;
        // Delivery and canonical authority are separate durable commits. Wait
        // for that observation, never repeat an effect to close the race.
        if (
          canonical?.status !== "running" ||
          observed?.data?.pythonRpc?.sequence !== request.sequence ||
          observed.data.pythonRpc.sha256 !== request.sha256
        ) {
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          continue;
        }
        let value: { result: unknown; continue: boolean } | { error: string; continue: boolean };
        if (!options.shouldContinue())
          value = {
            error: "The task has paused or finished; no further host tools may run.",
            continue: false,
          };
        else {
          try {
            value = {
              result: await options.call(parent, request),
              continue: options.shouldContinue(),
            };
          } catch (error) {
            value = {
              error: (error instanceof Error ? error.message : "Host tool failed").slice(0, 2000),
              continue: options.shouldContinue(),
            };
          }
        }
        // The physical cell may have timed out while a host effect settled.
        // Retain that host receipt; there is no second callback/source attempt.
        const replyArgs = await stagePythonReply(
          registry,
          owner,
          parent,
          pythonRpcWire(request),
          value,
        );
        try {
          const control = await registry.enqueue(
            owner,
            {
              id: `python-reply:${pythonHostCallId(parent.id, request)}`,
              executorId: parent.executorId,
              kind: "session",
              capability: "python",
              capabilityVersion: 1,
              inspection: true,
              args: replyArgs,
            },
            {
              kind: "task",
              taskId: canonical.taskId,
              desiredRevision: canonical.revision,
              runToken: canonical.runToken,
              resourceLeaseIds: canonical.resourceLeaseIds,
            },
          );
          const replyDeadline = Date.now() + 30_000;
          let acknowledged = false;
          while (Date.now() < replyDeadline) {
            options.signal?.throwIfAborted();
            const reply = await registry.delivery(owner, control.id);
            if (reply?.receipt && reply.receipt.status !== "running") {
              if (
                reply.receipt.status !== "succeeded" ||
                reply.receipt.data?.replyAccepted !== true
              )
                throw new AppError(
                  "Python private reply was not accepted; inspect before continuing",
                  503,
                );
              acknowledged = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, pollMs));
          }
          if (!acknowledged)
            throw new AppError(
              "Python private reply acknowledgement is pending; host effect will not be repeated",
              503,
            );
          answered = request.sequence;
        } finally {
          releasePythonReply(registry, replyArgs.replyReference);
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new AppError("Python execution receipt remains pending; source will not be repeated", 503);
}
