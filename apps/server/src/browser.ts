import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { attachmentMime } from "../../../packages/domain/src/attachments.ts";
import {
  browserBodyHash,
  signBrowserExecutor,
} from "../../../packages/domain/src/browser-executor.ts";
import { browserUploadLimit } from "../../../packages/domain/src/browser-file.ts";
import {
  browserImagesInputSchema,
  browserImagesSchema,
} from "../../../packages/domain/src/browser-images.ts";
import {
  type BrowserPaymentBinding,
  signBrowserAuthorization,
} from "../../../packages/domain/src/browser-payment.ts";
import { captchaResultSchema } from "../../../packages/domain/src/credential-challenge.ts";
import type { BrowserSession } from "../../../packages/domain/src/index.ts";
import type { ResourceLease } from "../../../packages/domain/src/runtime.ts";
import { type SearchInput, searchResultSchema } from "../../../packages/domain/src/search.ts";
import { ActionLog, auditTarget } from "./action-log.ts";
import { approvalPolicy } from "./action-policy.ts";
import type { ActionService } from "./actions.ts";
import type { Auth } from "./auth.ts";
import { BrowserAssets } from "./browser-assets.ts";
import { browserConsole } from "./browser-console.ts";
import { BrowserError, browserActionSchema, snapshotSchema } from "./browser-contract.ts";
import type { ComputerBackend } from "./computer-contract.ts";
import type { Config } from "./config.ts";
import {
  type NativeCredentialPlan,
  type TrustedCredentialInput,
  trustedCredentialResultSchema,
} from "./credential-browser-contract.ts";
import type { Store } from "./db.ts";
import type { DesktopService } from "./desktop-service.ts";
import { ResourceBusyError, ResourceLeases } from "./engine/resource-leases.ts";
import { RuntimePause, RuntimePausedError } from "./engine/runtime-pause.ts";
import {
  authorizeTaskEffect,
  currentTaskScope,
  TaskSupersededError,
  taskOperationId,
} from "./engine/task-journal.ts";
import { TaskValidityExpiredError } from "./engine/task-timing.ts";
import { AppError } from "./errors.ts";
import {
  type ArtifactRequirement,
  type BrowserExecutor,
  type BrowserOperationClass,
  type CapabilityRouter,
  classifyBrowserOperation,
  type ExecutorBinding,
} from "./executors/capability-router.ts";
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
  dataSources: z
    .array(z.object({ url: z.string().max(4096), kind: z.string().max(100) }))
    .max(30)
    .optional(),
  url: z.string(),
  title: z.string().max(300),
  text: z.string().max(100_000),
  truncated: z.boolean(),
  links: z
    .array(z.object({ title: z.string().max(200), url: z.string().max(4096) }))
    .max(80)
    .optional(),
  extraction: z
    .object({ status: z.enum(["readable", "partial"]), reason: z.string().optional() })
    .optional(),
  contentHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  sourceLength: z.number().int().nonnegative().optional(),
  products: z
    .array(
      z.object({
        name: z.string().max(300),
        price: z.number().positive(),
        currency: z.string().regex(/^[A-Z]{3}$/),
      }),
    )
    .max(400)
    .optional(),
});
const downloadMetadataSchema = z.object({
  id: z.uuid(),
  name: z.string().max(180),
  size: z
    .number()
    .int()
    .min(1)
    .max(10 * 1024 * 1024),
  mimeType: z.string().max(128),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
const failureSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  message: z.string(),
  createdAt: z.string(),
});
type ChatBrowser = { id: string; sessionId: string };
type BrowserRouting = {
  requiredTransport?: "native" | "vps";
  taskId?: string;
  capability?: "browser.dom" | "browser.screenshot";
  operationClass?: BrowserOperationClass;
  accountId?: string;
  artifactVersions?: ArtifactRequirement[];
};
const routedBrowser = new AsyncLocalStorage<{
  owner: string;
  binding: ExecutorBinding;
  lease?: ResourceLease;
  revision?: number;
  operationId?: string;
  beforeDispatch?: () => Promise<void>;
}>();

