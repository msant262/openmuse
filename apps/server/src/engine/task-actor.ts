import type { Message } from "@ag-ui/core";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type { TaskBudget } from "../../../../packages/domain/src/runtime.ts";
import { bindingHash } from "../conversation-inbox.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { completedMessages, providerContinuationCheckpointSchema } from "./task-history.ts";
import type { TaskJournal } from "./task-journal.ts";
import type { TaskMailbox } from "./task-mailbox.ts";
import type { TaskContext } from "./worker.ts";

export class TaskBudgetExhaustedError extends AppError {
  constructor() {
    super(
      "The task's accumulated budget is exhausted. Saved progress is preserved; explicitly extend its budget to continue.",
      409,
    );
    this.name = "TaskBudgetExhaustedError";
  }
}
/** An actor is an adapter over M2 admission and M3 scheduler ownership. */
export class TaskActor {
  constructor(
    private readonly db: Store,
    readonly mailbox: TaskMailbox,
    readonly journal: TaskJournal,
  ) {}
  async wake(
    owner: string,
    taskId: string,
    _reason: "directive" | "job" | "resource" | "provider" | "children" | "routine",
  ) {
    const task = await this.db.get<AgentTask>(owner, "tasks", taskId);
    if (!task || ["succeeded", "failed", "cancelled", "paused", "running"].includes(task.status))
      return;
    if (task.status === "waiting_job") {
      await this.db.compareAndSwapTask(
        owner,
        taskId,
        { status: task.status },
        { nextRunAt: new Date().toISOString() },
      );
      return;
    }
    if (
      task.status === "waiting_provider" &&
      task.nextRunAt &&
      Date.parse(task.nextRunAt) > Date.now()
    )
      return;
    await this.db.compareAndSwapTask(
      owner,
      taskId,
      { status: task.status },
      { status: "queued", error: null },
    );
  }
  async apply(owner: string, task: AgentTask, ctx: TaskContext) {
    if (!task.leaseId) throw new AppError("Task lease is missing", 409);
    await this.mailbox.apply(owner, task.id, task.leaseId);
    return ctx.checkpoint({});
  }
  async beforeInference(owner: string, task: AgentTask, ctx: TaskContext, elapsedMs = 0) {
    const rootId = typeof task.state.rootTaskId === "string" ? task.state.rootTaskId : task.id;
    const budget = await this.db.consumeTaskBudget<TaskBudget>(owner, rootId, elapsedMs);
    if (!budget) throw new TaskBudgetExhaustedError();
    return ctx.checkpoint({ state: { ...task.state, budget } });
  }
  async chargeElapsed(owner: string, task: AgentTask, elapsedMs: number) {
    return this.db.chargeTaskBudget<TaskBudget>(
      owner,
      typeof task.state.rootTaskId === "string" ? task.state.rootTaskId : task.id,
      elapsedMs,
    );
  }
  async history(owner: string, task: AgentTask): Promise<Message[]> {
    const journal = await this.journal.history(owner, task.id);
    if (!task.state.providerCheckpoint) return journal;
    const provider = providerContinuationCheckpointSchema.parse(task.state.providerCheckpoint);
    const ops = await this.journal.operations(owner, task.id);
    const known = new Set(
      ops
        .filter(
          (op) =>
            op.receipt !== undefined &&
            ["succeeded", "failed", "rejected_not_dispatched", "superseded"].includes(op.status),
        )
        .flatMap((op) => [op.id, op.toolCallId ?? op.id]),
    );
    const authorized = provider.messages
      .filter((message) => message.role !== "tool" || known.has(message.toolCallId))
      .map((message) =>
        message.role === "assistant" && message.toolCalls
          ? { ...message, toolCalls: message.toolCalls.filter((call) => known.has(call.id)) }
          : message,
      );
    const completed = completedMessages(authorized);
    const calls = new Set(
      completed.flatMap((m) =>
        m.role === "assistant" ? (m.toolCalls?.map((call) => call.id) ?? []) : [],
      ),
    );
    const extra = journal.filter((m) =>
      m.role === "tool"
        ? !calls.has(m.toolCallId)
        : m.role === "assistant"
          ? m.toolCalls?.every((call) => !calls.has(call.id))
          : false,
    );
    return completedMessages([...completed, ...extra]);
  }
  async extendBudget(
    owner: string,
    taskId: string,
    input: {
      requestId: string;
      expectedRevision: number;
      additionalSteps: number;
      additionalMilliseconds?: number;
    },
  ) {
    if (
      !Number.isInteger(input.additionalSteps) ||
      input.additionalSteps < 1 ||
      input.additionalSteps > 10000
    )
      throw new AppError("Choose a positive budget extension", 422);
    const task = await this.db.get<AgentTask>(owner, "tasks", taskId);
    if (!task) throw new AppError("Task not found", 404);
    const rootId = typeof task.state.rootTaskId === "string" ? task.state.rootTaskId : task.id;
    const requestKey = `task-budget:${taskId}:${input.requestId}`;
    const previous = await this.db.get<{ bindingHash: string; result: { values: TaskBudget[] } }>(
      owner,
      "mutation-receipts",
      requestKey,
    );
    if (previous) {
      if (previous.bindingHash !== bindingHash(input))
        throw new AppError("Request key belongs to another budget change", 409);
      return previous.result.values[0];
    }
    const budget = await this.db.get<TaskBudget>(owner, "task-budgets", rootId);
    if (!budget) throw new AppError("Task has no accumulated budget", 409);
    const maxSteps = budget.maxSteps + input.additionalSteps;
    if (maxSteps > 10000)
      throw new AppError("The total task budget cannot exceed 10000 steps", 422);
    if (
      input.additionalMilliseconds !== undefined &&
      (!Number.isSafeInteger(input.additionalMilliseconds) ||
        input.additionalMilliseconds < 1 ||
        input.additionalMilliseconds > 86400000)
    )
      throw new AppError("Choose a bounded positive time extension", 422);
    const next = {
      revision: input.expectedRevision + 1,
      maxSteps,
      maxMilliseconds: budget.maxMilliseconds + (input.additionalMilliseconds ?? 0),
    };
    const saved = await this.db.durableMutation<TaskBudget>(owner, requestKey, bindingHash(input), [
      {
        kind: "task-budgets",
        id: rootId,
        mode: "merge",
        expected: { revision: input.expectedRevision },
        value: next,
      },
      ...(task.status === "waiting_input" && task.state.budgetExhausted === true
        ? [
            {
              kind: "tasks",
              id: taskId,
              mode: "merge" as const,
              expected: { status: task.status, state: task.state },
              value: {
                status: "queued",
                error: null,
                state: { ...task.state, budgetExhausted: false },
              },
            },
          ]
        : []),
    ]);
    if (saved.status === "binding_conflict")
      throw new AppError("Request key belongs to another budget change", 409);
    if (saved.status === "revision_conflict")
      throw new AppError("Budget changed; refresh and try again", 409);
    return saved.values[0];
  }
}
