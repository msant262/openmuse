import { randomUUID } from "node:crypto";
import type { ActionProposal } from "../../../../packages/domain/src/index.ts";
import type { AgentService } from "../engine/service.ts";
import { LostLeaseError } from "../engine/worker.ts";

export type NativeActionExecution = {
  id: string;
  actionId: string;
  hash: string;
  decision: "approve" | "deny";
};

/** HTTP review callbacks do not inherit a model run's journal scope. Admit a
 * separate server-owned run instead of inventing a lease or stealing that run.
 * This private record cannot be created through a model tool or a public route.
 */
export class ReviewedNativeActions {
  constructor(private readonly agent: AgentService) {}

  async run(
    owner: string,
    proposal: ActionProposal,
    decision: "approve" | "deny",
    execute: () => Promise<string>,
  ): Promise<string> {
    const task = await this.agent.createTask(
      owner,
      {
        title: decision === "approve" ? "Executar ação aprovada" : "Recusar confirmação",
        prompt:
          "Execute only the exact server-bound reviewed browser response and retain its receipt.",
        input: { internalActivity: true },
      },
      `native-review:${proposal.id}:${randomUUID()}`,
      true,
    );
    await this.agent.db.insertIfAbsent<NativeActionExecution>(owner, "native-action-executions", {
      id: task.id,
      actionId: proposal.id,
      hash: proposal.hash,
      decision,
    });
    let result: string | undefined;
    let failure: unknown;
    try {
      await this.agent.worker.runReviewedAction(owner, task, async (_owner, admitted, context) => {
        try {
          await context.guard();
          result = (await this.agent.journal.run(
            owner,
            admitted,
            {
              id: "reviewed-response",
              name: "reviewed_native_action",
              args: { actionId: proposal.id, hash: proposal.hash, decision },
            },
            execute,
            true,
          )) as string;
          return { status: "succeeded" };
        } catch (error) {
          failure = error;
          // Let TaskWorker classify pause, resource contention and uncertain
          // dispatch, including retaining the physical receipt's resource holds.
          throw error;
        }
      });
    } catch (error) {
      // An unadmitted attempt has no native effect and must not consume a
      // permanently paused task slot when the person retries a busy review.
      await this.agent.db.compareAndSwapTask(
        owner,
        task.id,
        { status: "paused", attempts: 0 },
        { status: "failed", error: error instanceof Error ? error.message : "Review unavailable" },
      );
      throw error;
    }
    if (failure !== undefined) throw failure;
    if (result === undefined) throw new LostLeaseError();
    return result;
  }
}
