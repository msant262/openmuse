import { randomUUID } from "node:crypto";
import type { CDPSession, Page } from "playwright";
import { z } from "zod";
import { WorkerError } from "./errors.ts";

export type BrowserHarnessScope = { owner: string; conversation: string; name: string };
type Params = Record<string, unknown>;
type Target = { targetId: string; page: Page; kind: "page" | "iframe" };
type Session = { id: string; wire: string; target: Target; state: State };
type State = {
  scope: BrowserHarnessScope;
  targets: Map<string, Target>;
  sessions: Map<string, Session>;
  current?: Session;
  events: { method: string; params: unknown; session_id: string }[];
  eventBytes: number;
  dialog?: unknown;
};
export const browserHarnessRequestSchema = z
  .object({
    meta: z.string().min(1).max(64).optional(),
    method: z
      .string()
      .regex(/^[A-Za-z]+\.[A-Za-z0-9]+$/)
      .optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    session_id: z.string().min(1).max(256).nullable().optional(),
    target_id: z.string().min(1).max(256).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.meta) !== Boolean(value.method));

/** Original helper CDP/meta protocol over Chromium's existing CDP pipe.
 * Session IDs are opaque references to targets owned by one task conversation.
 * Mandatory host hooks retain policy, protected screenshots and redaction.
 * This driver alone does not declare backend availability or tool registration. */
