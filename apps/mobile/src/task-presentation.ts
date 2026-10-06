import { googleOperationLabel } from "./external-action-preview";
import type { TaskOperationDetail } from "./task-operation-details";

export function showTaskDeliveryChecks(status: string) {
  return status !== "cancelled";
}
export function taskOutcomeHeading(status: string, actionStatus?: string) {
  if (actionStatus === "denied") return "Action declined";
  return (
    (
      {
        succeeded: "What was delivered",
        cancelled: "Task cancelled",
        failed: "What happened",
        waiting_approval: "Your approval is needed",
        waiting_input: "Your answer is needed",
      } as Record<string, string>
    )[status] ?? "Progress so far"
  );
}
type TimelineEvent = {
  id: string;
  title: string;
  date: string;
  kind: string;
  operationId?: string;
};
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function operationTitle(operation: TaskOperationDetail) {
  const args = object(operation.args);
  if (operation.toolName === "describe_google_workspace_tool") return "Check tool requirements";
  if (typeof args.toolId === "string")
    return googleOperationLabel(
      args.toolId,
      object(operation.receipt).status === "awaiting_review",
    );
  const names: Record<string, string> = {
    search_google_workspace_tools: "Choose Workspace tools",
    describe_google_workspace_tool: "Check tool requirements",
    list_connections: "Check connected accounts",
    gmail_draft: "Save email draft",
    search_web: "Searching sources",
    web_fetch: "Reading sources",
    generate_image: "Creating the image",
    image_generate: "Creating the image",
    finish_task: "Checking and preparing the delivery",
  };
  return names[operation.toolName];
}
/** Group repeated bookkeeping without dropping the individual inspectable events. */
export function taskTimeline<E extends TimelineEvent>(
  events: readonly E[],
  operations: readonly TaskOperationDetail[],
) {
  const byId = new Map(operations.map((op) => [op.id, op]));
  const rows: { id: string; title: string; events: E[] }[] = [];
  for (const event of [...events].sort((a, b) => a.date.localeCompare(b.date))) {
    const operation = event.operationId ? byId.get(event.operationId) : undefined;
    const title = (operation ? operationTitle(operation) : undefined) ?? event.title;
    const last = rows.at(-1);
    if (last?.title === title && event.kind === "step" && last.events.at(-1)?.kind === "step")
      last.events.push(event);
    else rows.push({ id: event.id, title, events: [event] });
  }
  return rows;
}
