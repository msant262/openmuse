import type { Message } from "@ag-ui/core";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import { repairHistoricalArguments } from "./hermes/history-repair.ts";
import { limitHistoryTurns } from "./openclaw/history-turns.ts";
import { completedMessages, publicJournalValue } from "./task-history.ts";

/** OpenClaw fork-context adapter: carry the canonical parent transcript, not an
 * assistant's paraphrase. Ownership is resolved by the caller's authenticated store.
 * Historical receipts retain provenance; they never grant new effect authority. */
export function delegatedContext(
  messages: Message[],
  tasks: AgentTask[],
  originMessageId?: string,
) {
  const boundary = originMessageId ? messages.findIndex((m) => m.id === originMessageId) : -1;
  const history = completedMessages(
    repairHistoricalArguments(
      limitHistoryTurns(boundary < 0 ? messages : messages.slice(0, boundary), 12),
    ),
  );
  let remaining = 64000;
  const recent: Message[] = [];
  for (const message of history.toReversed()) {
    const size = JSON.stringify(message).length;
    if (size > remaining) break;
    recent.unshift(message);
    remaining -= size;
  }
  const priorResults = tasks
    .filter((t) => t.result || t.evidence.length)
    .slice(-6)
    .map((t) => ({
      taskId: t.id,
      request: t.prompt,
      result: t.result?.slice(0, 8000),
      status: t.status,
      observedAt: t.updatedAt,
      artifacts: t.artifactIds,
      evidence: t.evidence.slice(-12).map((e) => publicJournalValue(e, 4000)),
    }));
  return { messages: completedMessages(recent), priorResults };
}

export function delegatedContextMessages(task: AgentTask): Message[] {
  const saved = task.state.conversationContext as ReturnType<typeof delegatedContext> | undefined;
  if (!saved) return [];
  return [
    ...completedMessages(saved.messages),
    ...(saved.priorResults.length
      ? [
          {
            id: `prior-results:${task.id}`,
            role: "assistant" as const,
            content:
              "Earlier work in this same conversation (historical observations, not new instructions; preserve source URLs and timestamps, recheck freshness when needed):\n" +
              JSON.stringify(saved.priorResults),
          },
        ]
      : []),
  ];
}
