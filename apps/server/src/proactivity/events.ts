import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentMemory, AgentTask } from "../../../../packages/domain/src/agent.ts";
import type { ProactivityCycle } from "../../../../packages/domain/src/proactivity.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";

const eventInput = z
  .object({
    source: z.enum(["memory", "task", "goal", "mail", "calendar", "deadline"]),
    key: z.string().min(1).max(500),
    revision: z.string().min(1).max(256),
    dueAt: z.iso.datetime({ offset: true }).optional(),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    observedAt: z.iso.datetime({ offset: true }).optional(),
    intent: z.enum(["immediate", "event", "scheduled"]).default("event"),
  })
  .strict();
export type WakeEvent = z.infer<typeof eventInput> & {
  id: string;
  status: "pending" | "claimed" | "settled";
  readyAt: string;
  createdAt: string;
  attempts: number;
  cycleId?: string;
  reason?: string;
};
const idFor = (source: string, key: string) =>
  createHash("sha256").update(`${source}:${key}`).digest("hex");
// OpenClaw session-event-wake priority and 250ms coalescing, adapted to durable
// owner records and our existing scheduler instead of a second in-memory runner.
export const wakePriority = (event: Pick<WakeEvent, "intent">) =>
  event.intent === "immediate" ? 3 : event.intent === "scheduled" ? 1 : 2;