export class BrowserService {
  private router?: CapabilityRouter;
  private native?: DesktopService;
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
  configureFallback(router: CapabilityRouter) {
    this.router = router;
  }
  async credentialTarget(owner: string, taskId: string, accountId: string) {
    if (!this.router) return undefined;
    const binding = await this.router.binding(owner, taskId);
    const fallback = await this.fallbackExecutors(owner, accountId);
    if (binding?.transport === "vps") {
      const target = fallback.find(
        (executor) =>
          executor.executorId === binding.executorId &&
          executor.profileId === binding.profileId &&
          executor.sessionGeneration === binding.sessionGeneration,
      );
      if (!target)
        throw new BrowserError(
          "STALE_BROWSER_BINDING",
          "The login browser lifecycle changed.",
          409,
          binding.sessionId,
        );
      return target;
    }
    try {
      const native = await this.native?.session(owner);
      if (
        native &&
        (!binding ||
          (native.executorEpoch === binding.epoch &&
            native.sessionGeneration === binding.sessionGeneration &&
            native.profileId === binding.profileId))
      )
        return {
          executorId: native.executorId,
          profileId: native.profileId,
          sessionId: native.browserSessionId,
          sessionGeneration: native.sessionGeneration,
        };
    } catch {
      /* The bound native session must wait; a first login may select VPS. */
    }
    if (binding)
      throw new BrowserError(
        "BROWSER_EXECUTOR_UNAVAILABLE",
        "The bound login browser is offline.",
        503,
        binding.sessionId,
      );
    return fallback[0];
  }
  async hasUncertainDispatch(owner: string, taskId: string) {
    if (!this.router) return false;
    const operations = await this.db.taskOperations<{
      taskId: string;
      toolName: string;
      status: string;
      effect: boolean;
    }>(owner, taskId);
    if (
      !operations.some(
        (operation) =>
          operation.taskId === taskId &&
          operation.effect &&
          /browser|credential/.test(operation.toolName) &&
          ["dispatching", "running", "outcome_unknown"].includes(operation.status),
      )
    )
      return false;
    const handles = await Promise.all(
      (await this.resourceLeases.listForTask(taskId)).map((lease) =>
        this.db.get<{ hold?: boolean; request: { key: string } }>(
          "__runtime__",
          "resource-leases",
          lease.id,
        ),
      ),
    );
    return handles.some(
      (handle) =>
        handle?.hold &&
        handle.request.key.startsWith(
          `browser-profile:${this.config.resourceHostId ?? "openmuse-server"}:`,
        ),
    );
  }
  /** Server-only credential path. The destination is independently validated;
   * login uses this task's existing admission and a separate durable binding. */
  async runOnExecutor<T>(
    owner: string,
    taskId: string,
    accountId: string,
    target: Pick<BrowserExecutor, "executorId" | "profileId" | "sessionId" | "sessionGeneration">,
    url: string | undefined,
    signal: AbortSignal | undefined,
    operation: (id: string) => Promise<T>,
  ) {
    const native =
      target.executorId === this.config.nativeExecutorId
        ? await this.native?.session(owner)
        : undefined;
    const destination: Omit<BrowserExecutor, "capabilities" | "ready"> | undefined = native
      ? {
          executorId: native.executorId,
          hostId: native.hostId,
          profileId: native.profileId,
          sessionId: native.browserSessionId,
          sessionGeneration: native.sessionGeneration,
          epoch: native.executorEpoch,
          transport: "native",
        }
      : (await this.fallbackExecutors(owner, accountId)).find(
          (item) => item.executorId === target.executorId,
        );
    if (
      !destination ||
      destination.profileId !== target.profileId ||
      destination.sessionId !== target.sessionId ||
      destination.sessionGeneration !== target.sessionGeneration
    )
      throw new BrowserError(
        "STALE_BROWSER_BINDING",
        "The selected login browser lifecycle changed.",
        409,
        target.sessionId,
      );
    const id = `login:${taskId}:${accountId}:${target.executorId}`;
    let binding: ExecutorBinding | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      const previous = await this.db.get<ExecutorBinding>(owner, "browser-bindings", id);
      if (
        previous &&
        previous.epoch === destination.epoch &&
        previous.sessionGeneration === destination.sessionGeneration &&
        previous.sessionId === destination.sessionId &&
        previous.profileId === destination.profileId
      ) {
        binding = previous;
        break;
      }
      const value: ExecutorBinding = {
        ...destination,
        id,
        taskId: id,
        accountId,
        fence: (previous?.fence ?? 0) + 1,
        operationClass: "mutable",
        authentication: { status: "public" },
      };
      binding =
        (previous
          ? await this.db.compareAndSwap<ExecutorBinding>(
              owner,
              "browser-bindings",
              id,
              { fence: previous.fence },
              value,
            )
          : await this.db.insertIfAbsent(owner, "browser-bindings", value)) ?? undefined;
      if (binding) break;
    }
    if (!binding)
      throw new BrowserError(
        "STALE_BROWSER_BINDING",
        "The login binding raced with a newer session.",
        409,
        target.sessionId,
      );
    await this.db.insertIfAbsent(owner, "browsers", {
      id: binding.sessionId,
      url: url ?? "https://example.com/",
      title: "Account login",
      status: "idle",
      control: "agent",
      updatedAt: new Date().toISOString(),
    });
    await this.db.put(owner, "browser-session-bindings", { ...binding, id: binding.sessionId });
    return routedBrowser.run({ owner, binding }, () =>
      this.runAutomated(owner, taskId, binding.sessionId, url, signal, true, operation),
    );
  }
  /** Authenticated worker handshake gives a fresh lifecycle. Profiles are owned
   * by host/account; no source profile/cookies are copied during migration. */
  async fallbackExecutors(owner: string, accountId?: string): Promise<BrowserExecutor[]> {
    if (!this.config.workerUrl || !this.config.workerToken) return [];
    let handshake: {
      executorId: string;
      instanceId: string;
      minProtocolVersion: number;
      maxProtocolVersion: number;
      capabilities: BrowserExecutor["capabilities"];
    };
    try {
      const response = await fetch(`${this.config.workerUrl}/executor`, {
        headers: { Authorization: `Bearer ${this.config.workerToken}` },
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return [];
      handshake = z
        .object({
          executorId: z.string(),
          instanceId: z.string().min(1).max(128),
          minProtocolVersion: z.number().int(),
          maxProtocolVersion: z.number().int(),
          capabilities: z.array(
            z.object({
              name: z.enum([
                "browser.dom",
                "browser.screenshot",
                "browser.pointer",
                "browser.drag",
                "desktop",
                "command",
                "files",
                "transcribe",
              ]),
              version: z.number().int().positive(),
            }),
          ),
        })
        .parse(await response.json());
    } catch {
      return [];
    }
    const executorId = this.config.browserFallbackExecutorId ?? "openmuse-server";
    if (
      handshake.executorId !== executorId ||
      handshake.minProtocolVersion > 1 ||
      handshake.maxProtocolVersion < 1
    )
      return [];
    let epoch = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      const previous = await this.db.get<{ id: string; instanceId: string; epoch: number }>(
        "__executors__",
        "browser-workers",
        executorId,
      );
      if (previous?.instanceId === handshake.instanceId) {
        epoch = previous.epoch;
        break;
      }
      const value = {
        id: executorId,
        instanceId: handshake.instanceId,
        epoch: (previous?.epoch ?? 0) + 1,
      };
      const saved = previous
        ? await this.db.compareAndSwap<{ epoch: number }>(
            "__executors__",
            "browser-workers",
            executorId,
            previous,
            value,
          )
        : await this.db.insertIfAbsent("__executors__", "browser-workers", value);
      if (saved) {
        epoch = saved.epoch;
        break;
      }
    }
    if (!epoch)
      throw new BrowserError("STALE_BROWSER_BINDING", "Browser worker registration raced.", 409);
    const key = `${executorId}:${accountId ?? "public"}`;
    const profile =
      (await this.db.get<ChatBrowser>(owner, "browser-executor-profiles", key)) ??
      (await this.db.insertIfAbsent(owner, "browser-executor-profiles", {
        id: key,
        sessionId: randomUUID(),
      })) ??
      (await this.db.get<ChatBrowser>(owner, "browser-executor-profiles", key));
    if (!profile) throw new AppError("Could not reserve destination browser profile", 500);
    return [
      {
        executorId,
        hostId: this.config.resourceHostId ?? "openmuse-server",
        transport: "vps",
        epoch,
        profileId: profile.sessionId,
        sessionId: profile.sessionId,
        sessionGeneration: `${handshake.instanceId}:${profile.sessionId}`,
        ready: true,
        capabilities: handshake.capabilities,
      },
    ];
  }
  private async routedAutomated<T>(
    owner: string,
    taskId: string | undefined,
    sessionId: string | undefined,
    url: string | undefined,
    signal: AbortSignal | undefined,
    effect: boolean,
    operation: (id: string) => Promise<T>,
    guard: (() => Promise<void>) | undefined,
    trackResources: ((leases: ResourceLease[]) => void) | undefined,
    routing?: BrowserRouting,
  ): Promise<T> {
    const router = this.router;
    if (!router) throw new AppError("Browser routing is not configured", 503);
    const routeId = routing?.taskId ?? taskId ?? "chat:personal";
    const previous = await router.binding(owner, routeId);
    const source = previous
      ? await this.db.get<BrowserSession>(owner, "browsers", previous.sessionId)
      : undefined;
    if (sessionId && previous && sessionId !== previous.sessionId)
      throw new BrowserError(
        "STALE_BROWSER_BINDING",
        "This task moved to another session. Obtain a fresh snapshot.",
        409,
        sessionId,
      );
    if (sessionId && !previous) await this.get(owner, sessionId);
    const operationClass =
      routing?.operationClass ??
      (effect || url
        ? "mutable"
        : previous?.operationClass === "public_read"
          ? "public_read"
          : "authenticated_read");
    if (previous?.operationClass === "public_read" && operationClass === "mutable")
      throw new BrowserError(
        "PUBLIC_RESEARCH_ONLY",
        "Public research sessions accept reading only. Use the personal browser for site actions.",
        409,
        previous.sessionId,
      );
    const task = taskId
      ? await this.db.get<{ artifactIds: string[]; state: { credentialRef?: { id?: string } } }>(
          owner,
          "tasks",
          taskId,
        )
      : undefined;
    const localArtifacts = await Promise.all(
      (task?.artifactIds ?? []).map((id) =>
        this.db.get<{ id: string; version: string }>(owner, "native-artifacts", id),
      ),
    );
    const requiredArtifacts = localArtifacts.flatMap((artifact) =>
      artifact ? [{ artifactId: artifact.id, version: artifact.version }] : [],
    );
    const request = {
      owner,
      taskId: routeId,
      capability: routing?.capability ?? ("browser.dom" as const),
      accountId:
        operationClass === "public_read"
          ? undefined
          : (routing?.accountId ?? previous?.accountId ?? task?.state.credentialRef?.id),
      artifactVersions: routing?.artifactVersions ?? requiredArtifacts,
      operationClass,
      requiredTransport: routing?.requiredTransport,
    };
    const execute = async (binding: ExecutorBinding) => {
      signal?.throwIfAborted();
      await guard?.();
      const saved = await this.db.get<BrowserSession>(owner, "browsers", binding.sessionId);
      await this.db.insertIfAbsent(owner, "browsers", {
        id: binding.sessionId,
        title: "Personal browser",
        url: url ?? source?.url ?? saved?.url ?? "https://example.com/",
        status: "idle",
        control: "agent",
        updatedAt: new Date().toISOString(),
      });
      await this.db.put(owner, "browser-session-bindings", { ...binding, id: binding.sessionId });
      return routedBrowser.run({ owner, binding }, () =>
        this.runAutomated(
          owner,
          taskId,
          binding.sessionId,
          url ?? (binding.fence !== previous?.fence ? (source?.url ?? saved?.url) : undefined),
          signal,
          effect,
          operation,
          guard,
          trackResources,
        ),
      );
    };
    const binding = await router.choose(request);
    try {
      return await execute(binding);
    } catch (error) {
      signal?.throwIfAborted();
      const unavailable =
        (error instanceof AppError && error.status === 503) ||
        (error instanceof BrowserError &&
          ["OUTCOME_UNKNOWN", "DESKTOP_FAILED", "WORKER_STOPPING"].includes(error.code));
      if (operationClass === "mutable" || binding.transport !== "native" || !unavailable)
        throw error;
      const destination = await router.choose({
        ...request,
        excludeExecutorId: binding.executorId,
      });
      return execute(destination);
    }
  }
  configureActions(actions: ActionService) {
    this.actions = actions;
    actions.registerExternal("browser.act", async (owner, raw, proposal, beforeDispatch) => {
      const { sessionId, binding } = raw as { sessionId: string; binding: BrowserPaymentBinding };
      if (this.native && (await this.usesNative(owner, sessionId)))
        throw new BrowserError(
          "APPROVAL_FAILED",
          "Native browser reviewed money adapter is unavailable",
          409,
          sessionId,
        );
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
        const destination = await this.db.get<ExecutorBinding>(
          owner,
          "browser-session-bindings",
          sessionId,
        );
        if (destination) await this.router?.assertCurrent(owner, destination);
        const reviewedTask = proposal.taskId
          ? await this.db.get<{ state: { appliedRevision?: number } }>(
              owner,
              "tasks",
              proposal.taskId,
            )
          : undefined;
        const dispatch = () =>
          this.serial(sessionId, async () => {
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
              const receipt = z.object({ id: z.string(), status: z.literal("succeeded") }).parse(
                await (
                  await this.ownedRequest(owner, `/sessions/${sessionId}/reviewed-act`, {
                    authorization,
                  })
                ).json(),
              );
              if (receipt.id !== proposal.id) throw new Error("Mismatched browser receipt");
              return `Browser action completed · ${receipt.id}`;
            } catch (error) {
              if (
                error instanceof RuntimePausedError ||
                error instanceof ResourceBusyError ||
                error instanceof TaskSupersededError ||
                error instanceof TaskValidityExpiredError
              )
                throw error;
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
        return await (destination?.transport === "vps"
          ? routedBrowser.run(
              {
                owner,
                binding: destination,
                lease: leases[0],
                revision: reviewedTask?.state.appliedRevision ?? 0,
                operationId: proposal.id,
                beforeDispatch,
              },
              dispatch,
            )
          : dispatch());
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
  configureNative(desktop: DesktopService) {
    this.native = desktop;
  }
  nativeSession(owner: string) {
    return this.native?.session(owner);
  }
  isNativeSession(owner: string, id: string) {
    return this.usesNative(owner, id);
  }
  private async usesNative(owner: string, id?: string) {
    if (!this.native) return false;
    const routed = routedBrowser.getStore();
    if (routed?.owner === owner)
      return routed.binding.transport === "native" && (!id || id === routed.binding.sessionId);
    if (!id) return true;
    const session = await this.db.get<BrowserSession>(owner, "browsers", id);
    return !session || Boolean(session.desktopSessionId);
  }
  /** Internal credential orchestrator only; call while runAutomated holds its
   * exact profile/desktop lease. No typed values enter action logs or journal. */
  async credentials(
    owner: string,
    id: string,
    input: TrustedCredentialInput | NativeCredentialPlan,
    signal?: AbortSignal,
  ) {
    await this.get(owner, id);
    if (this.native && (await this.usesNative(owner, id))) {
      if ("fields" in input)
        throw new AppError("Native credentials require a secret-free vault reference", 403);
      return this.native.credentials(owner, id, input, signal);
    }
    if (!("fields" in input))
      throw new AppError("VPS credential fields must be resolved by the trusted broker", 503);
    const result = trustedCredentialResultSchema.parse(
      await (await this.ownedRequest(owner, `/sessions/${id}/credentials`, input, signal)).json(),
    );
    return this.credentialResult(owner, id, result);
  }
  async submitCredentialChallenge(
    owner: string,
    id: string,
    input: TrustedCredentialInput | NativeCredentialPlan,
    signal?: AbortSignal,
  ) {
    if (!input.challenge)
      throw new AppError("Trusted credential challenge binding is required", 403);
    if (await this.usesNative(owner, id)) return this.credentials(owner, id, input, signal);
    await this.get(owner, id);
    if (!("fields" in input))
      throw new AppError("VPS challenge code requires trusted ephemeral input", 503);
    const result = trustedCredentialResultSchema.parse(
      await (
        await this.ownedRequest(owner, `/sessions/${id}/credential-challenge`, input, signal)
      ).json(),
    );
    return this.credentialResult(owner, id, result);
  }
  private async credentialResult(
    owner: string,
    id: string,
    result: z.infer<typeof trustedCredentialResultSchema>,
  ) {
    if (result.sessionId !== id)
      throw new AppError("Credential result belongs to another browser", 409);
    const binding =
      routedBrowser.getStore()?.binding ??
      (await this.db.get<ExecutorBinding>(owner, "browser-session-bindings", id));
    if (binding?.transport !== "vps") return result;
    await this.router?.assertCurrent(owner, binding);
    if (result.sessionGeneration && result.sessionGeneration !== binding.sessionGeneration)
      throw new AppError("Credential result lifecycle changed", 409);
    return {
      ...result,
      executorId: binding.executorId,
      profileId: binding.profileId,
      sessionGeneration: binding.sessionGeneration,
    };
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
      () => this.boundWorkerRequest(owner, path, body, signal),
    );
  }
  private async boundWorkerRequest(
    owner: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const current = routedBrowser.getStore();
    const id = ["/sessions", "/sessions/human"].includes(path)
      ? (body as { id?: string } | undefined)?.id
      : /^\/sessions\/([^/]+)/.exec(path)?.[1];
    if (current) await this.router?.assertCurrent(owner, current.binding);
    if (current || !this.router || !id) {
      if (
        current?.binding.operationClass === "public_read" &&
        classifyBrowserOperation(
          path === "/sessions"
            ? "open"
            : path.endsWith("/control") && body === undefined
              ? "control-read"
              : (path.split("/")[3] ?? "unknown"),
          true,
        ) === "mutable"
      )
        throw new BrowserError(
          "PUBLIC_RESEARCH_ONLY",
          "Public research profiles accept reading only.",
          409,
          id,
        );
      return this.native && (await this.usesNative(owner, id))
        ? this.native.browserRequest(owner, path, body, signal)
        : this.request(path, body, signal);
    }
    const binding = await this.db.get<ExecutorBinding>(owner, "browser-session-bindings", id);
    if (binding) await this.router.assertCurrent(owner, binding);
    const mutable =
      classifyBrowserOperation(
        path === "/sessions"
          ? "open"
          : path.endsWith("/control") && body === undefined
            ? "control-read"
            : (path.split("/")[3] ?? "unknown"),
        binding?.operationClass === "public_read",
      ) === "mutable";
    if (mutable) {
      if (binding?.operationClass === "public_read")
        throw new BrowserError(
          "PUBLIC_RESEARCH_ONLY",
          "Public research profiles accept reading only.",
          409,
          id,
        );
      await this.runtimePause.assertResumed(owner);
    }
    if (binding?.transport !== "vps") {
      if (this.native && (await this.usesNative(owner, id))) {
        const session = await this.native.session(owner);
        if (
          binding &&
          (binding.epoch !== session.executorEpoch ||
            binding.sessionGeneration !== session.sessionGeneration ||
            binding.profileId !== session.profileId ||
            binding.sessionId !== session.browserSessionId)
        )
          throw new BrowserError(
            "STALE_BROWSER_BINDING",
            "The native browser lifecycle changed. Obtain a fresh observation.",
            409,
            id,
          );
        return this.native.browserRequest(owner, path, body, signal);
      }
      return this.request(path, body, signal);
    }
    if (!mutable) {
      const held = (
        await this.db.list<
          ResourceLease & { owner: string; hold: boolean; request: { key: string } }
        >("__runtime__", "resource-leases")
      ).find(
        (lease) =>
          lease.owner === owner &&
          lease.hold &&
          lease.request.key === `browser-profile:${binding.hostId}:${binding.profileId}` &&
          Date.parse(lease.expiresAt) > this.now(),
      );
      if (held)
        return routedBrowser.run(
          { owner, binding, lease: { id: held.id, fence: held.fence, expiresAt: held.expiresAt } },
          () => this.request(path, body, signal),
        );
    }
    const holdId = `browser-ui:${randomUUID()}`,
      requests = [
        {
          key: `browser-profile:${binding.hostId}:${binding.profileId}`,
          units: 1,
          mode: "exclusive" as const,
        },
      ];
    const leases = await this.resourceLeases.acquire(owner, holdId, requests);
    if (!leases) throw new ResourceBusyError(requests);
    let retain = false;
    try {
      return await routedBrowser.run({ owner, binding, lease: leases[0] }, () =>
        this.request(path, body, signal),
      );
    } catch (error) {
      if (
        mutable &&
        ((error instanceof BrowserError && error.code === "OUTCOME_UNKNOWN") ||
          (error instanceof AppError && error.status === 503))
      ) {
        retain = true;
        await this.resourceLeases.holdTask(holdId);
      }
      throw error;
    } finally {
      if (!retain) await Promise.all(leases.map((lease) => this.resourceLeases.release(lease)));
    }
  }
  /** Whether the configured worker answers its health check, cached briefly for snapshots. */
  async reachable(): Promise<boolean> {
    if (this.native) {
      try {
        await this.native.session(
          this.config.nativeExecutors?.find(
            (item) => item.executorId === this.config.nativeExecutorId,
          )?.owner ?? "local-user",
        );
        return true;
      } catch {
        if (!this.router) return false;
      }
    }
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
    const routing = routedBrowser.getStore();
    if (routing?.binding.transport === "vps") {
      await this.router?.assertCurrent(routing.owner, routing.binding);
      if (!routing.lease)
        throw new BrowserError(
          "STALE_BROWSER_BINDING",
          "Browser profile lease is absent.",
          409,
          routing.binding.sessionId,
        );
    }
    const serialized = body === undefined ? "" : JSON.stringify(body);
    const operationClass = classifyBrowserOperation(
      path === "/sessions"
        ? "open"
        : path.endsWith("/control") && body === undefined
          ? "control-read"
          : (path.split("/")[3] ?? "unknown"),
      routing?.binding.operationClass === "public_read" ||
        currentTaskScope()?.operation.toolName === "browser_research",
    );
    // Everything that can await (vault access, queueing, inspection) finishes
    // before this final dispatch barrier. The task check atomically revalidates
    // revision, pause, run authority and the actual physical lease.
    if (routing?.binding.transport === "vps" && routing.lease) {
      if (operationClass === "mutable") await this.runtimePause.assertResumed(routing.owner);
      const live = await this.db.get<
        ResourceLease & { owner: string; request: { key: string; mode: string } }
      >("__runtime__", "resource-leases", routing.lease.id);
      if (
        !live ||
        live.owner !== routing.owner ||
        live.fence !== routing.lease.fence ||
        live.request.key !==
          `browser-profile:${routing.binding.hostId}:${routing.binding.profileId}` ||
        live.request.mode !== "exclusive" ||
        Date.parse(live.expiresAt) <= this.now()
      )
        throw new ResourceBusyError([]);
      routing.lease = { id: live.id, fence: live.fence, expiresAt: live.expiresAt };
      const scope = currentTaskScope();
      if (routing.beforeDispatch && operationClass === "mutable") await routing.beforeDispatch();
      else if (scope) {
        if (scope.owner !== routing.owner) throw new AppError("Browser task owner changed", 403);
        const operation = scope.primitive ?? scope.operation;
        await scope.journal.authorizeDispatch(
          scope.owner,
          operation.id,
          operation.revision,
          operation.runToken,
          [routing.lease],
          true,
        );
      }
      signal?.throwIfAborted();
    } else {
      // The legacy VPS adapter uses the same durable task barrier, while
      // trusted manual calls remain independent of background task authority.
      const scope = currentTaskScope();
      if (scope) {
        const operation = scope.primitive ?? scope.operation;
        await scope.journal.authorizeDispatch(
          scope.owner,
          operation.id,
          operation.revision,
          operation.runToken,
          undefined,
          true,
        );
      }
      signal?.throwIfAborted();
    }
    const authority =
      routing?.binding.transport === "vps" && routing.lease
        ? signBrowserExecutor(this.config.workerToken, {
            executorId: routing.binding.executorId,
            epoch: routing.binding.epoch,
            instanceId: routing.binding.sessionGeneration.slice(
              0,
              -(routing.binding.sessionId.length + 1),
            ),
            profileId: routing.binding.profileId,
            sessionId: routing.binding.sessionId,
            sessionGeneration: routing.binding.sessionGeneration,
            fence: routing.lease.fence,
            bindingFence: routing.binding.fence,
            taskId: routing.binding.taskId,
            revision: currentTaskScope()?.operation.revision ?? routing.revision ?? 0,
            operationId: createHash("sha256")
              .update(
                `${taskOperationId() ?? routing.operationId ?? randomUUID()}:${path}:${browserBodyHash(serialized)}`,
              )
              .digest("hex"),
            expiresAt: Math.min(Date.parse(routing.lease.expiresAt), this.now() + 45_000),
            operationClass: operationClass ?? "mutable",
            method: body === undefined ? "GET" : "POST",
            path,
            bodyHash: browserBodyHash(serialized),
          })
        : undefined;
    // Navigation may take 60s (plus Chromium startup); public reads may wait
    // another 60s for application data. Each request needs transport headroom.
    const timeoutMs =
      path.endsWith("/read") ||
      path.endsWith("/back") ||
      path === "/sessions" ||
      path === "/sessions/human"
        ? 90_000
        : 45_000;
    let response: Response;
    try {
      response = await fetch(`${this.config.workerUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${this.config.workerToken}`,
          "Content-Type": "application/json",
          ...(authority ? { "X-OpenMuse-Browser-Authority": authority } : {}),
        },
        body: body === undefined ? undefined : serialized,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      });
    } catch {
      if (
        path.endsWith("/back") ||
        path.endsWith("/upload") ||
        path.endsWith("/reviewed-act") ||
        path.endsWith("/credentials") ||
        path.endsWith("/credential-challenge") ||
        path.endsWith("/challenge") ||
        (authority && operationClass === "mutable")
      )
        throw new BrowserError(
          "OUTCOME_UNKNOWN",
          "The browser response was lost after mutable dispatch. Check the site before preparing another action.",
          409,
        );
      signal?.throwIfAborted();
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
    if (body !== undefined && operationClass === "mutable") {
      try {
        const payload: unknown = await response.clone().json();
        const endpoint = path.split("/")[3] ?? "open";
        const sessionId =
          path === "/sessions" || path === "/sessions/human"
            ? (body as { id?: string }).id
            : /^\/sessions\/([^/]+)/.exec(path)?.[1];
        if (["credentials", "credential-challenge"].includes(endpoint)) {
          const receipt = trustedCredentialResultSchema.parse(payload);
          if (
            receipt.sessionId !== sessionId ||
            receipt.origin !== (body as { origin?: string }).origin ||
            (receipt.sessionGeneration &&
              receipt.sessionGeneration !== routing?.binding.sessionGeneration) ||
            receipt.status === "outcome_unknown"
          )
            throw new Error("Credential receipt binding changed");
        } else if (endpoint === "challenge") {
          const receipt = captchaResultSchema.parse(payload);
          if (receipt.sessionId !== sessionId)
            throw new Error("Challenge receipt belongs to another session");
        } else if (["act", "upload", "back"].includes(endpoint)) {
          const receipt = (
            endpoint === "back"
              ? snapshotSchema.extend({ historyMoved: z.boolean() })
              : snapshotSchema
          ).parse(payload);
          if (receipt.sessionId !== sessionId)
            throw new Error("Browser action receipt belongs to another session");
        } else if (endpoint === "reviewed-act")
          z.object({ id: z.string(), status: z.literal("succeeded") }).parse(payload);
        else if (
          ["open", "navigate", "agent-navigate", "close", "control", "input"].includes(endpoint)
        ) {
          if (sessionSchema.parse(payload).id !== sessionId)
            throw new Error("Browser receipt belongs to another session");
        } else throw new Error("Unsupported mutable browser receipt");
      } catch {
        throw new BrowserError(
          "OUTCOME_UNKNOWN",
          "The browser returned an invalid receipt after mutable dispatch. Inspect the site before retrying.",
          409,
          routing?.binding.sessionId,
        );
      }
    }
    return response;
  }
  async get(owner: string, id: string) {
    const value = await this.db.get<BrowserSession>(owner, "browsers", id);
    if (!value) throw new AppError("Browser session not found", 404);
    return value;
  }
  decorate(owner: string, session: BrowserSession) {
    if (this.native && session.desktopSessionId)
      return { ...session, consoleUrl: undefined, previewUrl: undefined };
    return {
      ...session,
      consoleUrl: this.auth.sign(owner, `/api/browsers/${session.id}/console`),
      previewUrl: this.auth.sign(owner, `/api/browsers/${session.id}/preview`),
    };
  }
  private async save(owner: string, payload: unknown, expectedId: string) {
    const parsed = sessionSchema.parse(payload);
    const native =
      this.native && (await this.usesNative(owner, expectedId))
        ? await this.native.session(owner)
        : undefined;
    const session = native
      ? { ...parsed, executorId: native.executorId, desktopSessionId: native.id }
      : parsed;
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
    routing?: BrowserRouting,
  ): Promise<T> {
    if (this.router && !routedBrowser.getStore())
      return this.routedAutomated(
        owner,
        taskId,
        sessionId,
        url,
        signal,
        effect,
        operation,
        guard,
        trackResources,
        routing,
      );
    if (this.native && (await this.usesNative(owner, sessionId))) {
      const desktop = await this.native.session(owner);
      if (sessionId && sessionId !== desktop.browserSessionId)
        throw new BrowserError(
          "INVALID_SESSION",
          "Use this account's registered persistent native browser",
          409,
        );
      const id = desktop.browserSessionId;
      const saved = await this.db.get<BrowserSession>(owner, "browsers", id);
      await this.db.insertIfAbsent(owner, "browsers", {
        id,
        title: "Native personal browser",
        url: url ?? "https://example.com/",
        status: "idle",
        control: "agent",
        executorId: desktop.executorId,
        desktopSessionId: desktop.id,
        updatedAt: new Date().toISOString(),
      });
      return this.native.run(
        owner,
        desktop,
        effect || Boolean(url) || saved?.status !== "active",
        async () => {
          await guard?.();
          const active = await this.agentSession(owner, id, url, signal);
          await guard?.();
          return operation(active);
        },
        signal,
      );
    }
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
    const currentRouting = routedBrowser.getStore();
    if (currentRouting?.owner === owner) currentRouting.lease = leases[0];
    trackResources?.(leases);
    const renewals = new Set<Promise<unknown>>();
    let leaseLost = false;
    let retainForUncertainOutcome = false;
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
      await authorizeTaskEffect(leases, leaseTaskId);
      const activeId = await this.agentSession(owner, id, url, signal);
      await guard?.();
      if (effect) await this.runtimePause.assertResumed(owner);
      if (leaseLost) throw new ResourceBusyError(requests);
      if (effect) await authorizeTaskEffect(leases, leaseTaskId);
      return await operation(activeId);
    } catch (error) {
      if (error instanceof BrowserError && error.code === "OUTCOME_UNKNOWN") {
        retainForUncertainOutcome = true;
        await this.resourceLeases.holdTask(leaseTaskId);
      }
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      await Promise.allSettled([...renewals]);
      if (!taskId && !retainForUncertainOutcome)
        await Promise.all(leases.map((lease) => this.resourceLeases.release(lease)));
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
    signal?: AbortSignal,
    routingTaskId?: string,
  ) {
    if (this.native && !this.router)
      throw new BrowserError(
        "BROWSER_EXECUTOR_UNAVAILABLE",
        "Headless public reading is unavailable; the personal browser will not be opened automatically.",
        503,
      );
    return this.runAutomated(
      owner,
      taskId,
      existingId,
      url,
      signal,
      true,
      async (id) => {
        return this.serial(id, async () => ({
          sessionId: id,
          ...(await this.readOwned(owner, id, signal)),
        }));
      },
      undefined,
      trackResources,
      {
        requiredTransport: "vps",
        taskId: routingTaskId ?? (taskId ? `public:${taskId}` : undefined),
        operationClass: "public_read",
        artifactVersions: [],
      },
    );
  }
  async observeForThread(owner: string, threadId: string, url: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.router || this.native)
      return this.observe(
        owner,
        url,
        undefined,
        undefined,
        undefined,
        signal,
        `public:chat:${threadId}`,
      );
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
    if (this.native)
      return { id: "personal", sessionId: (await this.native.session(owner)).browserSessionId };
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
  async images(
    owner: string,
    id: string,
    input: z.input<typeof browserImagesInputSchema> = {},
    signal?: AbortSignal,
  ) {
    return this.serial(id, async () => {
      await this.get(owner, id);
      const value = browserImagesSchema.parse(
        await (
          await this.ownedRequest(
            owner,
            `/sessions/${id}/images`,
            browserImagesInputSchema.parse(input),
            signal,
          )
        ).json(),
      );
      if (value.sessionId !== id)
        throw new BrowserError("INVALID_SESSION", "The browser returned a different session.");
      return value;
    });
  }
  async back(owner: string, id: string, signal?: AbortSignal) {
    return this.serial(id, async () => {
      await this.get(owner, id);
      const value = snapshotSchema
        .extend({ historyMoved: z.boolean() })
        .parse(await (await this.ownedRequest(owner, `/sessions/${id}/back`, {}, signal)).json());
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
      if (
        (
          await this.db.list<{ sessionId: string; status: string; kind: string }>(
            owner,
            "credential-challenges",
          )
        ).some(
          (item) =>
            item.sessionId === id &&
            item.kind === "captcha" &&
            ["waiting", "outcome_unknown"].includes(item.status),
        )
      )
        throw new BrowserError(
          "CHALLENGE_TOOL_REQUIRED",
          "Use the bounded connection_challenge tool or Take control.",
          409,
          id,
        );
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
  async challenge(
    owner: string,
    id: string,
    plan: import("../../../packages/domain/src/credential-challenge.ts").CaptchaPlan,
    signal?: AbortSignal,
  ) {
    await this.get(owner, id);
    const result = captchaResultSchema.parse(
      await (await this.ownedRequest(owner, `/sessions/${id}/challenge`, plan, signal)).json(),
    );
    if (result.sessionId !== id)
      throw new BrowserError(
        "CHALLENGE_SESSION_CHANGED",
        "The challenge returned another session",
        409,
      );
    const { image, ...safe } = result;
    if (!image) return safe;
    const asset = await this.assets.save(owner, Buffer.from(image, "base64"), "image/png");
    return {
      ...safe,
      screenshotId: asset.id,
      browserScreenshot: true,
      challengeScreenshot: true,
      imageInput: "model-dependent",
    };
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
        width: z.number().int().min(1).max(3840),
        height: z.number().int().min(1).max(2160),
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
  async uploadFromWorkspace(
    owner: string,
    id: string,
    input: { snapshotId: string; element: number; path: string; expectedSha256: string },
    computer: ComputerBackend,
    signal?: AbortSignal,
  ) {
    await this.get(owner, id);
    signal?.throwIfAborted();
    const file = await computer.fileBytes(owner, input.path);
    if (!file.bytes.length || file.bytes.length > browserUploadLimit)
      throw new BrowserError(
        "UPLOAD_TOO_LARGE",
        "Browser uploads must be between 1 byte and 5 MiB.",
        413,
        id,
      );
    const sha256 = createHash("sha256").update(file.bytes).digest("hex");
    if (sha256 !== input.expectedSha256)
      throw new BrowserError(
        "STALE_FILE",
        "Workspace file changed; inspect its current hash before uploading.",
        409,
        id,
      );
    signal?.throwIfAborted();
    const source = await this.files.importAttachment(
      owner,
      file.name,
      file.bytes,
      `Workspace upload: ${input.path}`,
    );
    const attachment = await this.files.reference(owner, source.id);
    signal?.throwIfAborted();
    return this.serial(id, async () => {
      const raw = await (
        await this.ownedRequest(
          owner,
          `/sessions/${id}/upload`,
          {
            artifactId: source.id,
            snapshotId: input.snapshotId,
            element: input.element,
            name: file.name,
            mimeType: attachmentMime(file.name),
            size: file.bytes.length,
            sha256,
            base64: Buffer.from(file.bytes).toString("base64"),
          },
          signal,
        )
      ).json();
      const snapshot = snapshotSchema.parse(raw);
      if (snapshot.sessionId !== id)
        throw new BrowserError("INVALID_SESSION", "Upload returned another browser.", 409, id);
      await this.save(
        owner,
        {
          id,
          title: snapshot.title,
          url: snapshot.url,
          status: "active",
          control: snapshot.control,
          updatedAt: new Date().toISOString(),
        },
        id,
      );
      return {
        ...snapshot,
        uploaded: { name: file.name, size: file.bytes.length, sha256 },
        attachment,
        completionVerified: false,
      };
    });
  }
  async publishDownloads(owner: string, id: string, signal?: AbortSignal) {
    const result = await this.imports(owner, id, signal);
    return {
      attachments: await Promise.all(
        result.files.map((file) => this.files.reference(owner, file.id)),
      ),
      failures: result.failures,
      pending: result.pending,
    };
  }
  async downloadToWorkspace(
    owner: string,
    id: string,
    downloadId: string,
    path: string,
    computer: ComputerBackend,
    signal?: AbortSignal,
  ) {
    const file = await this.downloadBytes(owner, id, downloadId, signal);
    signal?.throwIfAborted();
    const written = await computer.writeBytes(owner, path, file.bytes);
    signal?.throwIfAborted();
    const published = await this.files.importAttachment(
      owner,
      file.metadata.name,
      file.bytes,
      `Browser: ${id}`,
      file.metadata.mimeType,
    );
    return {
      ...written,
      downloadId,
      sha256: file.sha256,
      attachment: await this.files.reference(owner, published.id),
    };
  }
  private async downloadBytes(
    owner: string,
    id: string,
    downloadId: string,
    signal?: AbortSignal,
    known?: z.infer<typeof downloadMetadataSchema>,
  ) {
    await this.get(owner, id);
    z.uuid().parse(downloadId);
    let metadata = known;
    if (!metadata) {
      const listing = await (
        await this.ownedRequest(owner, `/sessions/${id}/downloads`, undefined, signal)
      ).json();
      metadata = z
        .object({ downloads: z.array(downloadMetadataSchema) })
        .parse(listing)
        .downloads.find((item) => item.id === downloadId);
    }
    if (!metadata) throw new AppError("Download not found in this owned browser", 404);
    const response = await this.ownedRequest(
      owner,
      `/sessions/${id}/downloads/${downloadId}`,
      undefined,
      signal,
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (
      bytes.length !== metadata.size ||
      bytes.length > 10 * 1024 * 1024 ||
      (metadata.sha256 && metadata.sha256 !== sha256)
    )
      throw new AppError("Download size or digest changed before publication", 409);
    return { metadata, bytes, sha256 };
  }
  async search(owner: string, id: string, input: SearchInput, signal?: AbortSignal) {
    return this.serial(id, async () => {
      const response = await this.ownedRequest(owner, `/sessions/${id}/search`, input, signal);
      const { cleanupConfirmed: _cleanup, ...body } = (await response.json()) as Record<
        string,
        unknown
      >;
      const result = searchResultSchema.parse(body);
      if (result.provenance.sessionId !== id)
        throw new AppError("Search result belongs to another session", 502);
      return result;
    });
  }
  async imports(owner: string, id: string, signal?: AbortSignal) {
    await this.get(owner, id);
    const { downloads, failures, pending } = z
      .object({
        downloads: z.array(downloadMetadataSchema),
        failures: z.array(failureSchema),
        pending: z.number().int().min(0).max(20).default(0),
      })
      .parse(
        await (
          await this.ownedRequest(owner, `/sessions/${id}/downloads`, undefined, signal)
        ).json(),
      );
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
      const transfer = await this.downloadBytes(owner, id, download.id, signal, download);
      const file = await this.files.importAttachment(
        owner,
        download.name,
        transfer.bytes,
        `Browser · ${id}`,
        download.mimeType,
      );
      await this.db.put(owner, "browser-downloads", { id: download.id, fileId: file.id });
      saved.push(file);
    }
    return { files: saved, failures, pending };
  }
  console(owner: string, id: string) {
    return browserConsole(this.auth.sign(owner, `/api/browsers/${id}/preview`));
  }
}
