// Adapted from Hermes 1298c8e74baa73e1a2b90124228d017261ac6bc4:
// agent/curator.py automatic transitions and tools/skill_usage.py activity anchors.
// MIT, copyright 2025 Nous Research. See third_party/hermes-learning/LICENSE.
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type { ProcedureVersion } from "../../../../packages/domain/src/playbooks.ts";
import { bindingHash } from "../conversation-inbox.ts";
import type { AgentService } from "../engine/service.ts";
import type { TaskContext } from "../engine/worker.ts";
import { AppError } from "../errors.ts";

type State = {
  id: string;
  generation: number;
  activeTaskId: string | null;
  nextAt?: string;
  cursor?: string | null;
};
const DAY = 86400000;
/** Hermes defaults: weekly, two hours idle, stale after 14 days, recoverable archive after 30.
 * Curator never changes user-owned/pinned methods or method content. Semantic
 * consolidation is explicit; verified learning updates a previously read method.
 */
export class ProcedureMaintenance {
  constructor(
    private readonly service: AgentService,
    private readonly now = Date.now,
  ) {}
  private get db() {
    return this.service.db;
  }
  async scheduleDue(owner: string): Promise<string | undefined> {
    if (
      (await this.service.runtimePause.get(owner)).paused ||
      (await this.db.learningConversationActive(owner))
    )
      return;
    const latest = JSON.parse(await this.db.learningWatermark(owner)) as {
      createdAt?: string;
    } | null;
    if (latest?.createdAt && this.now() - Date.parse(latest.createdAt) < 2 * 3600000) return;
    const catalog = await this.service.playbooks.catalog(owner, {
      limit: 1,
      includeArchived: true,
    });
    if (!catalog.entries.length) return;
    await this.db.insertIfAbsent(owner, "procedure-maintenance", {
      id: "curator",
      generation: 0,
      activeTaskId: null,
    });
    let state = (await this.db.get<State>(owner, "procedure-maintenance", "curator"))!;
    if (state.activeTaskId) {
      const active = await this.db.get<AgentTask>(owner, "tasks", state.activeTaskId);
      if (active && !["succeeded", "failed", "cancelled"].includes(active.status)) return active.id;
      await this.db.compareAndSwap(
        owner,
        "procedure-maintenance",
        "curator",
        { activeTaskId: state.activeTaskId, generation: state.generation },
        {
          activeTaskId: null,
          nextAt: new Date(
            this.now() + (active?.status === "succeeded" ? 7 * DAY : 3600000),
          ).toISOString(),
        },
      );
      state = (await this.db.get<State>(owner, "procedure-maintenance", "curator"))!;
    }
    if (state.nextAt && Date.parse(state.nextAt) > this.now()) return;
    const id = bindingHash({
      owner,
      kind: "procedure-maintenance",
      generation: state.generation + 1,
    });
    const task = await this.service.taskRecord(
      owner,
      {
        title: "Maintain learned procedures",
        prompt:
          "Review the lifecycle of learned methods, preserving user-owned and pinned content.",
        input: { procedureMaintenance: true, internalActivity: true },
        timing: { priority: "low", timezone: this.service.routines.timezone },
      },
      id,
    );
    const result = await this.db.durableMutation(
      owner,
      `procedure-maintenance:${id}`,
      id,
      [
        {
          kind: "procedure-maintenance",
          id: "curator",
          mode: "merge",
          expected: { activeTaskId: null, generation: state.generation },
          value: { activeTaskId: id, generation: state.generation + 1 },
        },
        { kind: "tasks", id, mode: "insert", value: { ...task } },
        {
          kind: "task-budgets",
          id,
          mode: "insert",
          value: {
            id,
            revision: 0,
            maxSteps: 64,
            usedSteps: 0,
            maxMilliseconds: 300000,
            usedMilliseconds: 0,
          },
        },
      ],
      [],
      true,
    );
    if (result.status === "paused") return;
    return (
      (await this.db.get<State>(owner, "procedure-maintenance", "curator"))?.activeTaskId ??
      undefined
    );
  }
  async run(owner: string, task: AgentTask, ctx: TaskContext): Promise<Partial<AgentTask>> {
    await ctx.guard();
    const state = await this.db.get<State>(owner, "procedure-maintenance", "curator");
    if (state?.activeTaskId !== task.id)
      throw new AppError("Procedure maintenance lost its generation", 409);
    if (await this.db.learningConversationActive(owner))
      return { status: "scheduled", nextRunAt: new Date(this.now() + 2 * 3600000).toISOString() };
    const watermark = await this.db.learningWatermark(owner);
    const page = await this.service.playbooks.catalog(owner, {
      limit: 30,
      includeArchived: true,
      cursor: state.cursor ?? undefined,
    });
    let changed = 0;
    for (const metadata of page.entries) {
      await ctx.guard();
      if ((await this.db.learningWatermark(owner)) !== watermark)
        return { status: "scheduled", nextRunAt: new Date(this.now() + 2 * 3600000).toISOString() };
      const method = await this.service.playbooks.read(owner, { id: metadata.id });
      if (
        !method.learned ||
        method.pinned ||
        method.lifecycle === "archived" ||
        (await this.db.procedureInUse(owner, method.id, method.title))
      )
        continue;
      const usage = await this.service.playbooks.usage(owner, method.id);
      const anchor = Math.max(
        ...[method.contentSavedAt ?? method.savedAt, usage.lastUsedAt, usage.lastViewedAt]
          .filter((value): value is string => Boolean(value))
          .map(Date.parse),
      );
      const current = method.lifecycle ?? "active";
      const action = this.transition(current, this.now() - anchor);
      if (!action) continue;
      await this.service.playbooks.manage(
        owner,
        method.id,
        {
          action,
          expectedVersion: method.version,
          requestId: `curator:${task.id}:${method.id}:${method.version}`,
          reason:
            action === "archive"
              ? "No use, view or method update for 30 days; original versions remain recoverable"
              : action === "mark_stale"
                ? "No activity for 14 days"
                : "The method was used or read again",
        },
        "curator",
      );
      changed++;
    }
    await ctx.guard();
    const nextAt = new Date(this.now() + (page.nextCursor ? 60000 : 7 * DAY)).toISOString();
    const saved = await this.db.durableMutation(
      owner,
      `procedure-maintained:${task.id}`,
      bindingHash({ task: task.id }),
      [
        {
          kind: "procedure-maintenance",
          id: "curator",
          mode: "merge",
          expected: { activeTaskId: task.id, generation: state.generation },
          value: {
            activeTaskId: null,
            nextAt,
            cursor: page.nextCursor ?? null,
            lastReviewedAt: new Date(this.now()).toISOString(),
            changes: changed,
          },
        },
      ],
      [],
      true,
    );
    if (saved.status !== "applied" && saved.status !== "duplicate")
      throw new AppError("Procedure maintenance was interrupted before checkpointing", 409);
    return {
      status: "succeeded",
      result: `Reviewed ${page.entries.length} procedures; ${changed} lifecycle changes.`,
      state: { ...task.state, procedureMaintenanceChanges: changed },
      completion: { status: "verified", checks: [], remaining: [] },
    };
  }
  private transition(
    current: ProcedureVersion["lifecycle"],
    idleMs: number,
  ): "archive" | "mark_stale" | "reactivate" | undefined {
    if (idleMs >= 30 * DAY) return "archive";
    if (idleMs >= 14 * DAY && current === "active") return "mark_stale";
    if (idleMs < 14 * DAY && current === "stale") return "reactivate";
  }
}
