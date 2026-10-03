import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { AgentTask } from "../../../packages/domain/src/agent.ts";
import type { NativeDesktopSession } from "./desktop-contract.ts";
import type { DesktopService } from "./desktop-service.ts";
import type { AgentService } from "./engine/service.ts";
import type { TaskContext } from "./engine/worker.ts";
import { AppError } from "./errors.ts";
import { backgroundFailure } from "./log.ts";

const viewerScope = new AsyncLocalStorage<{ owner: string; deviceId: string; viewerId: string }>();
export const currentDesktopViewerScope = () => viewerScope.getStore();
type ViewerRecord = {
  id: string;
  deviceId: string;
  sessionId: string;
  generation: string;
  closed: boolean;
};
type LiveViewer = {
  owner: string;
  deviceId: string;
  session: NativeDesktopSession;
  expiresAt: number;
  context?: TaskContext;
  ready: Promise<void>;
  resolveReady: () => void;
  closed: boolean;
  pending: Set<Promise<unknown>>;
};

/** One admitted interactive lifecycle per viewer. Observation, input and reset
 * share its real TaskWorker lease and M4 journal; no per-frame background work. */
export class DesktopViewers {
  private readonly live = new Map<string, LiveViewer>();
  constructor(
    readonly agent: AgentService,
    readonly desktop: DesktopService,
  ) {}
  private async device(owner: string, deviceId: string) {
    const device = await this.agent.db.get<{ owner: string; revokedAt: number | null }>(
      "system",
      "device-sessions",
      deviceId,
    );
    if (!device || device.owner !== owner || device.revokedAt !== null)
      throw new AppError("Desktop viewer device was revoked or belongs to another owner", 403);
  }
  async open(owner: string, deviceId: string, sessionId: string) {
    await this.device(owner, deviceId);
    const session = await this.desktop.session(owner, sessionId);
    for (const [id, viewer] of this.live)
      if (
        viewer.owner === owner &&
        viewer.deviceId === deviceId &&
        viewer.session.id === sessionId &&
        !viewer.closed
      )
        return { viewerId: id, session };
    if (this.live.size >= 16)
      throw new AppError("Close an existing desktop viewer before opening another", 409);
    const id = randomUUID(),
      now = new Date().toISOString();
    const task: AgentTask = {
      id,
      kind: "agent",
      title: "Desktop viewer",
      prompt: "Authenticated desktop observation and control lifecycle",
      status: "paused",
      attempts: 0,
      leaseId: null,
      leaseUntil: null,
      createdAt: now,
      updatedAt: now,
      artifactIds: [],
      plan: [],
      evidence: [],
      input: {},
      state: { desiredRevision: 0, appliedRevision: 0 },
    };
    await this.agent.db.insertIfAbsent(owner, "tasks", task);
    await this.agent.db.insertIfAbsent<ViewerRecord>(owner, "desktop-viewer-sessions", {
      id,
      deviceId,
      sessionId,
      generation: session.sessionGeneration,
      closed: false,
    });
    let resolveReady = () => {};
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const live: LiveViewer = {
      owner,
      deviceId,
      session,
      expiresAt: Date.now() + 30_000,
      closed: false,
      pending: new Set(),
      ready,
      resolveReady,
    };
    this.live.set(id, live);
    const run = this.agent.worker.runInteractive(owner, task, async (_owner, _task, context) => {
      live.context = context;
      live.resolveReady();
      try {
        while (!live.closed && !context.signal.aborted && Date.now() < live.expiresAt) {
          await this.device(owner, deviceId);
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        live.closed = true;
        await Promise.allSettled([...live.pending]);
        return {
          status: "cancelled",
          result: "Desktop viewer closed; desktop and jobs remain available",
        };
      } finally {
        live.closed = true;
        this.live.delete(id);
        await this.agent.db.compareAndSwap(
          owner,
          "desktop-viewer-sessions",
          id,
          {},
          { closed: true },
        );
      }
    });
    void run
      .then(() => {
        if (!live.context) {
          live.closed = true;
          live.resolveReady();
          this.live.delete(id);
        }
      })
      .catch((error) => {
        live.closed = true;
        live.resolveReady();
        this.live.delete(id);
        backgroundFailure("desktop viewer lifecycle", error);
      });
    await ready;
    if (!live.context || live.closed)
      throw new AppError("Desktop interactive admission could not start", 503);
    return { viewerId: id, session };
  }
  async run<T>(
    owner: string,
    deviceId: string,
    viewerId: string,
    requestId: string,
    name: string,
    args: Record<string, unknown> & { sessionId: string },
    execute: () => Promise<T>,
    effect = false,
  ): Promise<T> {
    await this.device(owner, deviceId);
    const live = this.live.get(viewerId);
    if (
      !live ||
      live.closed ||
      live.owner !== owner ||
      live.deviceId !== deviceId ||
      Date.now() >= live.expiresAt ||
      !live.context
    )
      throw new AppError("Desktop viewer expired; reconnect to the registered session", 409);
    if (args.sessionId !== live.session.id)
      throw new AppError("Desktop operation belongs to another viewer session", 403);
    const session = await this.desktop.session(owner, live.session.id);
    if (
      session.sessionGeneration !== live.session.sessionGeneration ||
      session.executorEpoch !== live.session.executorEpoch
    )
      throw new AppError("Desktop viewer generation/epoch changed; reconnect", 409);
    if (live.pending.size >= 4)
      throw new AppError("Desktop viewer has pending input; wait for its receipt", 409);
    live.expiresAt = Date.now() + 30_000;
    const task = await this.agent.getTask(owner, viewerId);
    const pending = viewerScope.run({ owner, deviceId, viewerId }, async () => {
      await live.context!.guard();
      let image: string | undefined;
      const result = await this.agent.journal.run(
        owner,
        task,
        { id: requestId, name: `desktop_viewer.${name}`, args },
        async () => {
          const value = await execute();
          if (name === "observe" && value && typeof value === "object" && "image" in value) {
            const { image: pixels, ...metadata } = value;
            image = typeof pixels === "string" ? pixels : undefined;
            return metadata;
          }
          return value;
        },
        effect,
      );
      return (image && result && typeof result === "object" ? { ...result, image } : result) as T;
    });
    live.pending.add(pending);
    try {
      return await pending;
    } finally {
      live.pending.delete(pending);
    }
  }
  async close(owner: string, deviceId: string, viewerId: string) {
    await this.device(owner, deviceId);
    const live = this.live.get(viewerId);
    if (!live || live.owner !== owner || live.deviceId !== deviceId)
      throw new AppError("Desktop viewer belongs to another device", 403);
    live.closed = true;
    return { closed: true };
  }
  async recover() {
    for (const { owner, value } of await this.agent.db.scan<ViewerRecord>(
      "desktop-viewer-sessions",
    )) {
      await this.agent.db.compareAndSwap(
        owner,
        "desktop-viewer-sessions",
        value.id,
        {},
        { closed: true },
      );
      const task = await this.agent.db.get<AgentTask>(owner, "tasks", value.id);
      if (task && !["succeeded", "cancelled", "failed"].includes(task.status))
        await this.agent.db.compareAndSwapTask(
          owner,
          task.id,
          { status: task.status, leaseId: task.leaseId ?? null },
          {
            status: "cancelled",
            leaseId: null,
            leaseUntil: null,
            result:
              "Viewer disconnected during server restart; reconnect to inspect the same desktop",
          },
        );
      // A viewer disconnect cannot confirm that its last native input stopped.
      // The same M4 receipt/cleanup proof used by TaskWorker retains this slot.
      const pending = (await this.agent.journal.operations(owner, value.id)).some(
        (operation) =>
          operation.nativeEnvelope &&
          operation.effect &&
          !["succeeded", "failed", "rejected_not_dispatched", "superseded"].includes(
            operation.status,
          ) &&
          (operation.receipt as { data?: { cleanupConfirmed?: boolean } })?.data
            ?.cleanupConfirmed !== true,
      );
      if (pending)
        await this.agent.db.compareAndSwapTask(
          owner,
          value.id,
          {},
          {
            state: { nativeAdmissionPending: true },
          },
        );
      else await this.agent.workAdmission.releaseHeld(value.id);
    }
  }
}
