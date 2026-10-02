import { createHash, randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import type { Routine } from "../../../packages/domain/src/agent.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

export const routineInput = z
  .object({
    title: z.string().trim().min(1).max(160),
    prompt: z.string().trim().min(1).max(12000),
    cron: z.string().trim().min(1).max(120),
    timezone: z.string().max(100).optional(),
    enabled: z.boolean().default(true),
  })
  .strict();

export const routinePatch = routineInput.extend({ enabled: z.boolean() }).partial();

export function nextRoutineRun(cron: string, timezone: string, now: number): string {
  if (cron.trim().split(/\s+/).length !== 5 || !/^[\d*,/\s-]+$/.test(cron))
    throw new AppError("Use five numeric cron fields (minute, hour, day, month, weekday)", 422);
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch {
    throw new AppError("Enter a valid IANA timezone", 422);
  }
  try {
    return CronExpressionParser.parse(cron, { tz: timezone, currentDate: now })
      .next()
      .toDate()
      .toISOString();
  } catch {
    throw new AppError("Invalid cron schedule", 422);
  }
}
export class RoutinesService {
  constructor(
    private readonly db: Store,
    private readonly enqueue: (
      owner: string,
      input: unknown,
      key: string,
    ) => Promise<{ id: string }>,
    readonly timezone = "UTC",
    private readonly now = Date.now,
    private readonly onBlocked?: (owner: string, routine: Routine, taskId: string) => Promise<void>,
  ) {
    nextRoutineRun("0 8 * * *", timezone, now());
  }
  async list(owner: string) {
    return (await this.db.list<Routine & { deleted?: boolean }>(owner, "routines")).filter(
      (value) => !value.deleted,
    );
  }
  async get(owner: string, id: string) {
    const value = await this.db.get<Routine & { deleted?: boolean }>(owner, "routines", id);
    if (!value || value.deleted) throw new AppError("Routine not found", 404);
    return value;
  }
  async create(owner: string, raw: unknown, key?: string) {
    const input = routineInput.parse(raw),
      timezone = input.timezone ?? this.timezone;
    const now = new Date(this.now()).toISOString();
    const id = key ? createHash("sha256").update(`routine:${key}`).digest("hex") : randomUUID();
    const value: Routine = {
      ...input,
      id,
      timezone,
      revision: 1,
      nextRunAt: nextRoutineRun(input.cron, timezone, this.now()),
      createdAt: now,
      updatedAt: now,
      pending: null,
    };
    const winner =
      (await this.db.insertIfAbsent(owner, "routines", value)) ??
      (await this.db.get<Routine & { deleted?: boolean }>(owner, "routines", id));
    if (!winner || ("deleted" in winner && winner.deleted))
      throw new AppError("Routine was deleted; use a new request key", 409);
    if (
      ["title", "prompt", "cron", "timezone", "enabled"].some(
        (k) => winner[k as keyof Routine] !== value[k as keyof Routine],
      )
    )
      throw new AppError("Routine request key belongs to different details", 409);
    return winner;
  }

  async update(owner: string, id: string, raw: unknown) {
    const patch = routinePatch.parse(raw),
      previous = await this.get(owner, id);
    if (previous.pending && patch.enabled !== false)
      throw new AppError("Routine is scheduling a run; retry shortly", 409);
    const merged = { ...previous, ...patch };
    const saved = await this.db.compareAndSwap<Routine>(
      owner,
      "routines",
      id,
      { revision: previous.revision, pending: previous.pending },
      {
        ...patch,
        ...(patch.enabled === false ? { pending: null } : {}),
        revision: previous.revision + 1,
        nextRunAt: nextRoutineRun(merged.cron, merged.timezone, this.now()),
        updatedAt: new Date(this.now()).toISOString(),
      },
    );
    if (!saved) throw new AppError("Routine changed; refresh and retry", 409);
    return saved;
  }
  async remove(owner: string, id: string) {
    // Tombstone prevents a racing scheduler from creating future slots. Queued tasks remain cancellable.
    const value = await this.get(owner, id);
    if (
      !(await this.db.compareAndSwap(
        owner,
        "routines",
        id,
        { revision: value.revision, pending: value.pending },
        { enabled: false, deleted: true, pending: null, revision: value.revision + 1 },
      ))
    )
      throw new AppError("Routine changed; refresh and retry", 409);
  }
  async tick() {
    for (const { owner, value: initial } of await this.db.scan<Routine & { deleted?: boolean }>(
      "routines",
    )) {
      let value = initial;
      if (value.deleted || !value.enabled) continue;
      if (value.blockedTaskId) await this.onBlocked?.(owner, value, value.blockedTaskId);
      if (!value.pending && Date.parse(value.nextRunAt) <= this.now()) {
        const previousTask = value.lastTaskId
          ? await this.db.get<{ status: string }>(owner, "tasks", value.lastTaskId)
          : null;
        const busy =
          previousTask && !["succeeded", "failed", "cancelled"].includes(previousTask.status);
        // One latest due slot after downtime; don't send a backlog of old external actions.
        const slot = CronExpressionParser.parse(value.cron, {
          tz: value.timezone,
          currentDate: this.now() + 1,
        })
          .prev()
          .toDate()
          .toISOString();
        const pending = busy
          ? null
          : {
              key: createHash("sha256")
                .update(`routine:${owner}:${value.id}:${value.revision}:${slot}`)
                .digest("hex"),
              slot,
              prompt: value.prompt,
              title: value.title,
              revision: value.revision,
            };
        const claimed = await this.db.compareAndSwap<Routine>(
          owner,
          "routines",
          value.id,
          { enabled: true, revision: value.revision, nextRunAt: value.nextRunAt, pending: null },
          busy
            ? {
                nextRunAt: nextRoutineRun(value.cron, value.timezone, this.now()),
                skipped: (value.skipped ?? 0) + 1,
                blockedTaskId: value.lastTaskId,
              }
            : { pending, blockedTaskId: null },
        );
        if (!claimed) continue;
        if (busy) {
          if (claimed.blockedTaskId) await this.onBlocked?.(owner, claimed, claimed.blockedTaskId);
          continue;
        }
        value = claimed;
      }
      if (!value.pending) continue;
      const pending = value.pending;
      const latest = await this.db.get<Routine & { deleted?: boolean }>(
        owner,
        "routines",
        value.id,
      );
      if (
        !latest?.enabled ||
        latest.deleted ||
        latest.revision !== value.revision ||
        latest.pending?.key !== pending.key
      )
        continue;
      const task = await this.enqueue(
        owner,
        {
          title: pending.title,
          prompt: pending.prompt,
          kind: "agent",
          input: { routineId: value.id, routineRevision: pending.revision, slotUtc: pending.slot },
        },
        pending.key,
      );
      await this.db.compareAndSwap(
        owner,
        "routines",
        value.id,
        { revision: value.revision, pending },
        {
          pending: null,
          lastTaskId: task.id,
          nextRunAt: nextRoutineRun(value.cron, value.timezone, this.now()),
          updatedAt: new Date(this.now()).toISOString(),
        },
      );
    }
  }
}
