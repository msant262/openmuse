import { randomUUID } from "node:crypto";
import { MessageSchema } from "@ag-ui/core";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { z } from "zod";
import { emailDraftSchema, proposalSchema } from "../../../packages/domain/src/index.ts";
import { GoogleApiError } from "../../../packages/integrations/src/google.ts";
import { ActionLog } from "./action-log.ts";
import { approvalPolicy } from "./action-policy.ts";
import { ActionService } from "./actions.ts";
import { agentConfigured, conversationAgentFactory, makeRuntime } from "./agent.ts";
import { auditedComputer, currentComputerResourceScope } from "./audited-computer.ts";
import { createAuth } from "./auth.ts";
import { BrowserService } from "./browser.ts";
import { ComputerService, type DockerRunner } from "./computer.ts";
import { computerRoutes } from "./computer-routes.ts";
import { RpcComputerService } from "./computer-rpc.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { desktopRoutes } from "./desktop-routes.ts";
import { DesktopService, nativeDesktopTransport } from "./desktop-service.ts";
import { currentDesktopViewerScope, DesktopViewers } from "./desktop-viewers.ts";
import { ResourceLeases } from "./engine/resource-leases.ts";
import { agentRoutes } from "./engine/routes.ts";
import { RuntimePause, RuntimePausedError } from "./engine/runtime-pause.ts";
import { AgentService } from "./engine/service.ts";
import { currentExecutorContext, TaskExecutorAuthority } from "./engine/task-executor-authority.ts";
import { LostLeaseError } from "./engine/worker.ts";
import { AppError } from "./errors.ts";
import { nativeGraphicalReset } from "./executors/graphical-policy.ts";
import {
  currentManualNativeScope,
  ManualNativeOperations,
  nativeDeviceRequests,
} from "./executors/manual-operations.ts";
import type {
  ExecutorAuthority,
  ExecutorDispatchContext,
  ExecutorOperation,
  ExecutorRequest,
} from "./executors/protocol.ts";
import { ExecutorRegistry } from "./executors/registry.ts";
import { RemoteComputerBackend } from "./executors/remote-computer.ts";
import { executorRoutes } from "./executors/routes.ts";
import { fileVersionRoutes } from "./file-versions.ts";
import { Files } from "./files.ts";
import { GoogleAuth } from "./google-auth.ts";
import { backgroundFailure } from "./log.ts";
import { LocalThreads } from "./threads.ts";
import { WorkspaceService } from "./workspace.ts";

