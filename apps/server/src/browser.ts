import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type BrowserPaymentBinding,
  signBrowserAuthorization,
} from "../../../packages/domain/src/browser-payment.ts";
import type { BrowserSession } from "../../../packages/domain/src/index.ts";
import { ActionLog, auditTarget } from "./action-log.ts";
import { approvalPolicy } from "./action-policy.ts";
import type { ActionService } from "./actions.ts";
import type { Auth } from "./auth.ts";
import { BrowserAssets } from "./browser-assets.ts";
import { browserConsole } from "./browser-console.ts";
import { BrowserError, browserActionSchema, snapshotSchema } from "./browser-contract.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { ResourceBusyError, ResourceLeases } from "./engine/resource-leases.ts";
import { RuntimePause } from "./engine/runtime-pause.ts";
import { authorizeTaskEffect } from "./engine/task-journal.ts";
import { AppError } from "./errors.ts";
import type { Files } from "./files.ts";

const sessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  status: z.enum(["idle", "active", "closed", "error"]),
  updatedAt: z.string(),
  control: z.enum(["agent", "human"]).optional(),
});
const readSchema = z.object({
  url: z.string(),
  title: z.string().max(300),
  text: z.string().max(100_000),
  truncated: z.boolean(),
});
const failureSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  message: z.string(),
  createdAt: z.string(),
});
type ChatBrowser = { id: string; sessionId: string };