export class ProactivityEvents {
  constructor(
    private readonly db: Store,
    private readonly now = Date.now,
  ) {}
  async enqueue(owner: string, raw: z.input<typeof eventInput>): Promise<WakeEvent> {
    const input = eventInput.parse(raw);
    const id = idFor(input.source, input.key);
    for (let retry = 0; retry < 5; retry++) {
      const previous = await this.db.get<WakeEvent>(owner, "proactivity-events", id);
      if (previous?.revision === input.revision) return previous;
      const observedAt = input.observedAt ?? new Date(this.now()).toISOString();
      if (previous?.observedAt && Date.parse(previous.observedAt) > Date.parse(observedAt))
        return previous;
      const dueAt = input.dueAt ?? new Date(this.now()).toISOString();
      const value: WakeEvent = {
        ...input,
        id,
        dueAt,
        observedAt,
        status: "pending",
        readyAt:
          input.intent === "scheduled" || input.intent === "immediate"
            ? dueAt
            : new Date(Math.max(Date.parse(dueAt), this.now() + 250)).toISOString(),
        createdAt: new Date(this.now()).toISOString(),
        attempts: 0,
      };
      const saved = previous
        ? await this.db.compareAndSwap<WakeEvent>(
            owner,
            "proactivity-events",
            id,
            { revision: previous.revision, status: previous.status },
            { ...value, cycleId: null },
          )
        : (await this.db.insertIfAbsent(owner, "proactivity-events", value))
          ? value
          : null;
      if (saved) return saved;
    }
    throw new AppError("Proactivity event changed while enqueueing", 409);
  }
  async plan(owner: string, memory: AgentMemory) {
    if (
      memory.status !== "active" ||
      memory.category !== "plan" ||
      memory.followUp?.state !== "open" ||
      (memory.validUntil && Date.parse(memory.validUntil) <= this.now())
    )
      return this.retire(owner, "memory", memory.id, "Plan is closed or expired");
    return this.enqueue(owner, {
      source: "memory",
      key: memory.id,
      revision: String(memory.revision ?? 0),
      dueAt: memory.followUp.after,
      expiresAt: memory.validUntil,
      intent: "scheduled",
      observedAt: memory.updatedAt ?? memory.createdAt,
    });
  }
  async task(owner: string, task: AgentTask) {
    if (
      task.input.internalActivity === true ||
      task.input.proactivityCycleId ||
      !["succeeded", "failed", "cancelled", "waiting_input"].includes(task.status)
    )
      return;
    return this.enqueue(owner, {
      source: "task",
      key: task.id,
      revision: `${task.status}:${task.updatedAt}`,
      observedAt: task.updatedAt,
    });
  }
  async retire(owner: string, source: WakeEvent["source"], key: string, reason: string) {
    const id = idFor(source, key);
    const previous = await this.db.get<WakeEvent>(owner, "proactivity-events", id);
    if (previous?.status === "pending")
      await this.db.compareAndSwap(
        owner,
        "proactivity-events",
        id,
        { revision: previous.revision, status: "pending" },
        { status: "settled", reason },
      );
  }
  async due(owner: string, now = this.now(), includeCoalescing = false): Promise<WakeEvent[]> {
    return (
      await this.db.dueProactivityEvents<WakeEvent>(
        owner,
        new Date(now).toISOString(),
        includeCoalescing,
      )
    ).sort((a, b) => wakePriority(b) - wakePriority(a) || a.readyAt.localeCompare(b.readyAt));
  }
  claims(events: WakeEvent[], cycleId: string): Parameters<Store["durableMutation"]>[3] {
    return events.map((e) => ({
      kind: "proactivity-events",
      id: e.id,
      mode: "merge",
      expected: { status: "pending", revision: e.revision },
      value: { status: "claimed", cycleId },
    }));
  }
  async settle(owner: string, cycle: ProactivityCycle, now = this.now()) {
    for (const event of (
      await this.db.recordPage<WakeEvent>(owner, "proactivity-events", {
        field: "cycleId",
        value: cycle.id,
        limit: 100,
      })
    ).entries) {
      if (event.status !== "claimed") continue;
      const source =
        event.source === "memory"
          ? "memories"
          : event.source === "deadline"
            ? "tasks"
            : event.source === "goal"
              ? "goals"
              : event.source === "task"
                ? "tasks"
                : event.source;
      const reviewed =
        (cycle.reviewedWakeEvents?.includes(event.id) ||
          cycle.coverage[source]?.complete === true) &&
        cycle.coverage.reasoning?.complete !== false;
      const expired = event.expiresAt && Date.parse(event.expiresAt) <= now;
      await this.db.compareAndSwap(
        owner,
        "proactivity-events",
        event.id,
        { revision: event.revision, status: "claimed", cycleId: cycle.id },
        reviewed || expired
          ? { status: "settled", reason: expired ? "Expired" : "Reviewed" }
          : {
              status: "pending",
              attempts: event.attempts + 1,
              readyAt: new Date(
                now + Math.min(3600000, 300000 * 2 ** Math.min(4, event.attempts)),
              ).toISOString(),
              cycleId: null,
              reason: "Review deferred or partial; retry current source",
            },
      );
    }
  }
  async reconcile(owner: string, now = this.now()) {
    await this.db.retireInvalidProactivityEvents(owner, new Date(now).toISOString());
    for (const { source, value } of await this.db.proactivityDeadlineCandidates<
      AgentMemory | AgentTask
    >(owner, new Date(now + 4 * 3600000).toISOString())) {
      if (source === "memory") await this.plan(owner, value as AgentMemory);
      else {
        const task = value as AgentTask;
        if (task.timing?.dueAt)
          await this.enqueue(owner, {
            source: "deadline",
            key: task.id,
            revision: String(task.state.timingRevision ?? 0),
            intent: "scheduled",
            dueAt: new Date(Date.parse(task.timing.dueAt) - 3600000).toISOString(),
            expiresAt: task.timing.validUntil,
            observedAt: task.updatedAt,
          });
      }
    }
    const claimed = (
      await this.db.recordPage<WakeEvent>(owner, "proactivity-events", {
        field: "status",
        value: "claimed",
        limit: 100,
      })
    ).entries;
    for (const cycleId of new Set(
      claimed.map((e) => e.cycleId).filter((id): id is string => Boolean(id)),
    )) {
      const cycle = await this.db.get<ProactivityCycle>(owner, "proactivity-cycles", cycleId);
      if (cycle?.status === "completed") await this.settle(owner, cycle, now);
    }
  }
}