export async function createApp(
  db: Store,
  config: Config,
  options: {
    docker?: DockerRunner;
    nativeAuthority?: ExecutorAuthority;
    nativeContext?: (
      owner: string,
      requestId: string,
      request?: ExecutorRequest,
    ) => Promise<ExecutorDispatchContext | undefined>;
    nativeManualContext?: (
      owner: string,
      requestId: string,
      request?: ExecutorRequest,
    ) => Promise<ExecutorDispatchContext>;
  } = {},
) {
  const auth = await createAuth(db, config),
    files = new Files(db, config, auth),
    google = new GoogleAuth(db, config),
    workspace = new WorkspaceService(db, config, files, google);
  const runtimePause = new RuntimePause(db);
  const actions = new ActionService(db, {
    policy: approvalPolicy(config),
    execute: (owner, input, connectionId, targetVersion, beforeDispatch) =>
      workspace.execute(owner, input, connectionId, targetVersion, beforeDispatch),
    prepare: (owner, input, connectionId) => workspace.prepare(owner, input, connectionId),
    connected: (owner) => workspace.connected(owner),
    connection: (owner) => workspace.connection(owner),
    guardEffects: async (owner) => {
      const state = await runtimePause.get(owner);
      if (state.paused) throw new RuntimePausedError(state);
    },
  });
  const browser = new BrowserService(db, config, auth, files);
  browser.configureActions(actions);
  const registryOptions = {
    registrations: config.nativeExecutors ?? [],
    authority: options.nativeAuthority,
    beforePublish: async (owner: string, operation: ExecutorOperation) => {
      if (
        operation.inspection ||
        operation.kind === "cancel" ||
        nativeGraphicalReset(operation.kind, operation.args)
      )
        return;
      if (!(await agent.workAdmission.holdForDispatch(operation.taskId)))
        throw new LostLeaseError();
      await db.compareAndSwapTask(
        owner,
        operation.taskId,
        {},
        { state: { nativeAdmissionPending: true } },
      );
    },
  };
  const executors = new ExecutorRegistry(db, registryOptions);
  let taskAuthority: TaskExecutorAuthority;
  const nativeContext: NonNullable<typeof options.nativeContext> =
    options.nativeContext ??
    (async (owner, id, request) => {
      const context = await currentExecutorContext(
        owner,
        id,
        { memoryBytes: (config.nativeCommandMemoryMb ?? 3072) * 1024 ** 2, heavy: true },
        currentComputerResourceScope(owner),
      );
      if (!context && request?.kind === "cancel" && typeof request.args.operationId === "string") {
        const device = nativeDeviceRequests.getStore();
        const target = await db.get<import("./engine/task-journal.ts").JournalOperation>(
          owner,
          "task-operations",
          request.args.operationId,
        );
        if (
          device?.owner === owner &&
          target?.nativeEnvelope &&
          target.executorId === request.executorId
        )
          return taskAuthority.registerManualRequest(owner, id, device.deviceId, request, {
            kind: "task",
            taskId: target.taskId,
            desiredRevision: target.revision,
            runToken: target.runToken,
            resourceLeaseIds: target.resourceLeaseIds,
          });
      }
      const manual = currentManualNativeScope() ?? currentDesktopViewerScope();
      if (context?.kind === "task" && request && manual?.owner === owner)
        return taskAuthority.registerManualRequest(owner, id, manual.deviceId, request, context);
      return context;
    });
  const computer = auditedComputer(
    config.computerBackend === "native" && config.nativeExecutorId
      ? new RemoteComputerBackend(executors, {
          executorId: config.nativeExecutorId,
          enabled: config.computerEnabled,
          timeoutMs: config.computerCommandTimeoutMs,
          context: nativeContext,
          manualContext: options.nativeManualContext,
          retentionDays: config.fileVersionRetentionDays,
          maxVersionBytes: config.fileVersionMaxBytes,
        })
      : config.computerBackend === "rpc"
        ? new RpcComputerService(db, config)
        : new ComputerService(db, config, options.docker),
    new ActionLog(db),
    config.computerBackend ?? "docker",
    new ResourceLeases(db),
    config.computerBackend === "native" && config.nativeExecutorId
      ? executors.registration(config.nativeExecutorId).hostId
      : (config.resourceHostId ?? "openmuse-server"),
    runtimePause,
  );
  const agent = new AgentService(db, config, workspace, files, actions, browser, computer);
  taskAuthority = new TaskExecutorAuthority(agent.journal, {
    executor: (owner, executorId) => {
      const registration = executors.registration(executorId);
      if (registration.owner !== owner)
        throw new AppError("Native executor belongs to another owner", 403);
      return registration;
    },
    wake: (owner, taskId) => agent.actor.wake(owner, taskId, "job"),
  });
  registryOptions.authority ??= taskAuthority;
  const desktop =
    config.computerBackend === "native" && config.nativeExecutorId
      ? new DesktopService(
          db,
          config.dataDir,
          nativeDesktopTransport(executors, {
            executorId: config.nativeExecutorId,
            context: nativeContext,
            manualContext: options.nativeManualContext,
          }),
        )
      : undefined;
  const desktopViewers = desktop ? new DesktopViewers(agent, desktop) : undefined;
  if (desktop) {
    browser.configureNative(desktop);
    agent.configureDesktop(desktop);
    desktop.configureWake(async () => {
      void agent.worker.tick().catch((error) => backgroundFailure("desktop handback", error));
    });
    await desktopViewers!.recover();
  }
  const manualNative =
    config.computerBackend === "native"
      ? new ManualNativeOperations(agent, computer, files)
      : undefined;
  if (manualNative)
    agent.configureNativeExecution((owner, task, context) =>
      manualNative.execute(owner, task, context),
    );
  const inbox = agent.inbox;
  const threads = config.intelligenceApiKey?.trim()
    ? new CopilotKitIntelligence({ apiKey: config.intelligenceApiKey.trim() })
    : new LocalThreads(db);
  if (threads instanceof LocalThreads) {
    agent.configureThreads(threads);
    threads.configureInbox(inbox, conversationAgentFactory(config, agent));
  }
  await agent.initialize();
  if (threads instanceof LocalThreads) await threads.initializeInbox();
  const runtime = makeRuntime(config, agent, auth, threads);
  const app = new Hono<{ Variables: { owner: string } }>();
  const origins = new Set([...config.allowedOrigins, new URL(config.publicUrl).origin]);
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !origins.has(origin)) return c.json({ error: "Origin is not allowed" }, 403);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "*",
    cors({
      origin: (origin) => (origins.has(origin) ? origin : undefined),
      allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-OpenMuse-CSRF"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
    }),
  );
  app.use("*", async (c, next) =>
    bodyLimit({
      maxSize:
        (c.req.path.startsWith("/executor/") ? 36 : c.req.path === "/api/files" ? 26 : 12) *
        1024 *
        1024,
      onError: (c) =>
        c.json({ error: "Request is too large; attachments must be 25 MB or smaller" }, 413),
    })(c, next),
  );
  app.onError((error, c) => {
    if (error instanceof z.ZodError)
      return c.json({ error: error.issues.map((i) => i.message).join("; ") }, 422);
    if (error instanceof AppError)
      return c.json(
        { error: error.message, ...(error.code ? { code: error.code } : {}) },
        error.status,
      );
    if (error instanceof GoogleApiError)
      return c.json(
        { error: error.message, code: error.code },
        error.status === 401 ? 401 : error.status === 403 ? 403 : error.status === 429 ? 429 : 502,
      );
    if (error.name === "PdfError" || error.name === "RecurringEventError")
      return c.json({ error: error.message }, 422);
    if (error instanceof SyntaxError) return c.json({ error: "Invalid request data" }, 400);
    // Provider and document errors are useful, but raw stack traces and token-bearing responses are not.
    console.error(`[OpenMuse] ${error.name}`);
    return c.json(
      {
        error:
          error.name === "PdfError" || error.name === "GoogleApiError"
            ? error.message
            : "Request failed. Check the server setup and try again.",
      },
      502,
    );
  });
  app.route("/executor", executorRoutes(executors));
  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      mode: config.mode,
      agentConfigured: agentConfigured(config),
      browserConfigured: Boolean(config.workerUrl && config.workerToken),
    }),
  );
  let loginWindow = 0,
    loginAttempts = 0;
  const refreshCookie = "__Secure-openmuse-refresh";
  const webOrigin = (origin: string | undefined, csrf: string | undefined) => {
    if (!origin || !origins.has(origin) || csrf !== "1")
      throw new AppError(
        "Web session requests require an allowed origin and CSRF header",
        403,
        "SESSION_ORIGIN_REQUIRED",
      );
  };
  app.post("/api/session", async (c) => {
    if (Date.now() - loginWindow > 60000) {
      loginWindow = Date.now();
      loginAttempts = 0;
    }
    if (++loginAttempts > 30)
      throw new AppError("Too many sign-in attempts. Try again in a minute.", 429);
    const body = z
      .object({
        accessKey: z.string().optional(),
        deviceLabel: z.string().trim().min(1).max(80).optional(),
        transport: z.enum(["native", "web"]).default("native"),
      })
      .parse(await c.req.json());
    if (body.transport === "web")
      webOrigin(c.req.header("origin"), c.req.header("X-OpenMuse-CSRF"));
    const session = await auth.session(body.accessKey, body.deviceLabel, body.transport);
    await workspace.ensureSample("local-user", actions);
    await agent.ensure("local-user");
    if (config.mode === "sample") await agent.refreshIdeas("local-user");
    if (body.transport === "native") return c.json(session);
    setCookie(c, refreshCookie, `${session.deviceId}.${session.refreshToken}`, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/api/session",
      maxAge: 34560000,
    });
    const { refreshToken: _secret, ...publicSession } = session;
    return c.json(publicSession);
  });
  app.post("/api/session/refresh", async (c) => {
    const body = z
      .discriminatedUnion("transport", [
        z.object({
          transport: z.literal("native"),
          deviceId: z.uuid(),
          rotationId: z.string().min(8).max(128),
          currentToken: z.string().min(1).max(256),
          nextTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
        }),
        z.object({ transport: z.literal("web"), rotationId: z.string().min(8).max(128) }).strict(),
      ])
      .parse(await c.req.json());
    if (body.transport === "native")
      return c.json({ ...(await auth.devices.refresh(body)), mode: config.mode });
    webOrigin(c.req.header("origin"), c.req.header("X-OpenMuse-CSRF"));
    const cookie = getCookie(c, refreshCookie);
    if (!cookie)
      throw new AppError("Pair this browser to open your workspace", 401, "SESSION_REQUIRED");
    const [deviceId, currentToken, extra] = cookie.split(".");
    if (!deviceId || !currentToken || extra)
      throw new AppError("Invalid session cookie", 401, "SESSION_REFRESH_INVALID");
    const result = await auth.devices.refreshWeb(deviceId, currentToken, body.rotationId);
    setCookie(c, refreshCookie, `${result.deviceId}.${result.refreshToken}`, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/api/session",
      maxAge: 34560000,
    });
    const { refreshToken: _secret, ...session } = result;
    return c.json({ ...session, mode: config.mode });
  });
  app.get("/api/google/callback", async (c) => {
    if (c.req.query("error"))
      return c.html("<h1>Google connection cancelled</h1><p>You can return to OpenMuse.</p>", 400);
    const state = c.req.query("state"),
      code = c.req.query("code");
    if (!state || !code) throw new AppError("Google callback is incomplete");
    await google.callback(state, code);
    return c.html(
      "<h1>Google is connected</h1><p>Return to OpenMuse and refresh your workspace.</p>",
    );
  });
  app.use("/api/*", async (c, next) => {
    const signedRoute =
      /^\/api\/files\/[^/]+\/content$|^\/api\/browsers\/[^/]+\/(?:preview|console)$/.test(
        c.req.path,
      );
    const owner =
      signedRoute && c.req.query("signature")
        ? auth.verify(new URL(c.req.url))
        : await auth.owner(c.req.header("authorization"));
    c.set("owner", owner);
    const authorization = c.req.header("authorization");
    if (config.computerBackend === "native" && authorization?.startsWith("Bearer om1.")) {
      const identity = await auth.devices.identity(authorization.slice(7));
      return nativeDeviceRequests.run(identity, next);
    }
    await next();
  });
  app.get("/api/devices", async (c) => c.json(await auth.devices.list(c.get("owner"))));
  app.post("/api/devices/:id/revoke", async (c) => {
    await auth.devices.revoke(c.get("owner"), z.uuid().parse(c.req.param("id")));
    return c.json({ revoked: true });
  });
  app.get("/api/workspace", async (c) => {
    const section = z
      .enum(["essential", "mail", "calendar", "files", "browser", "all"])
      .optional()
      .parse(c.req.query("section"));
    const [snapshot, reachable] = await Promise.all([
      workspace.snapshot(c.get("owner"), c.req.query("q"), section, c.req.raw.signal),
      browser.reachable(),
    ]);
    snapshot.browsers = snapshot.browsers.map((s) => browser.decorate(c.get("owner"), s));
    // A configured worker that does not answer is offline, not ready.
    snapshot.connections = snapshot.connections.map((connection) =>
      connection.id === "browser" && connection.status === "connected" && !reachable
        ? { ...connection, status: "unavailable" }
        : connection,
    );
    return c.json(snapshot);
  });
  app.route("/api/agent", agentRoutes(agent));
  app.route("/api/desktop", desktopRoutes(desktop, desktopViewers, auth, browser));
  app.post("/api/conversations/:threadId/messages", async (c) => {
    if (!(threads instanceof LocalThreads))
      throw new AppError("Durable admission requires local thread storage", 409);
    const body = z
      .object({ threadId: z.string().optional() })
      .passthrough()
      .parse(await c.req.json());
    if (body.threadId && body.threadId !== c.req.param("threadId"))
      throw new AppError("Conversation ID does not match", 422);
    await threads.ensure(c.get("owner"), c.req.param("threadId"));
    return c.json(
      await inbox.acceptMessage(c.get("owner"), { ...body, threadId: c.req.param("threadId") }),
      202,
    );
  });
  app.get("/api/conversations/:threadId/events", async (c) =>
    c.json(
      await inbox.eventsAfter(
        c.get("owner"),
        c.req.param("threadId"),
        z.coerce
          .number()
          .int()
          .min(0)
          .parse(c.req.query("cursor") ?? 0),
      ),
    ),
  );
  app.get("/api/conversations/:threadId/interactions", async (c) =>
    c.json({ requests: await agent.interactions.list(c.get("owner"), c.req.param("threadId")) }),
  );
  if (manualNative) app.route("/api/computer", manualNative.routes(auth));
  app.route("/api/computer", computerRoutes(computer, files));
  app.route("/api/computer/file-versions", fileVersionRoutes(computer.recovery));
  app.get("/api/calendars", async (c) => c.json(await workspace.calendars(c.get("owner"))));
  app.get("/api/calendar/events", async (c) => {
    const query = z
      .object({
        calendarId: z.string().min(1).max(1024).optional(),
        timeMin: z.iso.datetime({ offset: true }).optional(),
        timeMax: z.iso.datetime({ offset: true }).optional(),
      })
      .parse(c.req.query());
    if (
      query.timeMin &&
      query.timeMax &&
      (Date.parse(query.timeMax) <= Date.parse(query.timeMin) ||
        Date.parse(query.timeMax) - Date.parse(query.timeMin) > 366 * 86400000)
    )
      throw new AppError("Choose a calendar range between one moment and 366 days", 422);
    return c.json(await workspace.events(c.get("owner"), query));
  });
  app.get("/api/mail/threads/:id", async (c) =>
    c.json(await workspace.thread(c.get("owner"), c.req.param("id"))),
  );
  app.get("/api/action-log", async (c) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .parse(c.req.query());
    return c.json(await db.actionLog(c.get("owner"), query.limit, query.cursor));
  });
  app.post("/api/actions", async (c) => {
    const raw = z
      .object({ idempotencyKey: z.unknown().optional() })
      .passthrough()
      .parse(await c.req.json());
    const requestKey = z
      .string()
      .min(16)
      .max(160)
      .regex(/^[a-zA-Z0-9:_-]+$/)
      .optional()
      .parse(raw.idempotencyKey ?? c.req.header("Idempotency-Key"));
    if (approvalPolicy(config) === "money" && !requestKey)
      throw new AppError("An idempotency key is required for automatic actions", 422);
    const input = proposalSchema.parse(raw);
    if (input.kind === "email.send")
      for (const id of input.data.attachmentIds) await files.get(c.get("owner"), id);
    return c.json(
      await actions.propose(c.get("owner"), input, requestKey ? `native:${requestKey}` : undefined),
      201,
    );
  });
  app.get("/api/actions/:id", async (c) => {
    const action = await db.get(c.get("owner"), "actions", c.req.param("id"));
    if (!action) throw new AppError("Action not found", 404);
    return c.json(action);
  });
  app.post("/api/actions/:id/decide", async (c) => {
    const body = z
      .object({ hash: z.string(), decision: z.enum(["approve", "deny"]) })
      .parse(await c.req.json());
    return c.json(
      await actions.decide(c.get("owner"), c.req.param("id"), body.hash, body.decision),
    );
  });
  app.get("/api/drafts", async (c) => c.json(await db.list(c.get("owner"), "drafts")));
  app.post("/api/drafts", async (c) => {
    const body = emailDraftSchema.extend({ id: z.string().optional() }).parse(await c.req.json());
    const existing = body.id
      ? await db.get<{ createdAt: string }>(c.get("owner"), "drafts", body.id)
      : null;
    if (body.id && !existing) throw new AppError("Draft not found", 404);
    return c.json(
      await db.put(c.get("owner"), "drafts", {
        ...body,
        id: body.id ?? randomUUID(),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      }),
      201,
    );
  });
  app.get("/api/main-thread", async (c) => {
    const owner = c.get("owner");
    await db.insertIfAbsent(owner, "conversation-settings", {
      id: "main",
      threadId: randomUUID(),
      existing: false,
    });
    const main = await db.get<{ threadId: string }>(owner, "conversation-settings", "main");
    if (!main) throw new AppError("Main conversation could not be loaded", 503);
    try {
      if (threads instanceof LocalThreads) await threads.ensure(owner, main.threadId);
      else
        await threads.getOrCreateThread({
          threadId: main.threadId,
          userId: owner,
          agentId: "default",
        });
    } catch {
      throw new AppError(
        "Main conversation could not be loaded. Check the server storage and try again.",
        502,
      );
    }
    return c.json({ threadId: main.threadId, existing: true });
  });
  app.get("/api/conversation", async (c) =>
    c.json((await db.get(c.get("owner"), "conversations", "default")) ?? { messages: [] }),
  );
  app.put("/api/conversation", async (c) => {
    const body = await c.req.json();
    const messages = z.array(z.unknown()).max(1000).parse(body.messages);
    for (const message of messages) MessageSchema.parse(message);
    await db.put(c.get("owner"), "conversations", { id: "default", messages });
    return c.json({ ok: true });
  });
  app.post("/api/files", async (c) => {
    const data = await c.req.parseBody();
    const file = data.file;
    if (!(file instanceof File)) throw new AppError("Choose a file");
    return c.json(
      await files.importAttachment(
        c.get("owner"),
        file.name,
        new Uint8Array(await file.arrayBuffer()),
        "Uploaded by you",
        file.type,
      ),
      201,
    );
  });
  app.get("/api/files/:id/content", async (c) => {
    const file = await files.get(c.get("owner"), c.req.param("id"));
    c.header("Content-Type", file.mimeType);
    c.header(
      "Content-Disposition",
      `${file.mimeType === "application/pdf" || file.mimeType.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    return c.body(await files.bytes(c.get("owner"), file.id));
  });
  app.get("/api/files/:id", async (c) =>
    c.json(files.signed(c.get("owner"), await files.get(c.get("owner"), c.req.param("id")))),
  );
  app.post("/api/files/:id/fill", async (c) => {
    const body = z
      .object({ fields: z.record(z.string(), z.union([z.string(), z.boolean()])) })
      .parse(await c.req.json());
    return c.json(await files.fill(c.get("owner"), c.req.param("id"), body.fields), 201);
  });
  app.post("/api/mail/import-attachment", async (c) => {
    const body = z.object({ reference: z.string() }).parse(await c.req.json());
    return c.json(await workspace.importAttachment(c.get("owner"), body.reference), 201);
  });
  app.post("/api/google/connect", async (c) => {
    const body = z.object({ capability: z.enum(["read", "write"]) }).parse(await c.req.json());
    if (config.mode === "sample") {
      await db.put(c.get("owner"), "settings", {
        id: "google",
        enabled: true,
        connectionId: randomUUID(),
      });
      return c.json({ url: null, connected: true });
    }
    return c.json(await google.connect(c.get("owner"), body.capability === "write"));
  });
  app.post("/api/google/disconnect", async (c) => {
    if (config.mode === "sample")
      await db.put(c.get("owner"), "settings", { id: "google", enabled: false });
    else await google.disconnect(c.get("owner"));
    return c.json({ ok: true });
  });
  app.post("/api/browsers", async (c) => {
    const body = z.object({ url: z.url().max(4096) }).parse(await c.req.json());
    return c.json(await browser.create(c.get("owner"), body.url), 201);
  });
  app.get("/api/browsers/:id", async (c) => {
    const owner = c.get("owner");
    return c.json(browser.decorate(owner, await browser.get(owner, c.req.param("id"))));
  });
  app.post("/api/browsers/:id/navigate", async (c) => {
    const body = z.object({ url: z.url().max(4096) }).parse(await c.req.json());
    return c.json(await browser.navigate(c.get("owner"), c.req.param("id"), body.url));
  });
  app.post("/api/browsers/:id/control", async (c) => {
    const body = z
      .object({ control: z.enum(["agent", "human"]) })
      .strict()
      .parse(await c.req.json());
    return c.json(await browser.control(c.get("owner"), c.req.param("id"), body.control));
  });
  app.post("/api/browsers/:id/close", async (c) =>
    c.json(await browser.close(c.get("owner"), c.req.param("id"))),
  );
  app.get("/api/browsers/:id/read", async (c) =>
    c.json(await browser.read(c.get("owner"), c.req.param("id"))),
  );
  app.post("/api/browsers/:id/reopen", async (c) => {
    const raw = await c.req.text();
    const body = z.object({ url: z.url().max(4096).optional() }).parse(raw ? JSON.parse(raw) : {});
    return c.json(await browser.reopen(c.get("owner"), c.req.param("id"), body.url));
  });
  app.post("/api/browsers/:id/import-downloads", async (c) =>
    c.json(await browser.imports(c.get("owner"), c.req.param("id"))),
  );
  app.get("/api/browsers/:id/preview", async (c) => {
    const response = await browser.preview(c.get("owner"), c.req.param("id"));
    c.header("Content-Type", "image/png");
    return c.body(await response.arrayBuffer());
  });
  app.get("/api/browsers/:id/console", async (c) => {
    await browser.get(c.get("owner"), c.req.param("id"));
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' blob:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
    );
    return c.html(browser.console(c.get("owner"), c.req.param("id")));
  });
  app.post("/api/browsers/:id/console", async (c) => {
    const body = await c.req.json();
    if (body.operation === "status")
      return c.json(await browser.control(c.get("owner"), c.req.param("id")));
    if (body.control === "agent" || body.control === "human")
      return c.json(await browser.control(c.get("owner"), c.req.param("id"), body.control));
    await browser.input(c.get("owner"), c.req.param("id"), body);
    return c.json({ ok: true });
  });
  app.all("/api/copilotkit/*", async (c) => {
    if (threads instanceof LocalThreads) {
      const response = await threads.handle(c.req.raw, c.get("owner"));
      if (response) return response;
    }
    if (!agentConfigured(config))
      throw new AppError(
        "Configure a model and provider API key, or a valid AG-UI endpoint, to start chat",
        503,
      );
    const response = await (threads instanceof LocalThreads
      ? threads.withOwner(c.get("owner"), () => runtime.fetch(c.req.raw))
      : runtime.fetch(c.req.raw));
    if (threads instanceof LocalThreads && c.req.path === "/api/copilotkit/info" && response.ok) {
      return c.json({
        ...(await response.json()),
        telemetryDisabled: true,
        threadEndpoints: { list: true, inspect: true, mutations: true, realtimeMetadata: false },
      });
    }
    // Runtime 1.70 emits SSE strings; a WHATWG Response body requires byte chunks.
    const encoder = new TextEncoder();
    const body = response.body?.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        },
      }),
    );
    return new Response(body, { status: response.status, headers: response.headers });
  });
  app.get("/", (c) =>
    c.json({ name: "OpenMuse", app: "http://localhost:8081", health: "/api/health" }),
  );
  return {
    app,
    auth,
    files,
    actions,
    workspace,
    agent,
    computer,
    executors,
    manualNative,
    desktop,
    desktopViewers,
    threads,
    inbox,
  };
}
