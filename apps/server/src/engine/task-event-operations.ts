import type { RunEvent } from "../../../../packages/domain/src/agent.ts";
import { taskActivity } from "./task-activity.ts";
import type { JournalOperation } from "./task-journal.ts";

/** Attach saved receipts without inventing details for ambiguous historical events. */
export function taskEventOperations(
  events: RunEvent[],
  operations: JournalOperation[],
): RunEvent[] {
  const roots = operations.filter((op) => !op.parentOperationId);
  return events.map((event, index) => {
    if (event.kind !== "step" || event.operationId) return event;
    const next = events.slice(index + 1).find((e) => e.kind === "step");
    const matching = roots.filter(
      (op) =>
        op.taskId === event.taskId &&
        taskActivity(op.toolName) === event.title &&
        op.createdAt >= event.date &&
        (!next || op.createdAt < next.date),
    );
    return matching.length === 1 ? { ...event, operationId: matching[0].id } : event;
  });
}
