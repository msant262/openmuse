import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import { completionAssessmentSchema } from "../../../../packages/domain/src/runtime.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { KanbanExecution } from "./kanban-tools.ts";
import { type KanbanCard, KanbanWorkflow } from "./kanban-workflow.ts";
import type { TaskJournal } from "./task-journal.ts";

/** One host-owned wall-clock limit per canonical run, not per worker poll. */
export type TaskRuntimeLimit = { maxMilliseconds: number; deadlineAt: number };

export class TaskRuntimeExpiredError extends Error {
  constructor(
    readonly limit: TaskRuntimeLimit,
    detail?: string,
  ) {
    super(
      detail ??
        `O tempo configurado para esta execução (${limit.maxMilliseconds / 1000} segundos) terminou. A tarefa foi interrompida; resultados já registrados foram preservados.`,
    );
    this.name = "TaskRuntimeExpiredError";
  }
}

export function taskRuntimeLimit(
  seconds: number | undefined,
  startedAt = Date.now(),
): TaskRuntimeLimit | undefined {
  if (seconds === undefined) return undefined;
  const maxMilliseconds = seconds * 1000;
  const deadlineAt = startedAt + maxMilliseconds;
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < 1 ||
    !Number.isSafeInteger(maxMilliseconds) ||
    !Number.isSafeInteger(deadlineAt)
  )
    throw new AppError(
      "Choose a positive runtime whose milliseconds can be represented exactly",
      422,
    );
  return { maxMilliseconds, deadlineAt };
}

/** Configuration is written atomically by the dispatcher, never read from model input. */
export async function kanbanRuntimeLimit(
  db: Store,
  owner: string,
  task: AgentTask,
  journal: Pick<TaskJournal, "operations">,
) {
  const execution = await db.get<KanbanExecution>(owner, "kanban-executions", task.id);
  if (!execution || execution.id !== task.id || !execution.configuration?.runtime) return undefined;
  const revision = Number(task.state.appliedRevision ?? 0);
  // A committed handoff needs only acknowledgment. Runtime expiration must
  // not turn already proved delivery into failure or repeat its effects.
  if (
    task.completion?.status === "verified" &&
    task.state.verificationRevision === revision &&
    Number(task.state.desiredRevision ?? 0) === revision
  ) {
    const card = await db.get<KanbanCard>(
      owner,
      `kanban-cards:${execution.board}`,
      execution.cardId,
    );
    if (
      card &&
      ["done", "review"].includes(card.status) &&
      card.currentRun?.id !== execution.runId
    ) {
      const workflow = new KanbanWorkflow(db, owner, execution.board, {
        profileExists: async (name) =>
          name === "default" || Boolean(await db.get(owner, "execution-profiles", name)),
      });
      for (const operation of (await journal.operations(owner, task.id)).toReversed()) {
        if (
          operation.revision !== revision ||
          !["finish_task", "kanban_complete", "kanban_request_review"].includes(operation.toolName)
        )
          continue;
        const saved = await workflow.handoffAcknowledgment(
          {
            role: "worker",
            profile: execution.profile,
            taskId: execution.cardId,
            runId: execution.runId,
          },
          `${task.id}:${operation.id}`,
        );
        const native = saved?.values.find(
          (value): value is AgentTask =>
            !!value &&
            typeof value === "object" &&
            "id" in value &&
            value.id === task.id &&
            "state" in value &&
            "completion" in value,
        );
        const proof = completionAssessmentSchema.safeParse(native?.completion);
        if (
          proof.success &&
          proof.data.status === "verified" &&
          native?.state.verificationRevision === revision
        )
          return undefined;
      }
    }
  }
  return execution.configuration.runtime;
}

/** Bind the physical timeout before the native request and Python cell are journaled. */
export function physicalRuntimeMs(
  requested: number,
  remaining: number | undefined,
  minimum = 1,
): number {
  if (remaining === undefined) return requested;
  if (remaining < minimum)
    throw new TaskRuntimeExpiredError(
      { maxMilliseconds: 0, deadlineAt: Date.now() },
      "O tempo restante desta execução não permite iniciar a próxima operação. A tarefa foi interrompida; resultados já registrados foram preservados.",
    );
  return Math.min(requested, Math.floor(remaining));
}