export class BrowserService {
  private actions?: ActionService;
  private readonly log: ActionLog;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly assets: BrowserAssets;
  private readonly resourceLeases: ResourceLeases;
  private readonly runtimePause: RuntimePause;
  private health?: { checkedAt: number; reachable: Promise<boolean> };
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly auth: Auth,
    private readonly files: Files,
    private readonly now: () => number = Date.now,
  ) {
    this.assets = new BrowserAssets(db, config.dataDir);
    this.log = new ActionLog(db);
    this.resourceLeases = new ResourceLeases(db);
    this.runtimePause = new RuntimePause(db);
  }
  configureActions(actions: ActionService) {
    this.actions = actions;
    actions.registerExternal("browser.act", async (owner, raw, proposal, beforeDispatch) => {
      const { sessionId, binding } = raw as { sessionId: string; binding: BrowserPaymentBinding };
      await this.runtimePause.assertResumed(owner);
      const leaseOwner = `browser-review:${proposal.id}`;
      const requests = [
        {
          key: `browser-profile:${this.config.resourceHostId ?? "openmuse-server"}:${sessionId}`,
          units: 1,
          mode: "exclusive" as const,
        },
      ];
      const leases = await this.resourceLeases.acquire(owner, leaseOwner, requests);
      if (!leases) throw new ResourceBusyError(requests);
      let retainForUncertainOutcome = false;
      try {
        return await this.serial(sessionId, async () => {
          await this.get(owner, sessionId);
          if (proposal.taskId) {
            const task = await this.db.get<{ status: string }>(owner, "tasks", proposal.taskId);
            if (!task || !["running", "waiting_approval"].includes(task.status))
              throw new AppError("Task was cancelled or paused before browser dispatch", 409);
          }
          if (!this.config.workerToken) throw new AppError("Browser worker is unavailable", 503);
          const authorization = signBrowserAuthorization(this.config.workerToken, {
            id: proposal.id,
            sessionId,
            binding,
            expiresAt: Date.parse(proposal.expiresAt),
          });
          // A local rejection is known not dispatched. Errors after this barrier
          // require an explicit worker rejection to establish that fact.
          await this.runtimePause.assertResumed(owner);
          await beforeDispatch();
          try {
            const receipt = z
              .object({ id: z.string(), status: z.literal("succeeded") })
              .parse(
                await (
                  await this.request(`/sessions/${sessionId}/reviewed-act`, { authorization })
                ).json(),
              );
            if (receipt.id !== proposal.id) throw new Error("Mismatched browser receipt");
            return `Browser action completed · ${receipt.id}`;
          } catch (error) {
            if (
              error instanceof BrowserError &&
              [
                "STALE_SNAPSHOT",
                "BROWSER_CONTROLLED",
                "SESSION_CLOSED",
                "SESSION_NOT_FOUND",
                "INVALID_APPROVAL",
                "APPROVAL_FAILED",
                "INVALID_ACTION",
              ].includes(error.code)
            )
              throw error;
            throw new BrowserError(
              "OUTCOME_UNKNOWN",
              "The browser could not confirm the reviewed action. Check the site before preparing another action.",
              409,
            );
          }
        });
      } catch (error) {
        if (error instanceof BrowserError && error.code === "OUTCOME_UNKNOWN") {
          // Keep the profile unavailable until the person checks the uncertain
          // remote effect; a lost response cannot prove that the page is idle.
          retainForUncertainOutcome = true;
          await this.resourceLeases.holdTask(leaseOwner);
        }
        throw error;
      } finally {
        if (!retainForUncertainOutcome)
          await Promise.all(leases.map((lease) => this.resourceLeases.release(lease)));
      }
    });
  }
  private ownedRequest(owner: string, path: string, body?: unknown, signal?: AbortSignal) {
    const endpoint = path.split("/")[3] ?? "open";
    const human =
      path === "/sessions/human" ||
      ["input", "navigate", "close"].includes(endpoint) ||
      (endpoint === "control" && body !== undefined);
    return this.log.run(
      owner,
      {
        tool: `browser.${endpoint}`,
        target: "Personal browser",
        summary: `Browser ${endpoint}`,
        actor: human ? "human" : "agent",
      },
      () => this.request(path, body, signal),
    );
  }
  /** Whether the configured worker answers its health check, cached briefly for snapshots. */
  reachable(): Promise<boolean> {
    if (!this.config.workerUrl || !this.config.workerToken) return Promise.resolve(false);
    const now = this.now();
    if (this.health && now - this.health.checkedAt < 15_000) return this.health.reachable;
    const reachable = fetch(`${this.config.workerUrl}/health`, {
      signal: AbortSignal.timeout(2000),
    }).then(
      (response) => response.ok,
      () => false,
    );
    this.health = { checkedAt: now, reachable };
    return reachable;
  }
  private async serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.queues.set(id, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(id) === next) this.queues.delete(id);
    }
  }
  private async request(path: string, body?: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.config.workerUrl || !this.config.workerToken)
      throw new AppError("Browser worker is not configured. Start it using the setup guide.", 503);
    let response: Response;
    try {
      response = await fetch(`${this.config.workerUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${this.config.workerToken}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(45000)])
          : AbortSignal.timeout(45000),
      });
    } catch {
      signal?.throwIfAborted();
      if (path.endsWith("/reviewed-act"))
        throw new BrowserError(
          "OUTCOME_UNKNOWN",
          "The reviewed browser response was lost. Check the site before preparing another action.",
          409,
        );
      throw new AppError(
        "Browser worker is unavailable. Check that its container is running.",
        503,
      );
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new BrowserError(
        typeof payload?.error?.code === "string" ? payload.error.code : "BROWSER_FAILED",
        typeof payload?.error?.message === "string"
          ? payload.error.message
          : "Browser request failed",
        response.status === 409 ? 409 : 502,
        typeof payload?.error?.details?.sessionId === "string"
          ? payload.error.details.sessionId
          : /^\/sessions\/([^/]+)/.exec(path)?.[1],
        payload?.error?.details,
      );
    }
    return response;
  }
  async get(owner: string, id: string) {
    const value = await this.db.get<BrowserSession>(owner, "browsers", id);
    if (!value) throw new AppError("Browser session not found", 404);
    return value;
  }
  decorate(owner: string, session: BrowserSession) {
    return {
      ...session,
      consoleUrl: this.auth.sign(owner, `/api/browsers/${session.id}/console`),
      previewUrl: this.auth.sign(owner, `/api/browsers/${session.id}/preview`),
    };
  }
  private async save(owner: string, payload: unknown, expectedId: string) {
    const session = sessionSchema.parse(payload);
    if (session.id !== expectedId)
      throw new AppError("Browser worker returned a different session", 502);
    await this.db.put(owner, "browsers", session);
    return this.decorate(owner, session);
  }
  async create(owner: string, url: string) {
    const id = (await this.defaultProfile(owner)).sessionId;
    // Record ownership before calling the worker, including when its response is lost.
    await this.db.insertIfAbsent(owner, "browsers", {
      id,
      url,
      title: "New browser session",
      status: "idle",
      updatedAt: new Date().toISOString(),
    });
    return this.reopen(owner, id, url);
  }
  private async openOwned(
    owner: string,
    id: string,
    url?: string,
    signal?: AbortSignal,
    human = false,
  ) {
    const value = await this.get(owner, id);
    const target = url ?? value.url;
    try {
      const response = await this.ownedRequest(
        owner,
        human ? "/sessions/human" : "/sessions",
        { id, url: target },
        signal,
      );
      return await this.save(owner, await response.json(), id);
    } catch (error) {
      if (error instanceof BrowserError && error.code === "BROWSER_CONTROLLED") throw error;
      await this.save(
        owner,
        { ...value, url: target, status: "error", updatedAt: new Date().toISOString() },
        id,
      );
      throw error;
    }
  }
  reopen(owner: string, id: string, url?: string) {
    return this.serial(id, () => this.openOwned(owner, id, url, undefined, true));
  }
  navigate(owner: string, id: string, url: string) {
    return this.reopen(owner, id, url);
  }
  private async readOwned(owner: string, id: string, signal?: AbortSignal) {
    const session = await this.get(owner, id);
    const result = readSchema.parse(
      await (await this.ownedRequest(owner, `/sessions/${id}/read`, undefined, signal)).json(),
    );
    await this.save(
      owner,
      {
        ...session,
        url: result.url,
        title: result.title,
        status: "active",
        updatedAt: new Date().toISOString(),
      },
      id,
    );
    return result;
  }
  read(owner: string, id: string) {
    return this.serial(id, () => this.readOwned(owner, id));
  }
  async runAutomated<T>(
    owner: string,
    taskId: string | undefined,
    sessionId: string | undefined,
    url: string | undefined,
    signal: AbortSignal | undefined,
    effect: boolean,
    operation: (sessionId: string) => Promise<T>,
    guard?: () => Promise<void>,
    trackResources?: (
      leases: import("../../../packages/domain/src/runtime.ts").ResourceLease[],
    ) => void,
  ): Promise<T> {
    const pause = await this.runtimePause.get(owner);
    if (effect) await this.runtimePause.assertResumed(owner);
    const id = sessionId ?? (await this.defaultProfile(owner)).sessionId;
    if (pause.paused && !effect) {
      const saved = await this.db.get<BrowserSession>(owner, "browsers", id);
      if (saved?.status !== "active") await this.runtimePause.assertResumed(owner);
    }
    if (sessionId) await this.get(owner, id);
    else
      await this.db.insertIfAbsent(owner, "browsers", {
        id,
        url: url ?? "https://example.com/",
        title: "Personal browser",
        status: "idle",
        control: "agent",
        updatedAt: new Date().toISOString(),
      });
    const leaseTaskId = taskId ?? `browser-interaction:${randomUUID()}`;
    const requests = [
      {
        key: `browser-profile:${this.config.resourceHostId ?? "openmuse-server"}:${id}`,
        units: 1,
        mode: "exclusive" as const,
      },
    ];
    let leases = await this.resourceLeases.acquire(owner, leaseTaskId, requests);
    // Chat tools are outside the durable task scheduler, but concurrent turns for
    // one profile still need FIFO behavior. Task work reports contention to its
    // scheduler; ephemeral chat calls wait while remaining cancellable.
    while (!leases && !taskId) {
      signal?.throwIfAborted();
      await guard?.();
      if (effect) await this.runtimePause.assertResumed(owner);
      await new Promise((resolve) => setTimeout(resolve, 20));
      leases = await this.resourceLeases.acquire(owner, leaseTaskId, requests);
    }
    if (!leases) throw new ResourceBusyError(requests);
    trackResources?.(leases);
    const renewals = new Set<Promise<unknown>>();
    let leaseLost = false;
    const heartbeat =
      taskId === undefined
        ? setInterval(() => {
            const renewal = Promise.all(
              leases?.map((lease) => this.resourceLeases.renew(lease)) ?? [],
            ).then((renewed) => {
              if (renewed.some((lease) => !lease)) leaseLost = true;
            });
            renewals.add(renewal);
            void renewal.finally(() => renewals.delete(renewal));
          }, 20_000)
        : undefined;
    try {
      await guard?.();
      if (effect) await this.runtimePause.assertResumed(owner);
      if (leaseLost) throw new ResourceBusyError(requests);
      await authorizeTaskEffect();
      const activeId = await this.agentSession(owner, id, url, signal);
      await guard?.();
      if (effect) await this.runtimePause.assertResumed(owner);
      if (leaseLost) throw new ResourceBusyError(requests);
      if (effect) await authorizeTaskEffect();
      return await operation(activeId);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      await Promise.allSettled([...renewals]);
      if (!taskId) await Promise.all(leases.map((lease) => this.resourceLeases.release(lease)));
    }
  }
  async observe(
    owner: string,
    url: string,
    existingId?: string,
    taskId?: string,
    trackResources?: (
      leases: import("../../../packages/domain/src/runtime.ts").ResourceLease[],
    ) => void,
  ) {
    return this.runAutomated(
      owner,
      taskId,
      existingId,
      url,
      undefined,
      true,
      async (id) => {
        return this.serial(id, async () => ({
          sessionId: id,
          ...(await this.readOwned(owner, id)),
        }));
      },
      undefined,
      trackResources,
    );
  }
  async observeForThread(owner: string, threadId: string, url: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    // Persist the association before contacting the worker so failed/lost responses
    // and later chat turns keep using the same profile instead of exhausting its limit.
    const old = await this.db.get<ChatBrowser>(owner, "chat-browsers", threadId);
    const association = await this.defaultProfile(owner, old?.sessionId);
    if (!association) throw new AppError("Could not reserve the chat browser session", 500);
    const id = association.sessionId;
    await this.db.insertIfAbsent(owner, "browsers", {
      id,
      url,
      title: "New browser session",
      status: "idle",
      updatedAt: new Date().toISOString(),
    });
    await this.db.put(owner, "chat-browsers", { id: threadId, sessionId: id });
    return this.runAutomated(owner, undefined, id, url, signal, true, async (activeId) => {
      signal?.throwIfAborted();
      const page = await this.serial(activeId, () => this.readOwned(owner, activeId, signal));
      signal?.throwIfAborted();
      return {
        sessionId: activeId,
        ...page,
        text: page.text.slice(0, 30_000),
        truncated: page.truncated || page.text.length > 30_000,
      };
    });
  }
  private async defaultProfile(owner: string, migratedId?: string): Promise<ChatBrowser> {
    const profile =
      (await this.db.get<ChatBrowser>(owner, "browser-default", "personal")) ??
      (await this.db.insertIfAbsent(owner, "browser-default", {
        id: "personal",
        sessionId: migratedId ?? randomUUID(),
      })) ??
      (await this.db.get<ChatBrowser>(owner, "browser-default", "personal"));
    if (!profile) throw new AppError("Could not reserve the personal browser profile", 500);
    return profile;
  }
  async agentSession(owner: string, sessionId?: string, url?: string, signal?: AbortSignal) {
    const id = sessionId ?? (await this.defaultProfile(owner)).sessionId;
    if (sessionId) await this.get(owner, id);
    else
      await this.db.insertIfAbsent(owner, "browsers", {
        id,
        url: url ?? "https://example.com/",
        title: "Personal browser",
        status: "idle",
        control: "agent",
        updatedAt: new Date().toISOString(),
      });
    return this.serial(id, async () => {
      signal?.throwIfAborted();
      let saved = await this.get(owner, id);
      if (!url && saved.status === "active") saved = await this.control(owner, id);
      if (url || saved.status !== "active") await this.openOwned(owner, id, url, signal);
      return id;
    });
  }
  async snapshot(owner: string, id: string, signal?: AbortSignal) {
    return this.serial(id, async () => {
      await this.get(owner, id);
      const value = snapshotSchema.parse(
        await (
          await this.ownedRequest(owner, `/sessions/${id}/snapshot`, undefined, signal)
        ).json(),
      );
      if (value.sessionId !== id)
        throw new BrowserError("INVALID_SESSION", "The browser returned a different session.");
      await this.save(
        owner,
        {
          id,
          title: value.title,
          url: value.url,
          status: "active",
          control: value.control,
          updatedAt: new Date().toISOString(),
        },
        id,
      );
      return value;
    });
  }
  async act(
    owner: string,
    id: string,
    action: z.infer<typeof browserActionSchema>,
    signal?: AbortSignal,
    taskId?: string,
  ) {
    return this.serial(id, async () => {
      await this.get(owner, id);
      const parsed = browserActionSchema.parse(action);
      const prepareReview = async () => {
        if (!this.actions)
          throw new BrowserError(
            "PAYMENT_APPROVAL_REQUIRED",
            "Native action review is not configured",
            409,
            id,
          );
        const inspected = z
          .object({
            binding: z.object({
              snapshotId: z.uuid(),
              element: z.number().int(),
              action: z.record(z.string(), z.unknown()),
              url: z.url(),
              frameUrl: z.string(),
              fingerprint: z.string(),
              formDigest: z.string(),
              pageDigest: z.string(),
            }),
            label: z.string(),
            requiresApproval: z.boolean(),
          })
          .parse(
            await (
              await this.ownedRequest(owner, `/sessions/${id}/inspect`, parsed, signal)
            ).json(),
          );
        signal?.throwIfAborted();
        if (approvalPolicy(this.config) === "money" && !inspected.requiresApproval)
          throw new BrowserError(
            "STALE_SNAPSHOT",
            "Payment context changed before review. Take a fresh snapshot.",
            409,
            id,
          );
        const key = createHash("sha256")
          .update(JSON.stringify({ id, binding: inspected.binding }))
          .digest("hex");
        const review = await this.actions.proposeExternal(
          owner,
          {
            tool: "browser.act",
            target: auditTarget(inspected.binding.url),
            summary: inspected.requiresApproval
              ? "Approve payment or purchase control"
              : "Approve browser action",
            money: inspected.requiresApproval,
            binding: { sessionId: id, binding: inspected.binding },
            display: {
              sessionId: id,
              element: parsed.element,
              action: parsed.action,
              page: auditTarget(inspected.binding.url),
              label: inspected.label.slice(0, 500),
            },
          },
          key,
          taskId,
        );
        const session = await this.get(owner, id);
        return {
          approvalRequired: review.status === "awaiting_review",
          actionId: review.id,
          status: review.status,
          sessionId: id,
          title: session.title,
          url: session.url,
        };
      };
      if (this.actions && approvalPolicy(this.config) === "all") return prepareReview();
      let payload: unknown;
      try {
        payload = await (
          await this.ownedRequest(owner, `/sessions/${id}/act`, parsed, signal)
        ).json();
      } catch (error) {
        if (
          this.actions &&
          error instanceof BrowserError &&
          error.code === "PAYMENT_APPROVAL_REQUIRED"
        )
          return prepareReview();
        throw error;
      }
      const value = snapshotSchema.parse(payload);
      if (value.sessionId !== id)
        throw new BrowserError("INVALID_SESSION", "The browser returned a different session.");
      await this.save(
        owner,
        {
          id,
          title: value.title,
          url: value.url,
          status: "active",
          control: value.control,
          updatedAt: new Date().toISOString(),
        },
        id,
      );
      return value;
    });
  }
  async control(owner: string, id: string, mode?: "agent" | "human") {
    await this.get(owner, id);
    return this.save(
      owner,
      await (
        await this.ownedRequest(
          owner,
          `/sessions/${id}/control`,
          mode ? { control: mode } : undefined,
        )
      ).json(),
      id,
    );
  }
  async screenshotForAgent(owner: string, id: string, signal?: AbortSignal) {
    await this.get(owner, id);
    const value = z
      .object({
        sessionId: z.uuid(),
        title: z.string(),
        url: z.url(),
        image: z.string().max(1_398_104),
        mimeType: z.literal("image/jpeg"),
        width: z.literal(1280),
        height: z.literal(800),
      })
      .parse(
        await (
          await this.ownedRequest(owner, `/sessions/${id}/agent-screenshot`, undefined, signal)
        ).json(),
      );
    if (value.sessionId !== id || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.image))
      throw new BrowserError("INVALID_SCREENSHOT", "The browser returned an invalid screenshot.");
    const { image, ...safe } = value;
    const asset = await this.assets.save(owner, Buffer.from(image, "base64"));
    return {
      ...safe,
      screenshotId: asset.id,
      browserScreenshot: true,
      imageInput: "model-dependent",
    };
  }
  screenshotImage(owner: string, screenshotId: string) {
    return this.assets.image(owner, screenshotId);
  }
  async close(owner: string, id: string) {
    return this.serial(id, async () => {
      await this.get(owner, id);
      return this.save(
        owner,
        await (await this.ownedRequest(owner, `/sessions/${id}/close`, {})).json(),
        id,
      );
    });
  }
  async preview(owner: string, id: string) {
    await this.get(owner, id);
    return this.ownedRequest(owner, `/sessions/${id}/screenshot`);
  }
  async input(owner: string, id: string, value: unknown) {
    return this.serial(id, async () => {
      await this.get(owner, id);
      return this.save(
        owner,
        await (await this.ownedRequest(owner, `/sessions/${id}/input`, value)).json(),
        id,
      );
    });
  }
  async imports(owner: string, id: string) {
    await this.get(owner, id);
    const { downloads, failures } = z
      .object({
        downloads: z.array(
          z.object({ id: z.string(), name: z.string(), size: z.number(), mimeType: z.string() }),
        ),
        failures: z.array(failureSchema),
      })
      .parse(await (await this.ownedRequest(owner, `/sessions/${id}/downloads`)).json());
    const saved = [];
    for (const download of downloads) {
      const existing = await this.db.get<{ fileId: string }>(
        owner,
        "browser-downloads",
        download.id,
      );
      if (existing) {
        saved.push(this.files.signed(owner, await this.files.get(owner, existing.fileId)));
        continue;
      }
      const response = await this.ownedRequest(
        owner,
        `/sessions/${id}/downloads/${encodeURIComponent(download.id)}`,
      );
      const file = await this.files.import(
        owner,
        download.name,
        new Uint8Array(await response.arrayBuffer()),
        `Browser · ${id}`,
      );
      await this.db.put(owner, "browser-downloads", { id: download.id, fileId: file.id });
      saved.push(file);
    }
    return { files: saved, failures };
  }
  console(owner: string, id: string) {
    return browserConsole(this.auth.sign(owner, `/api/browsers/${id}/preview`));
  }
}
