import type { Message } from "@ag-ui/core";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type { ActionProposal } from "../../../../packages/domain/src/index.ts";
import type { Store } from "../db.ts";
import { publicJournalValue } from "./task-history.ts";
import type { JournalOperation } from "./task-journal.ts";

/** A saved tool reply records preparation, not the later human decision.
 * Project the current owned review into model history without rewriting either
 * the preparation receipt or a provider checkpoint. Never dispatch an effect.
 */
export async function reviewedActionHistory(
  db: Store,
  owner: string,
  task: AgentTask,
  messages: Message[],
  operations: JournalOperation[],
): Promise<Message[]> {
  const replacements = new Map<string, string>();
  await Promise.all(
    operations.map(async (operation) => {
      if (
        operation.taskId !== task.id ||
        operation.status !== "succeeded" ||
        operation.revision !== Number(task.state.appliedRevision ?? 0)
      )
        return;
      const pending = operation.receipt as
        | { actionId?: unknown; approvalRequired?: boolean }
        | undefined;
      if (pending?.approvalRequired !== true || typeof pending.actionId !== "string") return;
      const action = await db.get<ActionProposal>(owner, "actions", pending.actionId);
      if (
        !action ||
        action.taskId !== task.id ||
        ["awaiting_review", "executing"].includes(action.status) ||
        (action.dispatchedRevision ?? action.preparedRevision ?? 0) !== operation.revision
      )
        return;
      replacements.set(
        operation.toolCallId ?? operation.id,
        JSON.stringify(
          publicJournalValue({
            actionId: action.id,
            status: action.status,
            approvalRequired: false,
            result: action.result,
            error: action.error,
          }),
        ),
      );
    }),
  );
  return messages.map((message) => {
    if (message.role !== "tool") return message;
    const content = replacements.get(message.toolCallId);
    return content === undefined ? message : { ...message, content };
  });
}

export const REVIEWED_ACTION_REPORT = "reviewed-action-report";

/** Narrow contradiction guard for live approval-waiting prose. Historical
 * descriptions and explicit negation are not a claim of a currently open card.
 * Other incomplete work still follows its ordinary completion requirements.
 */
export function claimsPendingReview(text: string): boolean {
  return text.split(/[.!?;\n]+/).some((clause) => {
    if (
      /\b(?:n[aã]o|not|no longer|nicht|kein|j[aá]|already|bereits|was|estava|aguardava|wartete)\b/i.test(
        clause,
      )
    )
      return false;
    return /\b(?:aguardando|esperando|pendente(?:\s+de)?|awaiting|waiting\s+for|pending|wartet\s+auf)\b[^.!?;\n]{0,100}\b(?:aprova[çc][aã]o|confirma[çc][aã]o|approval|confirmation|Freigabe|Best[aä]tigung)\b/i.test(
      clause,
    );
  });
}
