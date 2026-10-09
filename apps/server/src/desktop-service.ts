import { createHash, randomUUID } from "node:crypto";
import { nativeDownloadLimit } from "../../../packages/domain/src/browser-file.ts";
import type { ResourceLease, ResourceRequest } from "../../../packages/domain/src/runtime.ts";
import { BrowserAssets } from "./browser-assets.ts";
import { BrowserError } from "./browser-contract.ts";
import { stageBrowserFile } from "./browser-files.ts";
import {
  currentComputerResourceScope,
  physicalComputerResources,
} from "./computer-resource-scope.ts";
import {
  type NativeCredentialInjector,
  type NativeCredentialPlan,
  trustedCredentialResultSchema,
} from "./credential-browser-contract.ts";
import type { Store } from "./db.ts";
import {
  type DesktopControl,
  type DesktopInput,
  desktopFrameSchema,
  desktopInputSchema,
  desktopProfileKey,
  desktopResourceKey,
  type NativeDesktopSession,
} from "./desktop-contract.ts";
import { type LiveDesktopFrame, loadLiveDesktopFrame } from "./desktop-frames.ts";
import { stageDesktopText } from "./desktop-input.ts";
import { ResourceBusyError, ResourceLeases } from "./engine/resource-leases.ts";
import { RuntimePause } from "./engine/runtime-pause.ts";
import { authorizeTaskEffect, currentTaskScope, taskOperationId } from "./engine/task-journal.ts";
import { AppError } from "./errors.ts";
import { nativeInspection } from "./executors/graphical-policy.ts";
import type { ExecutorDispatchContext, ExecutorRequest } from "./executors/protocol.ts";
import type { ExecutorRegistry } from "./executors/registry.ts";

export interface DesktopTransport {
  session(owner: string): Promise<NativeDesktopSession>;
  request(
    owner: string,
    session: NativeDesktopSession,
    kind: "desktop" | "browser",
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
}
type ControlRecord = DesktopControl & {
  id: string;
  generation: string;
  deviceId?: string;
  leaseTaskId?: string;
  leases?: ResourceLease[];
};
type DesktopHold = {
  id: string;
  sessionId: string;
  generation: string;
  leases: ResourceLease[];
  complete: boolean;
};

/** One registered native display; transport uses the existing M4 authority/M6 registry. */
export function nativeDesktopTransport(
  registry: ExecutorRegistry,
  options: {
    executorId: string;
    context?: (
      owner: string,
      requestId: string,
      request?: ExecutorRequest,
    ) => Promise<ExecutorDispatchContext | undefined>;
    manualContext?: (
      owner: string,
      requestId: string,
      request?: ExecutorRequest,
    ) => Promise<ExecutorDispatchContext>;
    pollMs?: number;
    timeoutMs?: number;
  },
): DesktopTransport {
  return {
    async session(owner) {
      const registration = registry.registration(options.executorId);
      if (registration.owner !== owner)
        throw new AppError("Desktop belongs to another account", 403);
      const node = await registry.node(options.executorId);
      const desktop = node?.hello.readiness.desktopSession;
      if (
        !registry.authorized ||
        !node?.connected ||
        !node.reconciled ||
        !desktop ||
        node.hello.readiness.display.state !== "ready"
      )
        throw new AppError("Native desktop is offline or awaiting preflight/reconciliation", 503);
      return {
        ...desktop,
        executorId: options.executorId,
        hostId: registration.hostId,
        osAccountId: registration.osAccountId,
        executorEpoch: node.epoch,
      };
    },
    async request(owner, session, kind, args, signal) {
      signal?.throwIfAborted();
      const id = createHash("sha256")
        .update(`${owner}:${taskOperationId() ?? randomUUID()}:${kind}:${JSON.stringify(args)}`)
        .digest("hex");
      args = stageDesktopText(registry, owner, id, args);
      if (kind === "browser") args = stageBrowserFile(registry, owner, id, args);
      const inspection = nativeInspection(kind, args);
      const request: ExecutorRequest = {
        id,
        executorId: session.executorId,
        kind,
        capability: kind === "desktop" ? "desktop" : "browser.dom",
        capabilityVersion: 1,
        args,
        inspection,
      };
      const context =
        (await options.context?.(owner, id, request)) ??
        (await options.manualContext?.(owner, id, request));
      if (!context)
        throw new AppError(
          "Desktop dispatch requires trusted task or authenticated device context",
          503,
        );
      const operation = await registry.enqueue(owner, request, context);
      const deadline = Date.now() + (options.timeoutMs ?? 45_000);
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const delivery = await registry.delivery(owner, operation.id);
        if (delivery?.receipt && delivery.receipt.status !== "running") {
          if (delivery.receipt.status !== "succeeded") {
            const error = new BrowserError(
              String(delivery.receipt.data?.code ?? "DESKTOP_FAILED"),
              delivery.receipt.message ?? "Desktop operation failed",
              409,
              session.browserSessionId,
            );
            Object.assign(error, {
              outcomeUnknown: delivery.receipt.status === "outcome_unknown",
              cleanupConfirmed: delivery.receipt.data?.cleanupConfirmed === true,
            });
            throw error;
          }
          const data = delivery.receipt.data ?? {};
          if (data.imagePublished === true) {
            const frame = await loadLiveDesktopFrame(
              registry.db,
              owner,
              session.executorId,
              kind,
              operation.id,
            );
            return { ...data, image: frame.image };
          }
          return data;
        }
        await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 50));
      }
      const error = new AppError(
        "Desktop receipt is pending. Inspect it before repeating input",
        503,
        "OUTCOME_UNKNOWN",
      );
      Object.assign(error, { outcomeUnknown: true });
      throw error;
    },
  };
}

