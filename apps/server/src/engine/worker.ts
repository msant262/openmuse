import { randomUUID } from "node:crypto";
import type { AgentTask, RunEvent } from "../../../../packages/domain/src/agent.ts";
import type { ResourceLease, ResourceRequest } from "../../../../packages/domain/src/runtime.ts";
import type { Store } from "../db.ts";
import { backgroundFailure } from "../log.ts";
import { ResourceBusyError, ResourceLeases } from "./resource-leases.ts";
import { RuntimePause, RuntimePausedError } from "./runtime-pause.ts";
import { WorkAdmission } from "./work-admission.ts";

export class LostLeaseError extends Error {
  constructor() {
    super("Task was paused, cancelled or taken over by another worker");
    this.name = "LostLeaseError";
  }
}
export { ResourceBusyError };
export interface TaskContext {
  signal: AbortSignal;
  guard(): Promise<void>;
  checkpoint(patch: Partial<AgentTask>): Promise<AgentTask>;
  event(kind: RunEvent["kind"], title: string, detail?: string): Promise<void>;
  acquireResources(requests: ResourceRequest[]): Promise<ResourceLease[]>;
  trackResourceLeases(leases: ResourceLease[]): void;
  holdAdmission(): Promise<void>;
}
export type TaskHandler = (
  owner: string,
  task: AgentTask,
  context: TaskContext,
) => Promise<Partial<AgentTask>>;
export class TaskWorker {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private stopping = false;
  private drainFailed = false;
  private readonly pendingTicks = new Set<Promise<void>>();
  private active = new Map<string, AbortController>();
  private inFlight = new Map<string, Promise<void>>();
  private readonly admission: WorkAdmission;
  private readonly resources: ResourceLeases;
  private readonly pause: RuntimePause;
  lastTickAt?: string;
  constructor(
    private readonly db: Store,
    private readonly execute: TaskHandler,
    private readonly options: {
      now?: () => number;
      leaseMs?: number;
      pollMs?: number;
      jobPollMs?: number;
      settled?: (owner: string, task: AgentTask) => Promise<void>;
      browserReleased?: (owner: string, sessionId: string) => Promise<boolean>;
      workAdmission?: WorkAdmission;
      resourceLeases?: ResourceLeases;
      runtimePause?: RuntimePause;
    } = {},
  ) {
    this.admission = options.workAdmission ?? new WorkAdmission(db);
    this.resources = options.resourceLeases ?? new ResourceLeases(db);
    this.pause = options.runtimePause ?? new RuntimePause(db);
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  get running() {
    return Boolean(this.timer);
  }
  start() {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => {
      // tick retains failures before this timer-owned promise is observed/logged.
      void this.tick().catch((error) => backgroundFailure("task worker tick", error));
    }, this.options.pollMs ?? 1000);
    void this.tick().catch((error) => backgroundFailure("initial task worker tick", error));
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled([...this.pendingTicks]);
    while (this.active.size || this.inFlight.size || this.ticking)
      await new Promise((r) => setTimeout(r, 10));
    if (this.drainFailed || this.db.persistenceFailed)
      throw new Error("Task worker shutdown could not confirm durable completion");
  }
  abort(taskId: string) {
    this.active.get(taskId)?.abort();
  }
  tick(): Promise<void> {
    const pending = this.tickInternal();
    this.pendingTicks.add(pending);
    void pending.finally(() => this.pendingTicks.delete(pending)).catch(() => {});
    return pending;
  }
  private async tickInternal() {
    if (this.stopping) return;
    if (this.running)
      await this.db.put("system", "worker-status", {
        id: "tasks",
        lastTickAt: new Date(this.now()).toISOString(),
      });
    if (this.ticking) return;
    this.ticking = true;
    this.lastTickAt = new Date(this.now()).toISOString();
    const batch: Promise<void>[] = [];
    try {
      if ((await this.pause.get("__runtime__")).paused) return;
      const due = await this.db.eligibleTasks<AgentTask>(new Date(this.now()).toISOString());
      due.sort((a, b) => this.compareTaskOrder(a.value, b.value));
      for (const record of due) {
        if (this.stopping) break;
        const task = record.value;
        if (this.inFlight.has(task.id) || this.active.has(task.id)) continue;
        if (task.status === "paused") {
          if (
            !this.options.browserReleased ||
            !(await this.options
              .browserReleased(record.owner, String(task.state.awaitingBrowserSessionId))
              .catch(() => false))
          )
            continue;
        }
        if (task.status === "waiting_approval") {
          const action = task.actionId
            ? await this.db.get<{ status: string; expiresAt?: string }>(
                record.owner,
                "actions",
                task.actionId,
              )
            : null;
          if (
            task.actionId &&
            action?.status === "awaiting_review" &&
            Date.parse(action.expiresAt ?? "") <= this.now()
          )
            await this.db.compareAndSwap(
              record.owner,
              "actions",
              task.actionId,
              { status: "awaiting_review", expiresAt: action.expiresAt },
              { status: "expired" },
            );
          else if (action && ["awaiting_review", "executing"].includes(action.status)) continue;
        }
        const rootTaskId =
          typeof task.state.rootTaskId === "string" ? task.state.rootTaskId : task.id;
        if (!(await this.admission.claim(task.id, "background", rootTaskId))) continue;
        const pending = Promise.resolve().then(() => this.run(record.owner, task));
        this.inFlight.set(task.id, pending);
        void pending
          .finally(() => {
            if (this.inFlight.get(task.id) === pending) this.inFlight.delete(task.id);
          })
          .catch(() => {});
        batch.push(pending);
      }
    } finally {
      this.ticking = false;
    }
    // New ticks can fill any slot this batch releases while these runs remain in flight.
    const results = await Promise.allSettled(batch);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      this.drainFailed = true;
      throw failure.reason;
    }
  }
  private compareTaskOrder(a: AgentTask, b: AgentTask) {
    const ageStepMs = 5 * 60_000;
    const rank = (task: AgentTask) =>
      ({ low: 0, normal: 1, high: 2 })[task.timing?.priority ?? "normal"] +
      Math.floor(Math.max(0, this.now() - Date.parse(task.createdAt)) / ageStepMs);
    const priorityOrder = rank(b) - rank(a);
    if (priorityOrder) return priorityOrder;
    const deadlineA = Date.parse(a.timing?.dueAt ?? "") || Number.POSITIVE_INFINITY;
    const deadlineB = Date.parse(b.timing?.dueAt ?? "") || Number.POSITIVE_INFINITY;
    return (
      deadlineA - deadlineB || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
    );
  }
  private async run(owner: string, previous: AgentTask) {
    if (this.stopping) {
      await this.admission.release(previous.id);
      return;
    }
    const leaseId = randomUUID(),
      leaseMs = this.options.leaseMs ?? 60000;
    const expected: Record<string, unknown> = {
      status: previous.status,
      leaseId: previous.leaseId ?? null,
    };
    if (previous.status === "running") expected.leaseUntil = previous.leaseUntil;
    let task = await this.db.compareAndSwapTask<AgentTask>(owner, previous.id, expected, {
      status: "running",
      leaseId,
      leaseUntil: new Date(this.now() + leaseMs).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
      attempts: previous.attempts + 1,
      state: previous.state.awaitingBrowserSessionId
        ? { ...previous.state, awaitingBrowserSessionId: null }
        : previous.state,
    });
    if (!task) {
      await this.admission.release(previous.id);
      return;
    }
    // A held waiting_job admission survives a process restart. Rebind it only
    // after the task row CAS proves that this worker owns the resume attempt.
    await this.admission.rebind(previous.id);
    const controller = new AbortController();
    this.active.set(task.id, controller);
    const taskId = task.id;
    const ownedResources = new Map<string, ResourceLease>();
    const trackResourceLeases = (leases: ResourceLease[]) => {
      for (const lease of leases) ownedResources.set(`${lease.id}:${lease.fence}`, lease);
    };
    const guard = async () => {
      const latest = await this.db.get<AgentTask>(owner, "tasks", taskId);
      if (controller.signal.aborted || latest?.leaseId !== leaseId || latest.status !== "running")
        throw new LostLeaseError();
      await this.pause.assertResumed(owner);
    };
    const acquireResources = async (requests: ResourceRequest[]) => {
      const leases = await this.resources.acquire(owner, taskId, requests);
      if (!leases) throw new ResourceBusyError(requests);
      trackResourceLeases(leases);
      return leases;
    };
    const holdAdmission = async () => {
      if (!(await this.admission.holdForDispatch(taskId))) throw new LostLeaseError();
      keepAdmission = true;
    };
    const checkpoint = async (patch: Partial<AgentTask>) => {
      if (controller.signal.aborted) throw new LostLeaseError();
      const next = await this.db.compareAndSwapTask<AgentTask>(
        owner,
        taskId,
        { leaseId, status: "running" },
        { ...patch, updatedAt: new Date(this.now()).toISOString() },
      );
      if (!next) throw new LostLeaseError();
      task = next;
      return next;
    };
    const event = async (kind: RunEvent["kind"], title: string, detail = "") => {
      await guard();
      await this.db.put(owner, "run-events", {
        id: randomUUID(),
        taskId,
        date: new Date(this.now()).toISOString(),
        kind,
        title,
        detail,
      });
    };
    const startedAt = new Date(this.now()).toISOString();
    const renewals = new Set<Promise<unknown>>();
    // A persisted waiting_job slot stays occupied if a resume poll is paused,
    // contended, interrupted or loses its worker lease. Only a confirmed
    // non-waiting result releases it.
    let keepAdmission =
      previous.status === "waiting_job" ||
      typeof previous.state.waitingComputerCommandId === "string";
    const heartbeat = setInterval(
      () => {
        const renewal = (async () => {
          const [taskRenewed, admissionRenewed] = await Promise.all([
            this.db.compareAndSwapTask(
              owner,
              taskId,
              { leaseId, status: "running" },
              { leaseUntil: new Date(this.now() + leaseMs).toISOString() },
            ),
            this.admission.renew(taskId),
          ]);
          if (!taskRenewed || !admissionRenewed) {
            controller.abort();
            return;
          }
          for (const lease of ownedResources.values())
            if (!(await this.resources.renew(lease))) {
              controller.abort();
              return;
            }
        })().catch(() => {
          this.drainFailed = true;
          controller.abort();
        });
        renewals.add(renewal);
        void renewal.finally(() => renewals.delete(renewal));
      },
      Math.max(10, Math.floor(leaseMs / 3)),
    );
    let cleanupFailure: unknown;
    try {
      await this.db.put(owner, "runs", {
        id: leaseId,
        taskId,
        startedAt,
        status: "running",
      });
      const result = await this.execute(owner, task, {
        signal: controller.signal,
        guard,
        checkpoint,
        event,
        acquireResources,
        trackResourceLeases,
        holdAdmission,
      });
      const checkpointResult =
        result.status === "waiting_job"
          ? {
              ...result,
              nextRunAt:
                result.nextRunAt ??
                new Date(this.now() + (this.options.jobPollMs ?? 5000)).toISOString(),
            }
          : result;
      await checkpoint({ ...checkpointResult, leaseId: null, leaseUntil: null });
      if (result.status === "waiting_job") {
        keepAdmission = await this.admission.hold(taskId);
        if (!keepAdmission) throw new LostLeaseError();
      } else keepAdmission = false;
      await this.db.put(owner, "runs", {
        id: leaseId,
        taskId,
        startedAt,
        finishedAt: new Date(this.now()).toISOString(),
        status: result.status ?? task.status,
      });
    } catch (error) {
      if (error instanceof RuntimePausedError) {
        await this.db.compareAndSwapTask(
          owner,
          taskId,
          { leaseId, status: "running" },
          { status: "waiting_global_pause", leaseId: null, leaseUntil: null, error: null },
        );
      } else if (error instanceof ResourceBusyError) {
        await this.db.compareAndSwapTask(
          owner,
          taskId,
          { leaseId, status: "running" },
          {
            status: "waiting_resource",
            leaseId: null,
            leaseUntil: null,
            error: null,
            state: { ...task.state, waitingForResources: error.requests },
          },
        );
      } else if (error instanceof LostLeaseError || controller.signal.aborted) {
        await this.db.compareAndSwapTask(
          owner,
          taskId,
          { leaseId, status: "running" },
          { status: "queued", leaseId: null, leaseUntil: null },
        );
      } else {
        const detail = error instanceof Error ? error.message : "Task execution failed";
        await event("error", "Task needs attention", detail).catch((error) =>
          backgroundFailure("record task error", error),
        );
        await this.db.compareAndSwapTask(
          owner,
          taskId,
          { leaseId, status: "running" },
          {
            status: "failed",
            error: detail,
            leaseId: null,
            leaseUntil: null,
            updatedAt: new Date(this.now()).toISOString(),
          },
        );
      }
      await this.db.compareAndSwap(
        owner,
        "runs",
        leaseId,
        { status: "running" },
        {
          status: controller.signal.aborted ? "interrupted" : "failed",
          finishedAt: new Date(this.now()).toISOString(),
        },
      );
    } finally {
      clearInterval(heartbeat);
      await Promise.allSettled([...renewals]);
      try {
        if (!keepAdmission) {
          try {
            await this.admission.release(taskId);
          } catch (error) {
            cleanupFailure = error;
          }
        }
        try {
          await Promise.all(
            [...ownedResources.values()].map((lease) => this.resources.release(lease)),
          );
        } catch (error) {
          cleanupFailure ??= error;
        }
        if (!keepAdmission && cleanupFailure === undefined) {
          const cleanupId = task.state.computerCleanupPendingId;
          const completed = task.state.completedComputerJob as
            | { id?: unknown; status?: unknown }
            | undefined;
          if (
            typeof cleanupId === "string" &&
            completed?.id === cleanupId &&
            ["succeeded", "failed", "rejected_not_dispatched"].includes(String(completed.status)) &&
            !(await this.db.get("__runtime__", "work-admissions", taskId))
          ) {
            const latest = await this.db.get<AgentTask>(owner, "tasks", taskId);
            if (latest && latest.status !== "running")
              await this.db.compareAndSwapTask(
                owner,
                taskId,
                { status: latest.status, state: { computerCleanupPendingId: cleanupId } },
                {
                  state: {
                    computerCleanupPendingId: null,
                    waitingComputerCommandId: null,
                  },
                },
              );
          }
        }
        if (cleanupFailure !== undefined) {
          this.drainFailed = true;
        }
      } finally {
        // Durable cleanup can fail; the in-memory controller must still retire so
        // stop() reports drain failure instead of waiting forever.
        this.active.delete(taskId);
      }
    }
    if (cleanupFailure !== undefined) throw cleanupFailure;
    const settled = await this.db.get<AgentTask>(owner, "tasks", taskId);
    if (settled && this.options.settled) await this.options.settled(owner, settled);
  }
}
