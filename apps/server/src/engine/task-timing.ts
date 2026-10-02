import { z } from "zod";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import { taskTimingSchema } from "../../../../packages/domain/src/runtime.ts";
import { taskInstant } from "../../../../packages/domain/src/task-time.ts";
import { bindingHash } from "../conversation-inbox.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";

export class TaskValidityExpiredError extends AppError {
  constructor() {
    super(
      "The requested action is no longer valid. Saved work is preserved; confirm a new validity before sending.",
      409,
    );
    this.name = "TaskValidityExpiredError";
  }
}
export const taskTimingUpdateSchema = taskTimingSchema
  .partial()
  .extend({
    dueAt: z.string().nullable().optional(),
    validUntil: z.string().nullable().optional(),
    expectedRevision: z.number().int().nonnegative(),
    requestId: z.string().min(1).max(256),
  })
  .strict();
export class TaskTiming {
  constructor(
    private readonly db: Store,
    private readonly timezone = "Europe/Berlin",
  ) {}
  async update(owner: string, taskId: string, raw: unknown) {
    const { expectedRevision, requestId, ...patch } = taskTimingUpdateSchema.parse(raw);
    const task = await this.db.get<AgentTask>(owner, "tasks", taskId);
    if (!task) throw new AppError("Task not found", 404);
    const previous = await this.db.get<{ bindingHash: string; result: { values: AgentTask[] } }>(
      owner,
      "mutation-receipts",
      `task-timing:${taskId}:${requestId}`,
    );
    if (previous) {
      if (previous.bindingHash !== bindingHash(raw))
        throw new AppError("Request key belongs to another timing change", 409);
      return previous.result.values[0];
    }
    if (Number(task.state.timingRevision ?? 0) !== expectedRevision)
      throw new AppError("Timing changed; refresh and try again", 409);
    const timezone = patch.timezone ?? task.timing?.timezone ?? this.timezone;
    const normalized = {
      ...patch,
      ...(patch.dueAt !== undefined
        ? { dueAt: patch.dueAt === null ? undefined : taskInstant(patch.dueAt, timezone) }
        : {}),
      ...(patch.validUntil !== undefined
        ? {
            validUntil:
              patch.validUntil === null ? undefined : taskInstant(patch.validUntil, timezone),
          }
        : {}),
    };
    const timing = taskTimingSchema.parse({
      priority: "normal",
      timezone: this.timezone,
      ...task.timing,
      ...normalized,
    });
    const result = await this.db.durableMutation<AgentTask>(
      owner,
      `task-timing:${taskId}:${requestId}`,
      bindingHash(raw),
      [
        {
          kind: "tasks",
          id: taskId,
          mode: "merge",
          expected: { timing: task.timing, state: task.state },
          value: {
            timing,
            state: { ...task.state, timingRevision: expectedRevision + 1 },
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    );
    if (result.status === "binding_conflict")
      throw new AppError("Request key belongs to another timing change", 409);
    if (result.status === "revision_conflict")
      throw new AppError("Task changed; refresh and try again", 409);
    return result.values[0];
  }
}