export class DesktopService {
  private readonly resources: ResourceLeases;
  private readonly pause: RuntimePause;
  private readonly assets: BrowserAssets;
  private wake?: (owner: string, browserSessionId: string) => Promise<void>;
  private credentialInjector?: NativeCredentialInjector;
  constructor(
    readonly db: Store,
    dataDir: string,
    readonly transport: DesktopTransport,
    private readonly now = Date.now,
  ) {
    this.resources = new ResourceLeases(db);
    this.pause = new RuntimePause(db);
    this.assets = new BrowserAssets(db, dataDir);
  }
  configureWake(wake: (owner: string, browserSessionId: string) => Promise<void>) {
    this.wake = wake;
  }
  configureCredentialInjector(injector: NativeCredentialInjector) {
    this.credentialInjector = injector;
  }
  /** Server credential broker only. Values/selectors are delivered out of band;
   * this entry point accepts only the fixed grant reference. */
  async trustedBrowserRequest(
    owner: string,
    session: NativeDesktopSession,
    operation: "credentials",
    body: { grantId: string; origin: string; adapterId: string; challengeId?: string },
    signal?: AbortSignal,
  ) {
    const current = await this.session(owner, session.id);
    if (
      current.sessionGeneration !== session.sessionGeneration ||
      current.executorEpoch !== session.executorEpoch ||
      !currentComputerResourceScope(owner)
    )
      throw new AppError("Native credential session authority changed", 409);
    return this.run(
      owner,
      session,
      true,
      (state) =>
        this.dispatch(
          owner,
          session,
          "browser",
          {
            operation,
            browserSessionId: session.browserSessionId,
            actor: "agent",
            controlRevision: state.revision,
            body,
          },
          signal,
        ),
      signal,
    );
  }
  async credentials(
    owner: string,
    browserSessionId: string,
    input: NativeCredentialPlan,
    signal?: AbortSignal,
  ) {
    const session = await this.session(owner);
    const task = currentTaskScope();
    if (
      !task ||
      task.owner !== owner ||
      task.operation.taskId !== input.taskId ||
      task.operation.revision !== input.revision
    )
      throw new AppError("Native credential plan belongs to another task or revision", 403);
    if (session.browserSessionId !== browserSessionId)
      throw new AppError("Credential browser belongs to another registered desktop", 403);
    if ("fields" in input)
      throw new AppError(
        "Native credential values require the one-use vault consume endpoint",
        403,
      );
    const scope = currentComputerResourceScope(owner);
    if (!scope || !this.credentialInjector)
      throw new AppError(
        "Trusted native credential injector/protection transport is unavailable",
        503,
      );
    const handles = await Promise.all(
      scope.leases.map((lease) =>
        this.db.get<{
          owner: string;
          taskId: string;
          fence: number;
          expiresAt: string;
          request: { key: string; mode: string };
        }>("__runtime__", "resource-leases", lease.id),
      ),
    );
    for (const request of this.inputResources(session))
      if (
        !handles.some(
          (lease, index) =>
            lease?.owner === owner &&
            lease.taskId === scope.resourceHoldTaskId &&
            lease.fence === scope.leases[index].fence &&
            Date.parse(lease.expiresAt) > this.now() &&
            lease.request.key === request.key &&
            lease.request.mode === "exclusive",
        )
      )
        throw new ResourceBusyError(this.inputResources(session));
    await this.pause.assertResumed(owner);
    const control = await this.state(owner, session);
    if (control.control !== "agent")
      throw new BrowserError(
        "BROWSER_CONTROLLED",
        "Desktop is under human control",
        409,
        session.browserSessionId,
      );
    const result = trustedCredentialResultSchema.parse(
      await this.credentialInjector(owner, session, input, signal),
    );
    if (
      result.sessionId !== session.browserSessionId ||
      result.sessionGeneration !== session.sessionGeneration ||
      new URL(result.origin).origin !== new URL(input.origin).origin
    )
      throw new AppError("Credential result origin/session binding changed", 409);
    return {
      ...result,
      executorId: session.executorId,
      profileId: session.profileId,
    };
  }
  inputResources(session: NativeDesktopSession): ResourceRequest[] {
    return [desktopResourceKey(session), desktopProfileKey(session)].map((key) => ({
      key,
      units: 1,
      mode: "exclusive",
    }));
  }
  async session(owner: string, id?: string) {
    const session = await this.transport.session(owner);
    if (id && id !== session.id)
      throw new AppError("Desktop session belongs to another executor or account", 403);
    return session;
  }
  private async device(owner: string, id: string) {
    const device = await this.db.get<{ owner: string; revokedAt: number | null }>(
      "system",
      "device-sessions",
      id,
    );
    if (!device || device.owner !== owner || device.revokedAt !== null)
      throw new AppError("Desktop device is missing, belongs to another owner or was revoked", 403);
  }
  private async state(owner: string, session: NativeDesktopSession): Promise<ControlRecord> {
    const value = await this.db.get<ControlRecord>(owner, "desktop-control", session.id);
    if (value && value.generation === session.sessionGeneration) return value;
    const fresh: ControlRecord = {
      id: session.id,
      generation: session.sessionGeneration,
      control: "agent",
      revision: 0,
    };
    if (value) {
      // A reconciled, freshly preflighted fixed session generation supersedes
      // the old display. Release only its exact resource handles.
      if (
        await this.db.compareAndSwap(
          owner,
          "desktop-control",
          session.id,
          { generation: value.generation, revision: value.revision },
          fresh,
        )
      ) {
        await Promise.all((value.leases ?? []).map((lease) => this.resources.release(lease)));
        for (const hold of await this.db.list<DesktopHold>(owner, "desktop-operation-holds"))
          if (
            !hold.complete &&
            hold.sessionId === session.id &&
            hold.generation !== session.sessionGeneration
          ) {
            await Promise.all(hold.leases.map((lease) => this.resources.release(lease)));
            await this.db.compareAndSwap(
              owner,
              "desktop-operation-holds",
              hold.id,
              {},
              { complete: true },
            );
          }
      } else return this.state(owner, session);
    }
    return fresh;
  }
  async status(owner: string) {
    const session = await this.session(owner);
    const state = await this.state(owner, session);
    return {
      ...session,
      control: state.control,
      revision: state.revision,
      runtimePaused: (await this.pause.get(owner)).paused,
    };
  }
  private async dispatch(
    owner: string,
    session: NativeDesktopSession,
    kind: "desktop" | "browser",
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    return this.transport.request(
      owner,
      session,
      kind,
      { ...args, sessionId: session.id, sessionGeneration: session.sessionGeneration },
      signal,
    );
  }
  private async trackHold(
    owner: string,
    session: NativeDesktopSession,
    operationId: string,
    leases: ResourceLease[],
  ) {
    for (const lease of leases)
      if (!(await this.resources.hold(lease))) throw new ResourceBusyError([]);
    await this.db.insertIfAbsent<DesktopHold>(owner, "desktop-operation-holds", {
      id: operationId,
      sessionId: session.id,
      generation: session.sessionGeneration,
      leases,
      complete: false,
    });
  }
  private async pendingHolds(owner: string, ids: string[]) {
    let pending = false;
    for (const id of ids) {
      const delivery = await this.db.get<{
        receipt?: { status: string; data?: { cleanupConfirmed?: boolean } };
      }>("__executors__", "deliveries", id);
      if (
        !delivery?.receipt ||
        delivery.receipt.status === "running" ||
        (delivery.receipt.status === "outcome_unknown" &&
          delivery.receipt.data?.cleanupConfirmed !== true)
      )
        pending = true;
      else
        await this.db.compareAndSwap(owner, "desktop-operation-holds", id, {}, { complete: true });
    }
    return pending;
  }
  async run<T>(
    owner: string,
    session: NativeDesktopSession,
    effect: boolean,
    operation: (control: ControlRecord) => Promise<T>,
    signal?: AbortSignal,
  ) {
    const state = await this.state(owner, session);
    if (effect && state.control !== "agent")
      throw new BrowserError(
        "BROWSER_CONTROLLED",
        "Desktop is under human control; hand it back to resume this task",
        409,
        session.browserSessionId,
      );
    if (effect) await this.pause.assertResumed(owner);
    const existing = currentComputerResourceScope(owner);
    if (existing) {
      // A compound upload can inspect a workspace file between DOM effects.
      // Restore this exact GUI primitive after the file scope unwinds; never
      // reuse the nested file primitive after its handles have been released.
      await authorizeTaskEffect(existing.leases, existing.resourceHoldTaskId);
      return operation(state);
    }
    const lockId = `desktop-operation:${randomUUID()}`;
    const requests: ResourceRequest[] = [
      ...(effect ? this.inputResources(session) : []),
      { key: `system-admin:${session.hostId}`, units: 1, mode: "shared" },
    ];
    const leases = await this.resources.acquire(owner, lockId, requests);
    if (!leases) throw new ResourceBusyError(requests);
    const holds: string[] = [];
    try {
      await authorizeTaskEffect(leases, lockId);
      return await physicalComputerResources.run(
        {
          owner,
          resourceHoldTaskId: lockId,
          leases,
          trackNativeOperation: async (id) => {
            holds.push(id);
            await this.trackHold(owner, session, id, leases);
          },
        },
        async () => {
          const latest = await this.state(owner, session);
          if (effect && latest.control !== "agent")
            throw new BrowserError(
              "BROWSER_CONTROLLED",
              "Desktop is under human control",
              409,
              session.browserSessionId,
            );
          if (effect) await this.pause.assertResumed(owner);
          return operation(latest);
        },
      );
    } finally {
      if (!(await this.pendingHolds(owner, holds)))
        await Promise.all(leases.map((lease) => this.resources.release(lease)));
    }
  }
  async observe(owner: string, id?: string, signal?: AbortSignal, previousImage?: string) {
    const session = await this.session(owner, id);
    if ((await this.pause.get(owner)).paused) {
      const frame = await this.db.get<LiveDesktopFrame>(
        owner,
        "desktop-live-frames",
        `${session.executorId}:desktop`,
      );
      if (
        !frame ||
        frame.epoch !== session.executorEpoch ||
        frame.sessionId !== session.id ||
        frame.sessionGeneration !== session.sessionGeneration ||
        !frame.observedAt
      )
        throw new AppError("Desktop is paused; no frame from this session is available yet", 409);
      // The managed UID is frozen. Keep inspection available without claiming
      // fresh pixels or granting an input binding from this cached observation.
      const cached = desktopFrameSchema.parse({ ...frame, paused: true, imageUnchanged: false });
      return { ...cached, sessionId: session.id, executorEpoch: session.executorEpoch };
    }
    return this.run(
      owner,
      session,
      false,
      async (state) => {
        const frame = desktopFrameSchema.parse(
          await this.dispatch(
            owner,
            session,
            "desktop",
            {
              operation: "observe",
              controlRevision: state.revision,
              ...(previousImage ? { previousImage } : {}),
            },
            signal,
          ),
        );
        if (
          frame.sessionGeneration !== session.sessionGeneration ||
          frame.width !== session.width ||
          frame.height !== session.height
        )
          throw new AppError("Desktop returned stale session or frame dimensions", 409);
        return { ...frame, sessionId: session.id, executorEpoch: session.executorEpoch };
      },
      signal,
    );
  }
  async observeForAgent(owner: string, id?: string, signal?: AbortSignal) {
    const frame = await this.observe(owner, id, signal);
    if (!frame.image || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.image))
      throw new AppError("Desktop image is unavailable", 502);
    const asset = await this.assets.save(owner, Buffer.from(frame.image, "base64"), "image/png");
    const { image: _image, ...metadata } = frame;
    return {
      ...metadata,
      screenshotId: asset.id,
      browserScreenshot: true,
      desktopScreenshot: true,
      imageBytes: asset.size,
      imageInput: "vision-required",
    };
  }
  private input(session: NativeDesktopSession, raw: unknown): DesktopInput {
    const parsed = desktopInputSchema.parse(raw);
    if (
      parsed.sessionGeneration !== session.sessionGeneration ||
      parsed.width !== session.width ||
      parsed.height !== session.height
    )
      throw new AppError("Desktop frame generation or dimensions are stale", 409);
    return parsed;
  }
  async act(owner: string, id: string, raw: unknown, signal?: AbortSignal) {
    const session = await this.session(owner, id);
    if (
      (
        await this.db.list<{ status: string; kind: string; sessionId: string }>(
          owner,
          "credential-challenges",
        )
      ).some(
        (item) =>
          item.sessionId === session.browserSessionId &&
          item.kind === "captcha" &&
          ["waiting", "outcome_unknown"].includes(item.status),
      )
    )
      throw new AppError(
        "Use connection_challenge for CAPTCHA, or let the person Take control",
        409,
      );
    const input = this.input(session, raw);
    return this.run(
      owner,
      session,
      true,
      (state) =>
        this.dispatch(
          owner,
          session,
          "desktop",
          {
            operation: "act",
            actor: "agent",
            controlRevision: state.revision,
            binding: {
              sessionGeneration: input.sessionGeneration,
              frameId: input.frameId,
              width: input.width,
              height: input.height,
            },
            action: input.action,
          },
          signal,
        ),
      signal,
    );
  }
  private async reset(owner: string, session: NativeDesktopSession, state: ControlRecord) {
    await this.run(owner, session, false, () =>
      this.dispatch(owner, session, "desktop", {
        operation: "reset",
        controlRevision: state.revision,
        control: state.control === "agent" ? "agent" : "human",
        ...(state.grantId ? { grantId: state.grantId } : {}),
      }),
    );
    for (const hold of await this.db.list<DesktopHold>(owner, "desktop-operation-holds"))
      if (
        !hold.complete &&
        hold.sessionId === session.id &&
        hold.generation === session.sessionGeneration
      ) {
        await Promise.all(hold.leases.map((lease) => this.resources.release(lease)));
        await this.db.compareAndSwap(
          owner,
          "desktop-operation-holds",
          hold.id,
          {},
          { complete: true },
        );
      }
  }
  async takeControl(owner: string, id: string, deviceId: string): Promise<DesktopControl> {
    await this.device(owner, deviceId);
    await this.pause.assertResumed(owner);
    const session = await this.session(owner, id),
      current = await this.state(owner, session);
    if (
      current.control !== "agent" &&
      current.deviceId !== deviceId &&
      (current.expiresAt ?? 0) > this.now()
    )
      throw new AppError("Another desktop control grant is active; release it first", 409);
    const pending: ControlRecord = {
      id,
      generation: session.sessionGeneration,
      control: "changing",
      revision: current.revision + 1,
      deviceId,
      grantId: randomUUID(),
      expiresAt: this.now() + 30_000,
      leaseTaskId: `desktop-human:${randomUUID()}`,
    };
    const prior = await this.db.get<ControlRecord>(owner, "desktop-control", id);
    const claimed = prior
      ? await this.db.compareAndSwap(
          owner,
          "desktop-control",
          id,
          { revision: prior.revision, control: prior.control },
          pending,
        )
      : await this.db.insertIfAbsent(owner, "desktop-control", pending);
    if (!claimed) throw new AppError("Desktop control changed concurrently", 409);
    await this.reset(owner, session, pending);
    await Promise.all((current.leases ?? []).map((lease) => this.resources.release(lease)));
    const leases = await this.resources.acquire(
      owner,
      pending.leaseTaskId!,
      this.inputResources(session),
    );
    if (!leases) throw new ResourceBusyError(this.inputResources(session));
    for (const lease of leases)
      if (!(await this.resources.hold(lease)))
        throw new ResourceBusyError(this.inputResources(session));
    const active = { ...pending, control: "human" as const, leases };
    await this.db.compareAndSwap(
      owner,
      "desktop-control",
      id,
      { revision: pending.revision, control: "changing" },
      active,
    );
    return {
      control: active.control,
      revision: active.revision,
      grantId: active.grantId,
      expiresAt: active.expiresAt,
    };
  }
  private async human(owner: string, id: string, deviceId: string, grantId: string) {
    await this.device(owner, deviceId);
    const session = await this.session(owner, id),
      state = await this.state(owner, session);
    if (state.control !== "human" || state.deviceId !== deviceId || state.grantId !== grantId)
      throw new AppError("Desktop device or control grant changed", 403);
    return { session, state };
  }
  async renewControl(owner: string, id: string, deviceId: string, grantId: string) {
    const { state } = await this.human(owner, id, deviceId, grantId);
    const expiresAt = this.now() + 30_000;
    if (
      !(await this.db.compareAndSwap(
        owner,
        "desktop-control",
        id,
        { revision: state.revision, grantId },
        { expiresAt },
      ))
    )
      throw new AppError("Desktop control grant changed", 409);
    return { control: "human" as const, revision: state.revision, grantId, expiresAt };
  }
  async humanAct(owner: string, id: string, deviceId: string, grantId: string, raw: unknown) {
    const { session, state } = await this.human(owner, id, deviceId, grantId),
      input = this.input(session, raw);
    await this.pause.assertResumed(owner);
    if ((state.expiresAt ?? 0) <= this.now())
      throw new AppError("Desktop control connection expired; reconnect before sending input", 409);
    const admin = await this.resources.acquire(owner, state.leaseTaskId!, [
      { key: `system-admin:${session.hostId}`, units: 1, mode: "shared" },
    ]);
    if (!admin) throw new ResourceBusyError([]);
    const holds: string[] = [];
    try {
      return await physicalComputerResources.run(
        {
          owner,
          resourceHoldTaskId: state.leaseTaskId!,
          leases: [...(state.leases ?? []), ...admin],
          trackNativeOperation: async (operationId) => {
            holds.push(operationId);
            // GUI/profile remain held by the human grant. Retain the temporary
            // shared admin handle too until physical cleanup is confirmed.
            await this.trackHold(owner, session, operationId, admin);
          },
        },
        () =>
          this.dispatch(owner, session, "desktop", {
            operation: "act",
            actor: "human",
            grantId,
            controlRevision: state.revision,
            binding: {
              sessionGeneration: input.sessionGeneration,
              frameId: input.frameId,
              width: input.width,
              height: input.height,
            },
            action: input.action,
          }),
      );
    } finally {
      if (!(await this.pendingHolds(owner, holds)))
        await Promise.all(admin.map((lease) => this.resources.release(lease)));
    }
  }
  async releaseControl(
    owner: string,
    id: string,
    deviceId: string,
    grantId: string,
  ): Promise<DesktopControl> {
    const { session, state } = await this.human(owner, id, deviceId, grantId);
    await this.pause.assertResumed(owner);
    const next: ControlRecord = {
      id,
      generation: session.sessionGeneration,
      revision: state.revision + 1,
      control: "agent",
    };
    if (
      !(await this.db.compareAndSwap(
        owner,
        "desktop-control",
        id,
        { revision: state.revision, grantId },
        { control: "changing" },
      ))
    )
      throw new AppError("Desktop control changed concurrently", 409);
    await this.reset(owner, session, next);
    await Promise.all((state.leases ?? []).map((lease) => this.resources.release(lease)));
    await this.db.compareAndSwap(
      owner,
      "desktop-control",
      id,
      { revision: state.revision, control: "changing" },
      next,
    );
    await this.wake?.(owner, session.browserSessionId);
    return { control: "agent", revision: next.revision };
  }
  async browserRequest(
    owner: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const session = await this.session(owner);
    const match = /^\/sessions\/([^/]+)\/([a-z-]+)(?:\/([^/]+))?$/.exec(path);
    const operation = match?.[3] && match[2] === "downloads" ? "download" : (match?.[2] ?? "open");
    if (match?.[3] && match[2] !== "downloads")
      throw new AppError("Native browser operation not found", 404);
    if (!match && !["/sessions", "/sessions/human"].includes(path))
      throw new AppError("Native browser operation not found", 404);
    if (match && match[1] !== session.browserSessionId)
      throw new AppError("Native browser belongs to another desktop/profile", 403);
    if (operation === "control" && body === undefined) {
      const saved = await this.db.get<Record<string, unknown>>(
        owner,
        "browsers",
        session.browserSessionId,
      );
      return Response.json({ ...saved, control: (await this.state(owner, session)).control });
    }
    if (["input", "control", "reviewed-act"].includes(operation))
      throw new AppError("Use the authenticated desktop viewer for native input and control", 409);
    const effect = [
      "open",
      "act",
      "navigate",
      "agent-navigate",
      "back",
      "close",
      "upload",
      "challenge",
      "search",
    ].includes(operation);
    const result = await this.run(
      owner,
      session,
      effect,
      (state) =>
        this.dispatch(
          owner,
          session,
          "browser",
          {
            operation,
            browserSessionId: session.browserSessionId,
            actor: "agent",
            controlRevision: state.revision,
            body: operation === "download" ? { downloadId: match![3] } : (body ?? {}),
          },
          signal,
        ),
      signal,
    );
    if (operation === "download") {
      const bytes = Buffer.from(String(result.base64), "base64");
      if (
        bytes.length > nativeDownloadLimit ||
        bytes.length !== result.size ||
        createHash("sha256").update(bytes).digest("hex") !== result.sha256 ||
        result.id !== match![3]
      )
        throw new AppError("Native browser download binding changed", 409);
      return new Response(bytes, { headers: { "Content-Type": String(result.mimeType) } });
    }
    if (operation === "screenshot")
      return new Response(Buffer.from(String(result.image), "base64"), {
        headers: { "Content-Type": "image/png" },
      });
    return Response.json(result);
  }
}