type DriverOptions = {
  cdp: CDPSession;
  createPage: (scope: BrowserHarnessScope) => Promise<{ page: Page; targetId: string }>;
  guard: (scope: BrowserHarnessScope) => void;
  authorize: (
    scope: BrowserHarnessScope,
    page: Page | undefined,
    method: string,
    params: Params,
  ) => Promise<void>;
  screenshot: (scope: BrowserHarnessScope, page: Page, params: Params) => Promise<Params>;
  execute?: (
    scope: BrowserHarnessScope,
    page: Page,
    method: string,
    params: Params,
  ) => Promise<Params | undefined>;
  redact: (value: unknown) => unknown;
};
export class BrowserHarnessDriver {
  private states = new Map<string, State>();
  private wires = new Map<string, Session>();
  private pending = new Map<
    string,
    {
      resolve: (value: Params) => void;
      reject: (error: Error) => void;
    }
  >();
  private sequence = 0;
  private closed = false;
  private readonly options: DriverOptions;
  constructor(options: DriverOptions) {
    this.options = options;
    options.cdp.on("Target.receivedMessageFromTarget", this.received);
    options.cdp.on("Target.detachedFromTarget", this.detached);
  }
  private guard(scope: BrowserHarnessScope) {
    if (this.closed)
      throw new WorkerError("BROWSER_SCRIPT_CLOSED", "Browser script driver is closed", 409);
    if (!scope.owner || !scope.conversation || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(scope.name))
      throw new WorkerError(
        "INVALID_BROWSER_SCRIPT_SCOPE",
        "Owned browser program scope is required",
        422,
      );
    this.options.guard(scope);
  }
  private async browser(scope: BrowserHarnessScope, method: string, params: Params = {}) {
    this.guard(scope);
    const value = (await this.options.cdp.send(method as never, params as never)) as Params;
    this.guard(scope);
    return value;
  }
  private received = (event: { sessionId: string; message: string }) => {
    const session = this.wires.get(event.sessionId);
    if (!session || Buffer.byteLength(event.message) > 8 * 1024 ** 2) return;
    let value: Params;
    try {
      value = JSON.parse(event.message);
    } catch {
      return;
    }
    if (typeof value.id === "number") {
      this.pending.get(`${event.sessionId}:${value.id}`)?.resolve(value);
      return;
    }
    if (typeof value.method !== "string") return;
    const entry = {
      method: value.method,
      params: this.options.redact(value.params ?? {}),
      session_id: session.id,
    };
    const bytes = Buffer.byteLength(JSON.stringify(entry));
    // The original daemon retains at most 500 events. Bound their total bytes too.
    if (bytes > 2 * 1024 ** 2) return;
    session.state.events.push(entry);
    session.state.eventBytes += bytes;
    while (session.state.events.length > 500 || session.state.eventBytes > 2 * 1024 ** 2) {
      session.state.eventBytes -= Buffer.byteLength(JSON.stringify(session.state.events.shift()));
    }
    if (value.method === "Page.javascriptDialogOpening") session.state.dialog = entry.params;
    if (value.method === "Page.javascriptDialogClosed") session.state.dialog = undefined;
  };
  private detached = (event: { sessionId: string }) => {
    const session = this.wires.get(event.sessionId);
    if (!session) return;
    this.wires.delete(event.sessionId);
    session.state.sessions.delete(session.id);
    for (const [key, request] of this.pending) {
      if (key.startsWith(`${event.sessionId}:`)) {
        request.reject(new Error("Browser CDP session detached; command outcome is unconfirmed"));
        this.pending.delete(key);
      }
    }
  };
  private async send(
    session: Session,
    method: string,
    params: Params,
    timeoutMs: number,
  ): Promise<Params> {
    this.guard(session.state.scope);
    if (!this.wires.has(session.wire) || session.target.page.isClosed())
      throw new WorkerError(
        "BROWSER_SCRIPT_SESSION_LOST",
        "Owned browser session is closed; no command was replayed",
        409,
      );
    const key = `${session.wire}:${++this.sequence}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reply = new Promise<Params>((resolve, reject) => {
      this.pending.set(key, { resolve, reject });
      timer = setTimeout(
        () => reject(new Error("Browser CDP reply timed out; command outcome is unconfirmed")),
        timeoutMs,
      );
    });
    // The root send may still be awaiting its acknowledgement when the child
    // detaches/times out. Observe rejection immediately, then propagate below.
    void reply.catch(() => {});
    try {
      // Each child target uses a nested CDP session on the already-owned pipe.
      // No debugging URL/port or browser credential reaches the Python process.
      await this.browser(session.state.scope, "Target.sendMessageToTarget", {
        sessionId: session.wire,
        message: JSON.stringify({ id: this.sequence, method, params }),
      });
      const result = await reply;
      this.guard(session.state.scope);
      if (result.error)
        return { error: String((result.error as Params).message ?? "Browser CDP command failed") };
      return { result: this.options.redact(result.result ?? {}) };
    } finally {
      if (timer) clearTimeout(timer);
      this.pending.delete(key);
    }
  }
  private async attach(state: State, target: Target, timeoutMs: number) {
    const response = await this.browser(state.scope, "Target.attachToTarget", {
      targetId: target.targetId,
      flatten: false,
    });
    const session: Session = { id: randomUUID(), wire: String(response.sessionId), target, state };
    state.sessions.set(session.id, session);
    this.wires.set(session.wire, session);
    await this.enable(session, timeoutMs);
    return session;
  }
  private async enable(session: Session, timeoutMs: number) {
    await Promise.all(
      ["Page", "DOM", "Runtime", "Network"].map(async (domain) => {
        const { state, target } = session;
        await this.options.authorize(state.scope, target.page, `${domain}.enable`, {});
        await this.send(session, `${domain}.enable`, {}, Math.min(timeoutMs, 4000));
      }),
    );
  }
  private async create(state: State) {
    this.guard(state.scope);
    const created = await this.options.createPage(state.scope);
    try {
      this.guard(state.scope);
    } catch (error) {
      await created.page.close();
      throw error;
    }
    const target: Target = { ...created, kind: "page" };
    state.targets.set(target.targetId, target);
    return target;
  }
  private async state(scope: BrowserHarnessScope, timeoutMs: number) {
    const key = JSON.stringify([scope.owner, scope.conversation, scope.name]);
    let state = this.states.get(key);
    if (!state) {
      state = {
        scope: { ...scope },
        targets: new Map(),
        sessions: new Map(),
        events: [],
        eventBytes: 0,
      };
      this.states.set(key, state);
      try {
        state.current = await this.attach(state, await this.create(state), timeoutMs);
      } catch (error) {
        this.states.delete(key);
        await this.closeState(state);
        throw error;
      }
    }
    return state;
  }
  private target(state: State, id: unknown) {
    const target = typeof id === "string" && state.targets.get(id);
    if (!target || target.page.isClosed())
      throw new WorkerError(
        "BROWSER_SCRIPT_FOREIGN_TARGET",
        "Target is not owned by this browser program",
        403,
      );
    return target;
  }
  private session(state: State, id: unknown) {
    const session = id ? state.sessions.get(String(id)) : state.current;
    if (!session || !this.wires.has(session.wire) || session.target.page.isClosed())
      throw new WorkerError(
        "BROWSER_SCRIPT_FOREIGN_SESSION",
        "Session is not owned by this browser program; no redirect or replay occurred",
        403,
      );
    return session;
  }
  private async info(state: State, target: Target) {
    const value = await this.browser(state.scope, "Target.getTargetInfo", {
      targetId: target.targetId,
    });
    return this.options.redact(value.targetInfo) as Params;
  }
  private async discoverFrames(state: State, timeoutMs: number) {
    const value = await this.browser(state.scope, "Target.getTargets");
    const infos = Array.isArray(value.targetInfos) ? (value.targetInfos as Params[]) : [];
    const owners = new Map<string, Page>();
    for (const target of state.targets.values()) {
      if (target.kind !== "page" || target.page.isClosed()) continue;
      owners.set(target.targetId, target.page);
      const session = [...state.sessions.values()].find(
        (session) => session.target === target && this.wires.has(session.wire),
      );
      if (!session) continue;
      await this.options.authorize(state.scope, target.page, "Page.getFrameTree", {});
      const response = await this.send(session, "Page.getFrameTree", {}, timeoutMs);
      if (response.error)
        throw new WorkerError(
          "BROWSER_SCRIPT_FRAME_OBSERVATION",
          "Owned frame tree could not be observed",
          409,
        );
      const pending: unknown[] = [(response.result as Params)?.frameTree];
      while (pending.length) {
        const entry = pending.pop();
        if (!entry || typeof entry !== "object") continue;
        const tree = entry as Params,
          frame = tree.frame as Params | undefined;
        if (typeof frame?.id === "string") owners.set(frame.id, target.page);
        if (Array.isArray(tree.childFrames)) pending.push(...tree.childFrames);
      }
    }
    const observed = new Set<string>();
    // OOP children are omitted from Page.getFrameTree in Chromium. Their
    // browser target parentId/parentFrameId supplies the ownership edge. Resolve
    // arbitrary ordering and nested OOP targets from already-owned ancestors.
    let changed = true;
    while (changed) {
      changed = false;
      for (const info of infos) {
        if (
          info.type !== "iframe" ||
          typeof info.targetId !== "string" ||
          observed.has(info.targetId)
        )
          continue;
        const page =
          owners.get(info.targetId) ??
          (typeof info.parentId === "string" ? owners.get(info.parentId) : undefined) ??
          (typeof info.parentFrameId === "string" ? owners.get(info.parentFrameId) : undefined);
        if (!page) continue;
        owners.set(info.targetId, page);
        observed.add(info.targetId);
        state.targets.set(info.targetId, { targetId: info.targetId, page, kind: "iframe" });
        changed = true;
      }
    }
    for (const [id, target] of state.targets) {
      if (target.kind !== "iframe" || observed.has(id)) continue;
      state.targets.delete(id);
      for (const session of state.sessions.values())
        if (session.target.targetId === id) this.detached({ sessionId: session.wire });
    }
  }
  async handle(scope: BrowserHarnessScope, raw: unknown, timeoutMs = 5000): Promise<Params> {
    this.guard(scope);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1800000)
      throw new WorkerError(
        "INVALID_BROWSER_SCRIPT_DEADLINE",
        "Browser command deadline is invalid",
        422,
      );
    const request = browserHarnessRequestSchema.parse(raw),
      state = await this.state(scope, timeoutMs);
    if (request.meta) {
      switch (request.meta) {
        case "ping":
          return { pong: true, browser_kind: "native" };
        case "drain_events": {
          const events = state.events.splice(0);
          state.eventBytes = 0;
          return { events };
        }
        case "session":
          return { session_id: this.session(state, undefined).id };
        case "pending_dialog":
          return { dialog: state.dialog ?? null };
        case "current_tab":
          return this.info(state, this.session(state, undefined).target);
        case "connection_status": {
          const current = this.session(state, undefined),
            page = await this.info(state, current.target);
          return { target_id: current.target.targetId, session_id: current.id, page };
        }
        case "set_session": {
          const next = this.session(state, request.session_id);
          if (request.target_id && request.target_id !== next.target.targetId)
            throw new WorkerError(
              "BROWSER_SCRIPT_FOREIGN_TARGET",
              "Target differs from its owned session",
              403,
            );
          const previous = state.current;
          state.current = next;
          await Promise.all([
            this.enable(next, timeoutMs),
            ...(previous &&
            previous !== next &&
            this.wires.has(previous.wire) &&
            !previous.target.page.isClosed()
              ? [this.send(previous, "Network.disable", {}, Math.min(timeoutMs, 2000))]
              : []),
          ]);
          return { session_id: next.id };
        }
        case "shutdown":
          await this.closeState(state);
          this.states.delete(JSON.stringify([scope.owner, scope.conversation, scope.name]));
          return { ok: true };
        default:
          throw new WorkerError(
            "INVALID_BROWSER_SCRIPT_META",
            "Unsupported browser helper meta command",
            422,
          );
      }
    }
    const method = request.method,
      params = request.params ?? {};
    if (!method)
      throw new WorkerError(
        "INVALID_BROWSER_SCRIPT_METHOD",
        "Browser command method is missing",
        422,
      );
    // Target.* is browser-level in the original daemon. It cannot depend on a
    // surviving current renderer or silently route an explicit foreign session.
    const current = method.startsWith("Target.")
      ? undefined
      : this.session(state, request.session_id);
    const policyTarget =
      method.startsWith("Target.") && params.targetId
        ? this.target(state, params.targetId)
        : current?.target;
    await this.options.authorize(scope, policyTarget?.page, method, params);
    this.guard(scope);
    if (method === "Target.getTargets") {
      await this.discoverFrames(state, timeoutMs);
      const targetInfos = await Promise.all(
        [...state.targets.values()]
          .filter((target) => !target.page.isClosed())
          .map((target) => this.info(state, target)),
      );
      return { result: { targetInfos } };
    }
    if (method === "Target.getTargetInfo")
      return {
        result: {
          targetInfo: await this.info(
            state,
            this.target(state, params.targetId ?? state.current?.target.targetId),
          ),
        },
      };
    if (method === "Target.createTarget") {
      const created = await this.create(state);
      // Helpers create blank, attach, then navigate. Never race target creation and navigation.
      if (params.url && params.url !== "about:blank") {
        await this.options.authorize(scope, created.page, "Page.navigate", { url: params.url });
        await this.send(
          await this.attach(state, created, timeoutMs),
          "Page.navigate",
          { url: params.url },
          timeoutMs,
        );
      }
      return { result: { targetId: created.targetId } };
    }
    if (method === "Target.attachToTarget")
      return {
        result: {
          sessionId: (await this.attach(state, this.target(state, params.targetId), timeoutMs)).id,
        },
      };
    if (method === "Target.activateTarget") {
      await this.target(state, params.targetId).page.bringToFront();
      this.guard(scope);
      return { result: {} };
    }
    if (method === "Target.closeTarget") {
      const target = this.target(state, params.targetId);
      if (target.kind === "iframe")
        await this.browser(scope, method, { targetId: target.targetId });
      else await target.page.close();
      state.targets.delete(target.targetId);
      this.guard(scope);
      return { result: { success: true } };
    }
    if (method === "Target.detachFromTarget") {
      const session = this.session(state, params.sessionId);
      const result = await this.browser(scope, method, { sessionId: session.wire });
      this.detached({ sessionId: session.wire });
      return { result };
    }
    if (method.startsWith("Target."))
      throw new WorkerError(
        "BROWSER_SCRIPT_TARGET_SCOPE",
        "This browser-level target command has no owned routing",
        403,
      );
    if (!current)
      throw new WorkerError(
        "BROWSER_SCRIPT_SESSION_LOST",
        "Owned browser session is unavailable",
        409,
      );
    if (method === "Page.captureScreenshot") {
      const result = await this.options.screenshot(scope, current.target.page, params);
      this.guard(scope);
      return { result };
    }
    const intercepted = await this.options.execute?.(scope, current.target.page, method, params);
    this.guard(scope);
    if (intercepted !== undefined) return { result: this.options.redact(intercepted) };
    if (method.startsWith("Browser."))
      return { result: this.options.redact(await this.browser(scope, method, params)) };
    return this.send(current, method, params, timeoutMs);
  }
  private async closeState(state: State) {
    for (const session of state.sessions.values()) this.detached({ sessionId: session.wire });
    for (const target of state.targets.values())
      if (target.kind === "page" && !target.page.isClosed()) await target.page.close();
    state.targets.clear();
    state.sessions.clear();
    state.events.length = 0;
    state.eventBytes = 0;
  }
  currentPage(scope: BrowserHarnessScope): Page | undefined {
    return this.states.get(JSON.stringify([scope.owner, scope.conversation, scope.name]))?.current
      ?.target.page;
  }
  ownedPages(scope: BrowserHarnessScope): Page[] {
    const state = this.states.get(JSON.stringify([scope.owner, scope.conversation, scope.name]));
    return state
      ? [
          ...new Set(
            [...state.targets.values()]
              .filter((target) => !target.page.isClosed())
              .map((target) => target.page),
          ),
        ]
      : [];
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.options.cdp.off("Target.receivedMessageFromTarget", this.received);
    this.options.cdp.off("Target.detachedFromTarget", this.detached);
    for (const state of this.states.values()) await this.closeState(state);
    this.states.clear();
    this.wires.clear();
  }
}
