import type { AgentTask, TaskStep } from "../../../../packages/domain/src/agent.ts";
import { taskActivity } from "./task-activity.ts";
import type { JournalOperation } from "./task-journal.ts";

const terminal = new Set(["succeeded", "failed", "cancelled"]);
/** Project durable receipts, never elapsed time or a model's promise, into live progress. */
export function executionSteps(task: AgentTask, operations: JournalOperation[]): TaskStep[] {
  const steps = operations
    .filter(
      (op) =>
        !op.parentOperationId &&
        !/^(finish_task|todo_list|set_plan|read_runtime|search_tools|describe_tools|skills_|AGUI)/.test(
          op.toolName,
        ),
    )
    .map((op): TaskStep => {
      const receipt = op.receipt as
        | { error?: unknown; complete?: boolean; extraction?: { status?: string } }
        | undefined;
      const failed =
        op.status === "failed" ||
        op.status === "rejected_not_dispatched" ||
        Boolean(receipt?.error);
      const unresolved =
        op.status === "outcome_unknown" ||
        receipt?.complete === false ||
        ["incomplete", "partial", "blocked", "shell"].includes(receipt?.extraction?.status ?? "");
      const status: TaskStep["status"] = failed
        ? "failed"
        : op.status === "superseded"
          ? "cancelled"
          : unresolved
            ? "waiting"
            : op.status === "succeeded"
              ? "succeeded"
              : terminal.has(task.status)
                ? task.status === "cancelled"
                  ? "cancelled"
                  : "waiting"
                : [
                      "paused",
                      "waiting_input",
                      "waiting_approval",
                      "waiting_provider",
                      "waiting_global_pause",
                    ].includes(task.status)
                  ? "waiting"
                  : op.status === "queued"
                    ? "pending"
                    : "running";
      const args = op.args as { url?: string; query?: string; name?: string } | undefined;
      let detail = args?.query || args?.name || "";
      if (args?.url) {
        try {
          detail = new URL(args.url).hostname;
        } catch {
          /* No arbitrary tool internals in UI. */
        }
      }
      return {
        id: `execution:${op.id}`,
        title: taskActivity(op.toolName),
        status,
        ...(detail ? { detail: detail.slice(0, 180) } : {}),
      };
    });
  if (!steps.length)
    steps.push({
      id: "execution:prepare",
      title: "Preparing the requested work",
      status:
        task.status === "running"
          ? "running"
          : task.status === "succeeded"
            ? "succeeded"
            : task.status === "failed"
              ? "failed"
              : task.status === "cancelled"
                ? "cancelled"
                : "pending",
    });
  // A successful source read is not a successful delivery. Only the task's final
  // verification can complete this milestone, including historical tasks.
  steps.push({
    id: "execution:delivery",
    title: "Deliver the result",
    status:
      task.status === "succeeded"
        ? "succeeded"
        : task.status === "failed"
          ? "failed"
          : task.status === "cancelled"
            ? "cancelled"
            : task.status === "running" &&
                operations.some(
                  (op) =>
                    op.toolName === "finish_task" && ["dispatching", "running"].includes(op.status),
                )
              ? "running"
              : "pending",
  });
  return steps;
}

export function liveTaskPlan(task: AgentTask, operations: JournalOperation[]): TaskStep[] {
  const legacy = task.plan.every((step) =>
    ["Understand the outcome", "Plan the work", "Use connected tools", "Return a result"].includes(
      step.title,
    ),
  );
  // An unmaintained model list cannot hide the work that actually happened.
  return legacy || task.plan.every((step) => step.status === "pending")
    ? executionSteps(task, operations)
    : task.plan;
}
