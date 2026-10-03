import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type AgentArtifact,
  type AgentIdentity,
  type AgentNotification,
  type AgentTask,
  type AgentWorkspace,
  createTaskSchema,
  type Evidence,
  type Goal,
  goalInputSchema,
  type Idea,
  type Monitor,
  monitorInputSchema,
  type RunEvent,
} from "../../../../packages/domain/src/agent.ts";
import { PRODUCT_NAME } from "../../../../packages/domain/src/brand.ts";
import type { ComputerCommand } from "../../../../packages/domain/src/computer.ts";
import type {
  ActionProposal,
  Artifact,
  BrowserSession,
  Mail,
  ProposalInput,
} from "../../../../packages/domain/src/index.ts";
import type { TaskBudget, TaskTiming } from "../../../../packages/domain/src/runtime.ts";
import { ActionLog } from "../action-log.ts";
import type { ActionService } from "../actions.ts";
import { AgentProfile } from "../agent-profile.ts";
import { reconcileComputerAudit } from "../audited-computer.ts";
import type { BrowserService } from "../browser.ts";
import { ComputerService } from "../computer.ts";
import type { ComputerBackend } from "../computer-contract.ts";
import { computerCommandCleanupConfirmed } from "../computer-contract.ts";
import type { Config } from "../config.ts";
import { ConversationInbox } from "../conversation-inbox.ts";
import type { CredentialBroker } from "../credentials/broker.ts";
import type { CredentialLoginService } from "../credentials/login.ts";
import type { Store } from "../db.ts";
import type { DesktopService } from "../desktop-service.ts";
import { AppError } from "../errors.ts";
import type { Files } from "../files.ts";
import { InteractionRequests } from "../interaction-requests.ts";
import { backgroundFailure } from "../log.ts";
import { McpService } from "../mcp.ts";
import { MediaService } from "../media-tools.ts";
import { MemoryService } from "../memory.ts";
import { modelProviderConfig } from "../providers/config.ts";
import { sharedModelRouter } from "../providers/model-router.ts";
import { nativePushAdapters, PushService } from "../push.ts";
import { RoutinesService } from "../routines.ts";
import { BrowserSearchBackend } from "../search.ts";
import { OperationDrain } from "../shutdown.ts";
import type { LocalThreads } from "../threads.ts";
import type { WorkspaceService } from "../workspace.ts";
import { readComputerCommand, reconcileWaitingComputerTasks } from "./computer-jobs.ts";
import { ContextBudget, type ContextModelResolver } from "./context-budget.ts";
import { analyzeSpending } from "./finance.ts";
import { executeModelTask } from "./model.ts";
import { ResourceLeases } from "./resource-leases.ts";
import { RuntimePause } from "./runtime-pause.ts";
import { TaskActor } from "./task-actor.ts";
import { TaskJournal, validateTaskEffect } from "./task-journal.ts";
import { TaskMailbox } from "./task-mailbox.ts";
import { TaskTiming as TaskTimingService } from "./task-timing.ts";
import { mandatoryTaskCriteria, TaskVerification } from "./task-verification.ts";
import { WorkAdmission } from "./work-admission.ts";
import { LostLeaseError, type TaskContext, TaskWorker } from "./worker.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const date = () => new Date().toISOString();
const terminal = new Set(["succeeded", "failed", "cancelled"]);
export class AgentService {
  desktop?: DesktopService;
  readonly search: BrowserSearchBackend;
  configureDesktop(desktop: DesktopService) {
    this.desktop = desktop;
  }
  readonly profiles: AgentProfile;
  readonly interactions: InteractionRequests;
  readonly worker: TaskWorker;
  readonly runtimePause: RuntimePause;
  readonly resourceLeases: ResourceLeases;
  readonly workAdmission: WorkAdmission;
  readonly routines: RoutinesService;
  readonly memory: MemoryService;
  readonly contextBudget: ContextBudget;
  contextModel?: ContextModelResolver;
  readonly mcp: McpService;
  readonly push: PushService;
  readonly journal: TaskJournal;
  readonly inbox: ConversationInbox;
  readonly mailbox: TaskMailbox;
  readonly actor: TaskActor;
  readonly timing: TaskTimingService;
  readonly verification: TaskVerification;
  readonly credentials?: CredentialBroker;
  readonly credentialLogin?: CredentialLoginService;
  readonly toolOperations = new OperationDrain(() => this.db.persistenceFailed);
  private nativeExecution?: (
    owner: string,
    task: AgentTask,
    context: TaskContext,
  ) => Promise<Partial<AgentTask> | undefined>;
  configureNativeExecution(execute: NonNullable<AgentService["nativeExecution"]>) {
    this.nativeExecution = execute;
  }
  private localThreads?: LocalThreads;
  private routineTimer?: ReturnType<typeof setInterval>;
  private routineRefreshing = false;
  configureThreads(threads: LocalThreads) {
    this.localThreads = threads;
  }
  async initialize() {
    await this.push.recover();
  }
  async routineTick() {
    if (this.routineRefreshing) return;
    this.routineRefreshing = true;
    try {
      if (!(await this.runtimePause.get("__runtime__")).paused) await this.routines.tick();
      await this.push.recover();
      await this.flushPublications();
    } finally {
      this.routineRefreshing = false;
    }
  }
  private async flushPublications() {
    for (const { owner, value } of await this.db.scan<{
      id: string;
      threadId: string;
      text: string;
      taskId: string;
      title: string;
      status: string;
      notificationSent?: boolean;
    }>("thread-publications")) {
      if (
        !this.localThreads ||
        value.notificationSent ||
        !["pending", "posted"].includes(value.status)
      )
        continue;
      if (
        value.status === "posted" ||
        (await this.localThreads.appendBackground(owner, value.threadId, value.id, value.text))
      ) {
        await this.db.compareAndSwap(
          owner,
          "thread-publications",
          value.id,
          { status: "pending" },
          { status: "posted" },
        );
        // A restart between the post and notification resumes here. Both IDs and
        // native delivery claims are deterministic, so recovery never redoes work.
        await this.notify(
          owner,
          value.title,
          value.text,
          value.taskId,
          `task-done:${value.taskId}`,
        );
        await this.db.compareAndSwap(
          owner,
          "thread-publications",
          value.id,
          { status: "posted" },
          { notificationSent: true },
        );
      }
    }
  }
  private maintenance?: ReturnType<typeof setInterval>;
  private refreshing = false;
  constructor(
    readonly db: Store,
    readonly config: Config,
    readonly workspace: WorkspaceService,
    readonly files: Files,
    readonly actions: ActionService,
    readonly browser: BrowserService,
    readonly computer: ComputerBackend = new ComputerService(db, config),
    readonly media: MediaService = new MediaService(db, files, config),
    credentials?: CredentialBroker,
    credentialLogin?: CredentialLoginService,
  ) {
    this.credentials = credentials;
    this.credentialLogin = credentialLogin;
    this.search = new BrowserSearchBackend(browser);
    this.journal = new TaskJournal(db);
    this.inbox = new ConversationInbox(db, (owner, id) => files.get(owner, id));
    this.mailbox = new TaskMailbox(db, this.inbox);
    this.actor = new TaskActor(db, this.mailbox, this.journal);
    this.inbox.subscribeAccepted((owner, message) => {
      if (message.targetTaskId)
        void this.actor
          .wake(owner, message.targetTaskId, "directive")
          .catch((error) => backgroundFailure("wake task direction", error));
    });
    this.timing = new TaskTimingService(db, config.routineTimezone ?? "Europe/Berlin");
    this.verification = new TaskVerification(db, files, this.journal);
    this.profiles = new AgentProfile(db);
    this.interactions = new InteractionRequests(db);
    this.runtimePause = new RuntimePause(db);
    this.resourceLeases = new ResourceLeases(db);
    this.workAdmission = new WorkAdmission(db);
    this.routines = new RoutinesService(
      db,
      (owner, input, key) => this.createTask(owner, input, key),
      config.routineTimezone ?? "Europe/Berlin",
      Date.now,
      (owner, routine, taskId) =>
        this.notify(
          owner,
          `${routine.title}: previous run is waiting`,
          "An occurrence was skipped while the previous run is unfinished. Future occurrences resume after it settles.",
          taskId,
          `routine-blocked:${routine.id}:${taskId}`,
        ).then(() => {}),
    );
    this.memory = new MemoryService(db);
    this.contextBudget = new ContextBudget(db);
    if (config.model) {
      const providers = config.modelProviders ?? modelProviderConfig(config.dataDir);
      const models = [config.model, ...(config.modelFallbacks ?? [])];
      const router = sharedModelRouter(providers);
      this.contextModel = (requirements) => ({
        id: "compatible-context-capacity",
        contextTokens: router.contextCapacity(
          { ...requirements, contextTokens: requirements.contextTokens ?? 0 },
          models,
        ),
        outputReserveTokens: 4096,
        imageContextTokens: providers.routing?.imageContextTokens ?? 8192,
      });
    }
    this.mcp = new McpService(db, actions, config.mcpServers ?? []);
    this.push = new PushService(
      db,
      nativePushAdapters(config.push ?? {}),
      async (owner) => !(await this.runtimePause.get(owner)).paused,
    );
    this.worker = new TaskWorker(db, (owner, task, context) => this.execute(owner, task, context), {
      settled: (owner, task) => this.publishOutcome(owner, task),
      browserReleased: async (owner, id) =>
        (await this.browser.control(owner, id)).control === "agent",
      workAdmission: this.workAdmission,
      retainAdmission: async (owner, taskId) => {
        const pending = (await this.journal.operations(owner, taskId)).some(
          (op) =>
            op.nativeEnvelope &&
            op.effect &&
            !["succeeded", "failed", "rejected_not_dispatched", "superseded"].includes(op.status) &&
            (op.receipt as { data?: { cleanupConfirmed?: boolean } })?.data?.cleanupConfirmed !==
              true,
        );
        if (pending)
          await this.db.compareAndSwapTask(
            owner,
            taskId,
            {},
            { state: { nativeAdmissionPending: true } },
          );
        return pending || (await this.browser.hasUncertainDispatch(owner, taskId));
      },
      resourceLeases: this.resourceLeases,
      runtimePause: this.runtimePause,
    });
  }
  start() {
    this.worker.start();
    void this.routineTick().catch((error) => backgroundFailure("routine scheduler", error));
    this.routineTimer = setInterval(() => {
      void this.routineTick().catch((error) => backgroundFailure("routine scheduler", error));
    }, 1000);
    // Maintenance is independent of the HTTP response and reconciles durable records.
    void this.maintain().catch((error) => backgroundFailure("initial maintenance", error));
    this.maintenance = setInterval(() => {
      void this.maintain().catch((error) => backgroundFailure("maintenance", error));
    }, 60000);
  }
  async stop() {
    if (this.maintenance) clearInterval(this.maintenance);
    if (this.routineTimer) clearInterval(this.routineTimer);
    this.routineTimer = undefined;
    this.maintenance = undefined;
    // Abort connector discovery/auth and native sends before waiting on tasks:
    // startup requests must not hold shutdown open behind the task worker.
    const adaptersClosed = Promise.all([
      this.push.close(),
      this.mcp.close(),
      this.toolOperations.close(),
    ]);
    // Observe both failure paths immediately; either may already carry a failed write.
    await Promise.all([this.worker.stop(), adaptersClosed]);
    while (this.refreshing || this.routineRefreshing)
      await new Promise((resolve) => setTimeout(resolve, 10));
  }
  private async maintain() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const globallyPaused = (await this.runtimePause.get("__runtime__")).paused;
      if (this.config.computerEnabled) {
        await reconcileComputerAudit(this.computer, new ActionLog(this.db));
        await reconcileWaitingComputerTasks(
          this.db,
          this.computer,
          this.workAdmission,
          this.resourceLeases,
        );
      }
      await new ActionLog(this.db).reconcile();
      // Recover publications if the process exited after committing an outcome.
      for (const { owner, value } of await this.db.scan<AgentTask>("tasks")) {
        if (
          (value.state.nativeCleanupPending === true ||
            value.state.nativeAdmissionPending === true) &&
          value.status !== "running"
        ) {
          const physical = (await this.journal.operations(owner, value.id)).filter(
            (op) => op.nativeEnvelope && op.effect,
          );
          const confirmed =
            physical.length > 0 &&
            physical.every(
              (op) =>
                ["succeeded", "failed", "rejected_not_dispatched", "superseded"].includes(
                  op.status,
                ) ||
                (op.receipt as { data?: { cleanupConfirmed?: boolean } })?.data
                  ?.cleanupConfirmed === true,
            );
          if (confirmed) {
            await this.workAdmission.releaseHeld(value.id);
            await this.db.compareAndSwapTask(
              owner,
              value.id,
              { status: value.status },
              { state: { nativeCleanupPending: false, nativeAdmissionPending: false } },
            );
          }
        }
        await this.publishOutcome(owner, value);
      }
      if (!globallyPaused)
        for (const { owner, value } of await this.db.scan<Monitor>("monitors"))
          await this.activateMonitor(owner, value);
      if (!globallyPaused)
        for (const { owner, value } of await this.db.scan<Idea>("ideas"))
          if (
            value.status === "accepted" &&
            value.taskId &&
            !(await this.db.get(owner, "tasks", value.taskId))
          )
            await this.decideIdea(owner, value.id, "accept").catch(async (error) => {
              backgroundFailure("recover accepted idea", error);
              await this.notify(
                owner,
                "Accepted idea needs attention",
                "Open the idea again after making room for another task.",
                undefined,
                `idea-recovery:${value.id}`,
              );
            });
      if (!globallyPaused)
        for (const { owner, value } of await this.db.scan<{ id: string; lastIdeasAt?: string }>(
          "agent-settings",
        )) {
          if (value.id !== "identity") continue;
          if (!value.lastIdeasAt || Date.now() - Date.parse(value.lastIdeasAt) > 15 * 60000)
            await this.refreshIdeas(owner).catch(async () => {
              await this.notify(
                owner,
                "Source refresh needs attention",
                "Reconnect the source or refresh Ideas to see the error.",
                undefined,
                `source-error:${Math.floor(Date.now() / 3600000)}`,
              );
            });
        }
    } finally {
      this.refreshing = false;
    }
  }
  async ensure(owner: string) {
    await this.db.insertIfAbsent(owner, "agent-settings", {
      id: "identity",
      name: PRODUCT_NAME,
      tone: "warm",
    });
  }
  async snapshot(owner: string): Promise<AgentWorkspace> {
    await this.ensure(owner);
    const [
      tasks,
      goals,
      monitors,
      ideas,
      memories,
      artifacts,
      notifications,
      identity,
      runtimePause,
      actions,
      computerCommands,
      imageGenerations,
      mcpReceipts,
      pushDeliveries,
      admissions,
    ] = await Promise.all([
      this.db.list<AgentTask>(owner, "tasks"),
      this.db.list<Goal>(owner, "goals"),
      this.db.list<Monitor>(owner, "monitors"),
      this.db.list<Idea>(owner, "ideas"),
      this.memory.recall(owner),
      this.db.list<AgentArtifact>(owner, "agent-artifacts"),
      this.db
        .recordPage<AgentNotification>(owner, "notifications", { limit: 100, order: "createdAt" })
        .then((page) => page.entries),
      this.db.get<AgentIdentity>(owner, "agent-settings", "identity"),
      this.runtimePause.get(owner),
      this.db.list<ActionProposal>(owner, "actions"),
      this.db.list<{ status: string }>(owner, "computer-commands"),
      this.db.list<{ status: string }>(owner, "image-generations"),
      this.db.list<{ status: string }>(owner, "mcp-receipts"),
      this.db.list<{ status: string }>(owner, "push-deliveries"),
      this.db.scan<{ id: string; hold?: boolean }>("work-admissions"),
    ]);
    const heartbeat = await this.db.get<{ lastTickAt: string }>("system", "worker-status", "tasks");
    const profile = await this.profiles.get(owner);
    return {
      tasks,
      goals,
      monitors,
      ideas,
      memories,
      artifacts,
      notifications,
      identity: {
        ...(identity ?? { name: PRODUCT_NAME, tone: "warm" }),
        name: profile.fields.assistantName,
        tone: profile.fields.tone,
        profile,
      },
      runtimePause,
      runtimeStatus: {
        activeTasks: new Set([
          ...tasks
            .filter((task) => ["running", "waiting_job"].includes(task.status))
            .map((task) => task.id),
          ...admissions.filter(({ value }) => value.hold).map(({ value }) => value.id),
        ]).size,
        activeOperations:
          computerCommands.filter((command) => command.status === "running").length +
          imageGenerations.filter((generation) => generation.status === "pending").length +
          mcpReceipts.filter((receipt) => receipt.status === "sending").length +
          pushDeliveries.filter((delivery) => delivery.status === "sending").length,
        uncertainOperations:
          actions.filter((action) => ["executing", "outcome_unknown"].includes(action.status))
            .length +
          computerCommands.filter((command) =>
            ["interrupted", "timed_out"].includes(command.status),
          ).length +
          imageGenerations.filter((generation) => generation.status === "uncertain").length +
          mcpReceipts.filter((receipt) => receipt.status === "outcome_unknown").length +
          pushDeliveries.filter((delivery) => delivery.status === "outcome_unknown").length,
        executorConfirmation: "unavailable",
      },
      worker: {
        running:
          this.worker.running ||
          Boolean(heartbeat && Date.now() - Date.parse(heartbeat.lastTickAt) < 15000),
        lastTickAt: heartbeat?.lastTickAt ?? this.worker.lastTickAt,
      },
    };
  }
  async getTask(owner: string, id: string) {
    const task = await this.db.get<AgentTask>(owner, "tasks", id);
    if (!task) throw new AppError("Task not found", 404);
    return task;
  }
  async detail(owner: string, id: string) {
    const task = await this.getTask(owner, id);
    const rootBudget = await this.db.get<TaskBudget>(
      owner,
      "task-budgets",
      typeof task.state.rootTaskId === "string" ? task.state.rootTaskId : task.id,
    );
    const files = (await this.db.list<Artifact>(owner, "files")).filter((file) =>
      task.artifactIds.includes(file.id),
    );
    const browsers = (await this.db.list<BrowserSession>(owner, "browsers")).filter((browser) =>
      [task.state.browserId, task.state.sessionId].includes(browser.id),
    );
    return {
      task: rootBudget ? { ...task, state: { ...task.state, budget: rootBudget } } : task,
      interactions: await Promise.all(
        (
          await this.db.list<
            import("../../../../packages/domain/src/runtime.ts").InteractionRequest
          >(owner, "interaction-requests")
        )
          .filter((request) => request.taskId === id)
          .map((request) => this.interactions.status(owner, request.id)),
      ),
      files: files.map((file) => this.files.signed(owner, file)),
      browsers: browsers.map((browser) => this.browser.decorate(owner, browser)),
      events: (await this.db.list<RunEvent>(owner, "run-events"))
        .filter((e) => e.taskId === id)
        .sort((a, b) => a.date.localeCompare(b.date)),
      artifacts: (await this.db.list<AgentArtifact>(owner, "agent-artifacts")).filter(
        (a) => a.taskId === id,
      ),
      directives: await this.mailbox.list(owner, id),
      operations: await this.journal.operations(owner, id),
    };
  }
  async createTask(
    owner: string,
    raw: unknown,
    idempotencyKey?: string,
    held = false,
    parent?: { id: string; rootTaskId: string },
    originalUserPrompt?: string,
  ) {
    const input = createTaskSchema.parse(raw);
    if (input.goalId && !(await this.db.get(owner, "goals", input.goalId)))
      throw new AppError("Goal not found", 404);
    const id = idempotencyKey ? hash(`task:${idempotencyKey}`) : randomUUID();
    const existing = await this.db.get<AgentTask>(owner, "tasks", id);
    if (existing) return existing;
    if (!held) await this.runtimePause.assertResumed(owner);
    if (
      (await this.db.list<AgentTask>(owner, "tasks")).filter((t) => !terminal.has(t.status))
        .length >= 100
    )
      throw new AppError("Finish or cancel some tasks before adding more", 409);
    const titles =
      input.kind === "document"
        ? [
            "Find the source document",
            "Fill a new copy",
            "Prepare a reply",
            "Wait for your decision",
            "Record the outcome",
          ]
        : input.kind === "monitor"
          ? ["Check the source", "Compare with the last observation", "Report a meaningful change"]
          : input.kind === "finance"
            ? ["Validate transactions", "Calculate the summary", "Save your tracker"]
            : ["Understand the outcome", "Plan the work", "Use connected tools", "Return a result"];
    const task: AgentTask = {
      id,
      title: input.title ?? (originalUserPrompt ?? input.prompt).slice(0, 90),
      prompt: originalUserPrompt ?? input.prompt,
      kind: input.kind,
      goalId: input.goalId,
      originThreadId: input.originThreadId,
      originMessageId: input.originMessageId,
      status: held ? "paused" : "queued",
      timing: { timezone: "Europe/Berlin", priority: "normal", ...input.timing },
      criteria: mandatoryTaskCriteria(input, input.criteria, originalUserPrompt),
      plan: titles.map((title, i) => ({ id: String(i), title, status: "pending" })),
      evidence: [],
      input: input.input,
      state: {
        desiredRevision: 0,
        appliedRevision: 0,
        mailboxSeq: 0,
        appliedMailboxSeq: 0,
        ...(parent ? { parentTaskId: parent.id, rootTaskId: parent.rootTaskId } : {}),
        connectionId: (await this.workspace.connection(owner))?.id ?? null,
        ...(held && input.kind === "monitor" ? { initializingMonitor: true } : {}),
      },
      createdAt: date(),
      updatedAt: date(),
      attempts: 0,
      leaseId: null,
      leaseUntil: null,
      artifactIds: [],
    };
    await this.ensure(owner);
    await this.db.insertIfAbsent(owner, "tasks", task);
    return (await this.db.get<AgentTask>(owner, "tasks", id)) ?? task;
  }
  async createChildTask(
    owner: string,
    parent: AgentTask,
    input: { prompt: string; title?: string },
    key: string,
  ) {
    const children = (await this.db.list<AgentTask>(owner, "tasks")).filter(
      (task) => task.state.parentTaskId === parent.id && !terminal.has(task.status),
    );
    if (children.length >= 4)
      throw new AppError("This task already has four unfinished child tasks", 409);
    const rootTaskId =
      typeof parent.state.rootTaskId === "string" ? parent.state.rootTaskId : parent.id;
    return this.createTask(owner, { ...input, kind: "plan", timing: parent.timing }, key, false, {
      id: parent.id,
      rootTaskId,
    });
  }
  async setRuntimePause(owner: string, input: { paused: boolean; expectedRevision: number }) {
    return this.runtimePause.set(owner, input);
  }
  async updateTaskPriority(owner: string, id: string, priority: TaskTiming["priority"]) {
    const task = await this.getTask(owner, id);
    if (terminal.has(task.status))
      throw new AppError("Finished tasks cannot be reprioritized", 409);
    return this.timing.update(owner, id, {
      priority,
      expectedRevision: Number(task.state.timingRevision ?? 0),
      requestId: randomUUID(),
    });
  }
  async control(owner: string, id: string, action: "pause" | "resume" | "cancel" | "retry") {
    const task = await this.getTask(owner, id);
    if (action === "cancel" && task.status === "succeeded")
      throw new AppError("This task is already complete", 409);
    if (action === "retry" && task.status !== "failed")
      throw new AppError("Only failed tasks can be retried", 409);
    if (action === "resume" && task.status !== "paused")
      throw new AppError("Only paused tasks can be resumed", 409);
    if (action === "pause" && (terminal.has(task.status) || task.status === "paused")) return task;
    const status =
      action === "cancel"
        ? "cancelled"
        : action === "pause"
          ? "paused"
          : task.actionId
            ? "waiting_approval"
            : "queued";
    if (action === "retry" && task.actionId) {
      const a = await this.db.get<ActionProposal>(owner, "actions", task.actionId);
      if (a && a.status !== "succeeded")
        throw new AppError(
          "Check the reviewed action before retrying; its outcome may be uncertain. Start a new task when reconciled.",
          409,
        );
    }
    const updated = await this.db.compareAndSwap<AgentTask>(
      owner,
      "tasks",
      id,
      { status: task.status, leaseId: task.leaseId ?? null },
      {
        status,
        leaseId: null,
        leaseUntil: null,
        error: null,
        updatedAt: date(),
        result:
          action === "cancel"
            ? "Stopped by you."
            : action === "pause"
              ? "Paused. Resume when you're ready."
              : "",
        ...(task.kind === "monitor" && action === "resume"
          ? { state: { ...task.state, failures: 0, notice: null, resumingMonitor: false } }
          : {}),
      },
    );
    if (!updated) throw new AppError("Task changed; refresh and try again", 409);
    this.worker.abort(id, action === "pause" ? "explicit_pause" : "explicit_cancel");
    if (task.kind === "monitor")
      await this.db.compareAndSwap(
        owner,
        "monitors",
        String(task.input.monitorId),
        {},
        {
          status: action === "cancel" ? "stopped" : action === "pause" ? "paused" : "active",
          nextCheckAt: date(),
          // Clearing the error fences out a failure reconcile that read the task before this.
          ...(action === "resume" || action === "retry" ? { error: null } : {}),
        },
      );
    if (action === "cancel" && task.actionId) {
      const proposal = await this.db.get<ActionProposal>(owner, "actions", task.actionId);
      if (proposal?.status === "awaiting_review")
        await this.actions.decide(owner, proposal.id, proposal.hash, "deny");
    }
    await this.db.put(owner, "run-events", {
      id: randomUUID(),
      taskId: id,
      kind: "status",
      date: date(),
      title: `Task ${status}`,
      detail: "Changed by you",
    });
    return updated;
  }
  async answer(
    owner: string,
    id: string,
    answer: string,
    fields?: Record<string, string | boolean>,
  ) {
    const task = await this.getTask(owner, id);
    if (task.status !== "waiting_input")
      throw new AppError("This task is not waiting for input", 409);
    const request = await this.interactions.forTask(owner, task);
    if (request.kind !== "question")
      throw new AppError("Use the trusted credential or action approval channel", 409);
    let typedAnswer: Record<string, string>;
    if (request.fieldBindings) {
      const names = Object.values(request.fieldBindings).map((binding) => binding.name);
      if (Object.keys(fields ?? {}).some((key) => !names.includes(key)))
        throw new AppError("Unknown document field", 422);
      typedAnswer = Object.fromEntries(
        Object.entries(request.fieldBindings).flatMap(([key, binding]) =>
          fields?.[binding.name] === undefined ? [] : [[key, String(fields[binding.name])]],
        ),
      );
    } else {
      if (request.schema.fields.length !== 1 || request.schema.fields[0].type !== "text")
        throw new AppError("Answer this task's typed question card", 409);
      typedAnswer = { [request.schema.fields[0].id]: answer };
    }
    await this.interactions.answer(
      owner,
      request.id,
      {
        clientResponseId: `legacy:${hash(`${id}:${task.attempts}:${answer}:${JSON.stringify(fields ?? {})}`)}`,
        revision: request.revision,
        answer: typedAnswer,
      },
      { fields, text: answer },
    );
    return this.getTask(owner, id);
  }
  async createGoal(owner: string, raw: unknown, id?: string) {
    const input = goalInputSchema.parse(raw);
    const goal: Goal = {
      id: id ?? randomUUID(),
      title: input.title,
      description: input.description,
      category: input.category,
      status: "active",
      milestones: input.milestones.map((title) => ({ id: randomUUID(), title, done: false })),
      createdAt: date(),
    };
    await this.db.insertIfAbsent(owner, "goals", goal);
    return (await this.db.get<Goal>(owner, "goals", goal.id)) ?? goal;
  }
  async updateGoal(
    owner: string,
    id: string,
    patch: { status?: Goal["status"]; milestones?: Goal["milestones"] },
  ) {
    const goal = await this.db.get<Goal>(owner, "goals", id);
    if (!goal) throw new AppError("Goal not found", 404);
    const saved = await this.db.put(owner, "goals", { ...goal, ...patch });
    if (patch.status === "paused")
      for (const task of await this.db.list<AgentTask>(owner, "tasks"))
        if (task.goalId === id && !terminal.has(task.status) && task.status !== "paused")
          await this.control(owner, task.id, "pause");
    return saved;
  }
  async createMonitor(owner: string, raw: unknown, idempotencyKey?: string) {
    const input = monitorInputSchema.parse(raw);
    const url = new URL(input.url);
    if (url.protocol === "sample:" && this.config.mode !== "sample")
      throw new AppError("Sample sources are unavailable in live workspaces", 422);
    if (!["https:", "http:", "sample:"].includes(url.protocol) || url.username || url.password)
      throw new AppError("Use a public HTTP(S) page", 422);
    if (url.protocol === "sample:" && input.url !== "sample://availability")
      throw new AppError("Unknown sample source", 422);
    const id = idempotencyKey ? hash(`monitor:${idempotencyKey}`) : randomUUID();
    const existing = await this.db.get<Monitor>(owner, "monitors", id);
    if (existing) {
      await this.activateMonitor(owner, existing);
      return existing;
    }
    await this.runtimePause.assertResumed(owner);
    const task = await this.createTask(
      owner,
      {
        kind: "monitor",
        title: input.title,
        prompt: `Watch ${input.url} for ${input.condition}${input.value ? `: ${input.value}` : ""}`,
        input: { monitorId: id },
      },
      `monitor:${id}`,
      true,
    );
    const monitor: Monitor = {
      id,
      taskId: task.id,
      ...input,
      status: "active",
      nextCheckAt: date(),
      checks: 0,
    };
    await this.db.insertIfAbsent(owner, "monitors", monitor);
    await this.activateMonitor(owner, monitor);
    return monitor;
  }
  private async activateMonitor(owner: string, monitor: Monitor) {
    if (monitor.status !== "active") return null;
    const task = await this.getTask(owner, monitor.taskId);
    if (task.status !== "paused") return null;
    if (task.state.resumingMonitor)
      return this.db.compareAndSwap(
        owner,
        "tasks",
        task.id,
        { status: "paused", state: { resumingMonitor: true } },
        {
          status: "queued",
          nextRunAt: date(),
          leaseId: null,
          leaseUntil: null,
          error: null,
          state: { ...task.state, resumingMonitor: false, failures: 0, notice: null },
        },
      );
    if (!task.state.initializingMonitor) return null;
    return this.db.compareAndSwap(
      owner,
      "tasks",
      task.id,
      { status: "paused", attempts: 0, state: { initializingMonitor: true } },
      {
        status: "queued",
        state: { ...task.state, initializingMonitor: false },
      },
    );
  }
  async controlMonitor(owner: string, id: string, action: "pause" | "resume" | "stop" | "check") {
    const monitor = await this.db.get<Monitor>(owner, "monitors", id);
    if (!monitor) throw new AppError("Monitor not found", 404);
    if (monitor.status === "stopped" && action !== "stop")
      throw new AppError("Create a new watch to restart this stopped monitor", 409);
    if (action === "resume" || action === "check") await this.runtimePause.assertResumed(owner);
    if (action === "pause" || action === "stop") {
      const status = action === "pause" ? "paused" : "stopped";
      const saved = await this.db.put(owner, "monitors", {
        ...monitor,
        status,
        nextCheckAt: date(),
      });
      const task = await this.getTask(owner, monitor.taskId);
      await this.control(owner, task.id, action === "pause" ? "pause" : "cancel");
      return saved;
    }
    let monitorStatus = monitor.status;
    for (let attempt = 0; attempt < 2; attempt++) {
      const task = await this.getTask(owner, monitor.taskId);
      if (task.status === "cancelled") break;
      if (task.status === "paused") {
        // Mark the paused task before activating the monitor so no worker can claim it in between.
        const marked = await this.db.compareAndSwap(
          owner,
          "tasks",
          task.id,
          { status: "paused", leaseId: task.leaseId ?? null },
          { state: { ...task.state, resumingMonitor: true } },
        );
        if (!marked) break;
        const activated = await this.db.compareAndSwap<Monitor>(
          owner,
          "monitors",
          id,
          { status: monitor.status },
          { status: "active", nextCheckAt: date(), error: null },
        );
        const saved = activated ?? (await this.db.get<Monitor>(owner, "monitors", id));
        if (saved?.status === "active" && (await this.activateMonitor(owner, saved))) return saved;
        const unmarked = await this.db.compareAndSwap(
          owner,
          "tasks",
          task.id,
          { status: "paused", state: { resumingMonitor: true } },
          { state: { ...task.state, resumingMonitor: false } },
        );
        // Another request or maintenance may have finished this resume first.
        if (!unmarked && saved?.status === "active") {
          const latest = await this.getTask(owner, task.id);
          if (["queued", "running", "scheduled"].includes(latest.status)) return saved;
        }
        if (activated)
          await this.db.compareAndSwap(
            owner,
            "monitors",
            id,
            { status: "active" },
            { status: monitor.status, error: monitor.error ?? null },
          );
        break;
      }
      // Only activate the monitor we read, so a concurrent stop is never undone.
      const saved = await this.db.compareAndSwap<Monitor>(
        owner,
        "monitors",
        id,
        { status: monitorStatus },
        { status: "active", nextCheckAt: date() },
      );
      if (!saved) break;
      monitorStatus = "active";
      this.worker.abort(task.id);
      const queued = await this.db.compareAndSwap(
        owner,
        "tasks",
        task.id,
        // updatedAt fences out a whole run finishing in between, which would move the baseline.
        { status: task.status, leaseId: task.leaseId ?? null, updatedAt: task.updatedAt },
        {
          status: "queued",
          nextRunAt: date(),
          leaseId: null,
          leaseUntil: null,
          error: null,
          state: { ...task.state, failures: 0, notice: null },
        },
      );
      if (queued) return saved;
    }
    throw new AppError("The watch changed while updating. Try again.", 409);
  }
  async refreshIdeas(owner: string) {
    const w = await this.workspace.snapshot(owner);
    const sentIds = new Set(
      w.mail.filter((mail) => /^Sent\b/i.test(mail.label)).map((mail) => mail.id),
    );
    const completedSources = new Set(
      (await this.db.list<AgentTask>(owner, "tasks"))
        .filter((task) => task.status === "succeeded" && typeof task.input.messageId === "string")
        .map((task) => `${task.kind}:${task.input.messageId}`),
    );
    const obsolete = (kind: AgentTask["kind"], messageId: unknown) =>
      typeof messageId === "string" &&
      (sentIds.has(messageId) || completedSources.has(`${kind}:${messageId}`));
    // Retire earlier suggestions as well as preventing new duplicates. A concurrent
    // acceptance wins its own compare-and-swap and is never overwritten here.
    for (const idea of await this.db.list<Idea>(owner, "ideas"))
      if (idea.status === "new" && obsolete(idea.kind, idea.input.messageId))
        await this.db.compareAndSwap(
          owner,
          "ideas",
          idea.id,
          { status: "new" },
          { status: "dismissed" },
        );
    for (const mail of w.mail
      .filter(
        (m) =>
          !obsolete("document", m.id) &&
          m.attachments.length &&
          /form|permission|complete|fill|sign/i.test(`${m.subject} ${m.body}`),
      )
      .slice(0, 5)) {
      const id = hash(`document:${mail.id}:${mail.body}`);
      const idea: Idea = {
        id,
        title: `I can help with ${mail.subject}`,
        reason: `${mail.sender} sent a document that may need your attention. I can prepare it and a reply for your review.`,
        evidence: [this.mailEvidence(mail)],
        prompt: `Help complete the PDF from “${mail.subject}” and prepare a reply for review.`,
        kind: "document",
        input: { messageId: mail.id },
        status: "new",
        createdAt: date(),
      };
      await this.db.insertIfAbsent(owner, "ideas", idea);
    }
    for (const mail of w.mail
      .filter(
        (m) =>
          !obsolete("agent", m.id) &&
          /coffee|meet|available|schedule/i.test(`${m.subject} ${m.body}`),
      )
      .slice(0, 5)) {
      await this.db.insertIfAbsent(owner, "ideas", {
        id: hash(`coordination:${mail.id}`),
        title: `I can help coordinate ${mail.subject}`,
        reason: `${mail.sender} mentioned getting together. I can check your calendar and prepare a response for review.`,
        evidence: [this.mailEvidence(mail)],
        prompt: `Review the email “${mail.subject}”, check my calendar, and propose a next step. Ask me about missing preferences before preparing a reply.`,
        kind: "agent",
        input: { messageId: mail.id },
        status: "new",
        createdAt: date(),
      } satisfies Idea);
    }
    for (const goal of await this.db.list<Goal>(owner, "goals"))
      if (goal.status === "active" && !goal.milestones.length) {
        const id = hash(`goal:${goal.id}:${goal.description}`);
        await this.db.insertIfAbsent(owner, "ideas", {
          id,
          title: `Let's make a plan for ${goal.title}`,
          reason: "This goal has no milestones yet. A concrete plan will give it a next step.",
          evidence: [{ id: goal.id, kind: "user", title: goal.title, excerpt: goal.description }],
          prompt: `Create an actionable plan for ${goal.title}. ${goal.description}`,
          kind: "plan",
          input: { goalId: goal.id },
          status: "new",
          createdAt: date(),
        } satisfies Idea);
      }
    await this.ensure(owner);
    await this.db.compareAndSwap(owner, "agent-settings", "identity", {}, { lastIdeasAt: date() });
    return this.db.list<Idea>(owner, "ideas");
  }
  async decideIdea(owner: string, id: string, action: "accept" | "dismiss", prompt?: string) {
    let idea = await this.db.get<Idea>(owner, "ideas", id);
    if (!idea) throw new AppError("Idea not found", 404);
    if (idea.status === "dismissed" || (idea.status === "accepted" && action === "dismiss"))
      return idea;
    if (action === "dismiss")
      return this.db.compareAndSwap<Idea>(
        owner,
        "ideas",
        id,
        { status: "new" },
        { status: "dismissed" },
      );
    if (
      idea.status === "new" ||
      (idea.status === "accepted" &&
        idea.taskId &&
        !(await this.db.get(owner, "tasks", idea.taskId)))
    )
      await this.runtimePause.assertResumed(owner);
    if (idea.status === "new") {
      const claimed = await this.db.compareAndSwap<Idea>(
        owner,
        "ideas",
        id,
        { status: "new" },
        {
          status: "accepted",
          taskId: hash(`task:idea:${id}`),
          prompt: prompt ?? idea.prompt,
        },
      );
      idea = claimed ?? (await this.db.get<Idea>(owner, "ideas", id));
      if (idea?.status !== "accepted") return idea;
    }
    const goal = await this.createGoal(
      owner,
      { title: idea.title, description: idea.reason },
      hash(`idea-goal:${id}`),
    );
    const task = await this.createTask(
      owner,
      {
        title: idea.title,
        prompt: idea.prompt,
        kind: idea.kind,
        input: idea.input,
        goalId: goal.id,
      },
      `idea:${id}`,
    );
    await this.db.compareAndSwap(
      owner,
      "ideas",
      id,
      { status: "new" },
      { status: "accepted", taskId: task.id },
    );
    return this.db.get<Idea>(owner, "ideas", id);
  }
  async notify(owner: string, title: string, body: string, taskId?: string, key?: string) {
    const value: AgentNotification = {
      id: key ? hash(key) : randomUUID(),
      taskId,
      title,
      body,
      createdAt: date(),
      read: false,
    };
    await this.push.notify(owner, value);
  }
  mailEvidence(mail: Mail): Evidence {
    const acquiredAt = (mail as Mail & { cachedAt?: string }).cachedAt;
    return {
      id: mail.id,
      kind: "mail",
      title: mail.subject,
      excerpt: mail.body.slice(0, 400),
      ...(acquiredAt ? { acquiredAt } : {}),
      origin: `mail:${mail.threadId}`,
      version: `${mail.id}:${acquiredAt ?? "unknown"}`,
    };
  }
  async artifact(
    owner: string,
    task: AgentTask,
    kind: AgentArtifact["kind"],
    title: string,
    summary: string,
    data: Record<string, unknown>,
    key: string = kind,
  ) {
    const value: AgentArtifact = {
      id: hash(`${task.id}:${key}`),
      taskId: task.id,
      kind,
      title,
      summary,
      data,
      createdAt: date(),
      revision: Number(task.state.appliedRevision ?? 0),
    };
    await this.db.put(owner, "agent-artifacts", value);
    return value;
  }
  async prepare(
    owner: string,
    task: AgentTask,
    input: ProposalInput,
    key: string,
    context: TaskContext,
  ) {
    await context.guard();
    await validateTaskEffect();
    const connection = await this.workspace.connection(owner);
    if (connection?.id !== task.state.connectionId)
      throw new AppError(
        "Google connection changed during this task. Start a new task using the current account.",
        409,
      );
    const proposal = await this.actions.propose(owner, input, `${task.id}:${key}`, task.id);
    if (proposal.status === "succeeded") return proposal;
    if (proposal.status !== "awaiting_review" && proposal.status !== "executing")
      throw new AppError(
        `Reviewed action ${proposal.status}: ${proposal.error ?? "No further action was taken"}`,
        409,
      );
    try {
      await context.checkpoint({ actionId: proposal.id });
    } catch (error) {
      const latest = await this.db.get<AgentTask>(owner, "tasks", task.id);
      if (proposal.status === "awaiting_review" && latest?.status === "cancelled")
        await this.actions.decide(owner, proposal.id, proposal.hash, "deny");
      throw error;
    }
    if (proposal.status === "awaiting_review")
      await context.event(
        "approval",
        proposal.title,
        `Review prepared for ${proposal.account ?? "the connected account"}`,
      );
    return proposal;
  }
  private async execute(
    owner: string,
    task: AgentTask,
    context: TaskContext,
  ): Promise<Partial<AgentTask>> {
    task = await this.actor.apply(owner, task, context);
    if (task.state.nativeCleanupPending === true) {
      const physical = (await this.journal.operations(owner, task.id)).filter(
        (op) => op.nativeEnvelope && op.effect,
      );
      const confirmed =
        physical.length > 0 &&
        physical.every(
          (op) =>
            ["succeeded", "failed", "rejected_not_dispatched", "superseded"].includes(op.status) ||
            (op.receipt as { data?: { cleanupConfirmed?: boolean } })?.data?.cleanupConfirmed ===
              true,
        );
      if (!confirmed) {
        await context.holdAdmission();
        return {
          status: "waiting_input",
          question: "A native effect is still awaiting physical cleanup and reconciliation.",
          state: task.state,
        };
      }
      task = await context.checkpoint({ state: { ...task.state, nativeCleanupPending: false } });
    }
    const recovered = await this.journal.reconcileFiles(owner, task.id, this.files);
    if (recovered.length)
      task = await context.checkpoint({
        artifactIds: [...new Set([...task.artifactIds, ...recovered])],
      });
    await context.event(
      "status",
      task.attempts === 1 ? "Started working" : "Resumed work",
      task.prompt,
    );
    const waitingCommandId = task.state.waitingComputerCommandId;
    if (typeof waitingCommandId === "string") {
      let receipt: ComputerCommand | undefined;
      try {
        receipt = await readComputerCommand(this.computer, owner, waitingCommandId);
      } catch {
        // A failed poll cannot prove that the external process stopped.
        return {
          status: "waiting_job",
          nextRunAt: new Date(Date.now() + 5000).toISOString(),
          state: task.state,
        };
      }
      if (!receipt || !computerCommandCleanupConfirmed(receipt))
        return {
          status: "waiting_job",
          nextRunAt: new Date(Date.now() + 5000).toISOString(),
          state: task.state,
        };
      await this.journal.reconcileComputerReceipt(owner, task.id, receipt);
      task = await context.checkpoint({
        state: {
          ...task.state,
          // Keep the receipt as a recovery selector until worker admission and
          // resource cleanup are both durably complete.
          waitingComputerCommandId: waitingCommandId,
          computerCleanupPendingId: waitingCommandId,
          uncertainComputerCommand: false,
          completedComputerJob: {
            id: receipt.id,
            status: receipt.status,
            exitCode: receipt.exitCode,
            stdout: receipt.stdout.slice(0, 12000),
            stderr: receipt.stderr.slice(0, 4000),
            truncated: receipt.truncated || receipt.stdout.length > 12000,
            cleanupConfirmed: receipt.cleanupConfirmed,
            outcomeUnknown: receipt.outcomeUnknown,
          },
        },
      });
      if (receipt.outcomeUnknown || ["interrupted", "timed_out"].includes(receipt.status))
        return {
          status: "waiting_input",
          question:
            "The computer process stopped, but its effect remains uncertain. Inspect its receipt before authorizing more work.",
          state: task.state,
          completion: await this.verification.assess(
            owner,
            task.id,
            Number(task.state.appliedRevision ?? 0),
          ),
        };
    }
    const nativeResult = await this.nativeExecution?.(owner, task, context);
    if (nativeResult) return nativeResult;
    if (task.actionId) {
      const action = await this.db.get<ActionProposal>(owner, "actions", task.actionId);
      if (!action) throw new Error("The linked review could not be found");
      if (action.status === "succeeded") {
        await context.event("result", "Approved action completed", action.result);
        if (task.kind === "document")
          return this.finish(task, context, action.result ?? "Reply completed", owner);
        task = await context.checkpoint({
          state: { ...task.state, approvalResult: action.result },
          actionId: null,
        });
      } else if (action.status !== "awaiting_review" && action.status !== "executing")
        throw new Error(
          `Reviewed action ${action.status}: ${action.error ?? "No further action was taken"}`,
        );
      else if (
        action.status === "awaiting_review" &&
        (action.preparedRevision ?? 0) !== Number(task.state.appliedRevision ?? 0)
      ) {
        await this.db.compareAndSwap<ActionProposal>(
          owner,
          "actions",
          action.id,
          { status: "awaiting_review", hash: action.hash },
          {
            status: "expired",
            error: "A later direction changed the task; prepare a review for its current revision.",
          },
        );
        task = await context.checkpoint({ actionId: null });
      } else return { status: "waiting_approval" };
    }
    if (task.kind === "document") return this.document(owner, task, context);
    if (task.kind === "monitor") {
      try {
        return await this.observe(owner, task, context);
      } catch (error) {
        if (error instanceof LostLeaseError || context.signal.aborted) throw error;
        await context.guard();
        const failures = Number(task.state.failures ?? 0) + 1;
        // Each streak of failures (after a success or a resume) gets its own alerts.
        const failureStreak = Number(task.state.failureStreak ?? 0) + (failures === 1 ? 1 : 0);
        const detail = error instanceof Error ? error.message : "Page check failed";
        const nextCheckAt = new Date(
          Date.now() + Math.min(60, 2 ** failures) * 60000,
        ).toISOString();
        await this.db.compareAndSwap(
          owner,
          "monitors",
          String(task.input.monitorId),
          { status: "active" },
          { error: detail, nextCheckAt },
        );
        await context.event(
          "error",
          failures >= 5 ? "Watch paused after repeated failures" : "Check failed; retry scheduled",
          detail,
        );
        return {
          status: failures >= 5 ? "paused" : "scheduled",
          error: detail,
          nextRunAt: nextCheckAt,
          state: {
            ...task.state,
            failures,
            resumingMonitor: false,
            failureStreak,
            notice: {
              title: "Watch needs attention",
              body: detail,
              key: `watch-error:${task.id}:${failureStreak}:${failures >= 5 ? "paused" : "retry"}`,
            },
          },
        };
      }
    }
    if (task.kind === "finance") {
      await context.event("step", "Analyzing the imported transactions");
      const csv = z.string().parse(task.input.csv);
      const data = analyzeSpending(csv);
      const artifact = await this.artifact(
        owner,
        task,
        "finance",
        "Spending tracker",
        `${data.count} transactions · ${data.spending.toFixed(2)} spent`,
        data,
      );
      task = await context.checkpoint({
        artifactIds: [artifact.id],
        evidence: [
          {
            id: task.id,
            kind: "user",
            title: "Your transaction CSV",
            excerpt: `${data.count} rows; ${data.period.from} through ${data.period.to}`,
          },
        ],
      });
      return this.finish(task, context, artifact.summary, owner);
    }
    return executeModelTask(this, owner, task, context);
  }
  async finish(task: AgentTask, context: TaskContext, result: string, owner?: string) {
    await context.guard();
    // TaskContext executes under an owner; deterministic workflows pass it
    // explicitly, model calls do likewise. Do not infer owner from model data.
    if (!owner) throw new Error("Completion requires the authenticated task owner");
    const completion = await this.verification.assess(
      owner,
      task.id,
      Number(task.state.appliedRevision ?? 0),
    );
    await context.event(
      "result",
      completion.status === "verified" ? "Work completed" : "Partial delivery",
      result,
    );
    return {
      status:
        completion.status === "verified" ? ("succeeded" as const) : ("waiting_input" as const),
      result,
      completion,
      ...(completion.status !== "verified" ? { question: completion.remaining.join("\n") } : {}),
      state: { ...task.state, verificationRevision: Number(task.state.appliedRevision ?? 0) },
    };
  }
  private async publishOutcome(owner: string, saved: AgentTask) {
    const task = await this.getTask(owner, saved.id);
    if (terminal.has(task.status) && typeof task.state.parentTaskId === "string") {
      const parent = await this.db.get<AgentTask>(owner, "tasks", task.state.parentTaskId);
      const children = (await this.db.list<AgentTask>(owner, "tasks")).filter(
        (child) => child.state.parentTaskId === task.state.parentTaskId,
      );
      if (
        parent?.status === "waiting_children" &&
        children.length &&
        children.every((child) => terminal.has(child.status))
      ) {
        const updated = await this.db.compareAndSwapTask(
          owner,
          parent.id,
          { status: "waiting_children" },
          {
            state: {
              ...parent.state,
              childrenResults: children.map((child) => ({
                id: child.id,
                title: child.title,
                status: child.status,
                result: child.result,
                completion: child.completion,
                artifactIds: child.artifactIds,
              })),
            },
          },
        );
        if (updated) await this.actor.wake(owner, parent.id, "children");
      }
    }
    if (task.status === "succeeded") {
      if (task.originThreadId && typeof task.input.routineId !== "string") {
        await this.db.insertIfAbsent(owner, "thread-publications", {
          id: `task:${task.id}`,
          threadId: task.originThreadId,
          taskId: task.id,
          title: task.title,
          text: task.result ?? "Task completed",
          status: this.localThreads ? "pending" : "unsupported_cloud_mode",
        });
        await this.flushPublications();
      }
      if (typeof task.input.routineId === "string") {
        await this.db.insertIfAbsent(owner, "conversation-settings", {
          id: "main",
          threadId: randomUUID(),
          existing: false,
        });
        const main = await this.db.get<{ threadId: string }>(
          owner,
          "conversation-settings",
          "main",
        );
        if (main)
          await this.db.insertIfAbsent(owner, "thread-publications", {
            id: `routine:${task.id}`,
            threadId: main.threadId,
            taskId: task.id,
            title: task.title,
            text: task.result ?? "Routine completed",
            status: this.localThreads ? "pending" : "unsupported_cloud_mode",
          });
        await this.flushPublications();
      }
      if (typeof task.input.routineId !== "string" || !this.localThreads)
        await this.notify(
          owner,
          task.title,
          task.result ?? "Work completed",
          task.id,
          `task-done:${task.id}`,
        );
      if (task.goalId) {
        for (let attempt = 0; attempt < 8; attempt++) {
          const goal = await this.db.get<Goal>(owner, "goals", task.goalId);
          if (!goal || goal.milestones.some((m) => m.id === task.id)) break;
          if (
            await this.db.compareAndSwap(
              owner,
              "goals",
              goal.id,
              { milestones: goal.milestones },
              {
                milestones: [...goal.milestones, { id: task.id, title: task.title, done: true }],
              },
            )
          )
            break;
        }
      }
    } else if (task.status === "failed") {
      await this.notify(
        owner,
        "Task needs attention",
        task.error ?? task.title,
        task.id,
        `task-error:${task.id}:${task.attempts}`,
      );
    } else if (task.status === "waiting_input") {
      await this.interactions.forTask(owner, task);
      const delivery = [
        task.result,
        task.artifactIds.length ? `Saved artifacts: ${task.artifactIds.join(", ")}` : undefined,
        task.completion?.checks.some((check) => check.passed)
          ? `Verified criteria: ${task.completion.checks
              .filter((check) => check.passed)
              .map((check) => check.criterionId)
              .join(", ")}`
          : undefined,
        task.completion?.remaining.length
          ? `Remaining: ${task.completion.remaining.join("; ")}`
          : undefined,
        `Needs attention: ${task.question ?? task.error ?? "More information is required"}`,
      ]
        .filter(Boolean)
        .join("\n");
      if (task.originThreadId) {
        await this.db.insertIfAbsent(owner, "thread-publications", {
          id: `partial:${task.id}:${task.attempts}:${Number(task.state.appliedRevision ?? 0)}`,
          threadId: task.originThreadId,
          taskId: task.id,
          title: task.title,
          text: delivery,
          status: this.localThreads ? "pending" : "unsupported_cloud_mode",
        });
        await this.flushPublications();
      }
      await this.notify(
        owner,
        "Your details are needed",
        delivery,
        task.id,
        `input:${task.id}:${hash(task.question ?? "")}`,
      );
    } else if (task.status === "waiting_approval") {
      await this.notify(
        owner,
        "Ready for your review",
        task.title,
        task.id,
        `review:${task.actionId}`,
      );
    }
    const notice = z
      .object({ title: z.string(), body: z.string(), key: z.string() })
      .safeParse(task.state.notice);
    if ((task.status === "scheduled" || (task.status === "paused" && task.error)) && notice.success)
      await this.notify(owner, notice.data.title, notice.data.body, task.id, notice.data.key);
    // A watch pauses after repeated failures only once that task outcome has committed.
    if (task.kind === "monitor" && task.status === "paused" && task.error)
      await this.db.compareAndSwap(
        owner,
        "monitors",
        String(task.input.monitorId),
        { status: "active", error: task.error },
        { status: "paused" },
      );
  }
  private async document(
    owner: string,
    task: AgentTask,
    ctx: TaskContext,
  ): Promise<Partial<AgentTask>> {
    let source = task.state.source as { mail: Mail; fileId: string } | undefined;
    if (!source) {
      const w = await this.workspace.snapshot(owner);
      const mail = w.mail.find((m) => m.id === task.input.messageId);
      if (!mail) throw new Error("Choose a current email with a PDF attachment to start this task");
      const ref = mail.attachments[0];
      if (!ref) throw new Error("This email has no PDF attachment");
      await ctx.guard();
      const file = z.object({ id: z.string(), name: z.string() }).parse(
        await this.journal.run(
          owner,
          task,
          {
            id: `document:${Number(task.state.appliedRevision ?? 0)}:source`,
            name: "import_pdf",
            args: { reference: ref },
          },
          async () => {
            try {
              return await this.files.get(owner, ref);
            } catch (error) {
              if (!(error instanceof AppError && error.status === 404)) throw error;
              return this.workspace.importAttachment(owner, ref);
            }
          },
          true,
        ),
      );
      source = { mail, fileId: file.id };
      task = await ctx.checkpoint({
        state: { ...task.state, source },
        evidence: [this.mailEvidence(mail)],
        plan: task.plan.map((s, i) => ({ ...s, status: i === 0 ? "succeeded" : "pending" })),
      });
      await ctx.event("step", "Found the document", file.name);
    }
    const fields = z
      .record(z.string(), z.union([z.string(), z.boolean()]))
      .optional()
      .parse(task.input.fields);
    if (!fields || !Object.keys(fields).length) {
      const file = await this.files.get(owner, source.fileId);
      const names = file.fields
        ?.filter((f) => f.type !== "unsupported")
        .map((f) => f.name)
        .join(", ");
      if (!names)
        throw new Error(
          "This PDF has no supported fillable fields. Open it in Files to review it.",
        );
      return {
        status: "waiting_input",
        question: `Enter the form values you want to use. Supported fields: ${names}. The original PDF will stay intact.`,
        state: {
          ...task.state,
          source,
          missingFields: file.fields?.filter((f) => f.type !== "unsupported"),
        },
      };
    }
    let filledId = typeof task.state.filledId === "string" ? task.state.filledId : undefined;
    if (!filledId) {
      await ctx.guard();
      const filled = z.object({ id: z.string(), name: z.string() }).parse(
        await this.journal.run(
          owner,
          task,
          {
            id: `document:${Number(task.state.appliedRevision ?? 0)}:fill`,
            name: "fill_pdf",
            args: { fileId: source.fileId, values: fields },
          },
          () => this.files.fill(owner, source.fileId, fields),
          true,
        ),
      );
      filledId = filled.id;
      task = await ctx.checkpoint({
        state: { ...task.state, source, filledId },
        artifactIds: [filledId],
        plan: task.plan.map((s, i) => ({ ...s, status: i <= 1 ? "succeeded" : "pending" })),
      });
      await ctx.event("step", "Saved a filled copy", filled.name);
    }
    const input: ProposalInput = {
      kind: "email.send",
      data: {
        to: [source.mail.from],
        cc: [],
        bcc: [],
        subject: /^re:/i.test(source.mail.subject)
          ? source.mail.subject
          : `Re: ${source.mail.subject}`,
        body:
          typeof task.input.reply === "string"
            ? task.input.reply
            : "Hello,\n\nPlease find the completed form attached.\n\nThank you.",
        attachmentIds: [filledId],
        threadId: source.mail.threadId,
        replyToMessageId: source.mail.id,
      },
    };
    const proposal = await this.prepare(owner, task, input, "document-reply", ctx);
    if (proposal.status === "succeeded") {
      task = await ctx.checkpoint({ actionId: null });
      return this.finish(task, ctx, proposal.result ?? "Reply completed", owner);
    }
    return {
      status: "waiting_approval",
      actionId: proposal.id,
      plan: task.plan.map((s, i) => ({
        ...s,
        status: i < 3 ? "succeeded" : i === 3 ? "waiting" : "pending",
      })),
    };
  }
  private async observe(
    owner: string,
    task: AgentTask,
    ctx: TaskContext,
  ): Promise<Partial<AgentTask>> {
    const monitor = await this.db.get<Monitor>(owner, "monitors", String(task.input.monitorId));
    if (!monitor) throw new Error("Monitor not found");
    if (monitor.status !== "active")
      return { status: monitor.status === "paused" ? "paused" : "cancelled" };
    let observation: { url: string; title: string; text: string; sessionId?: string };
    if (monitor.url === "sample://availability") {
      if (this.config.mode !== "sample") throw new Error("Sample source unavailable");
      const page = await this.db.get<{ text: string }>(owner, "sample-pages", "availability");
      observation = {
        url: monitor.url,
        title: "Sample dinner availability",
        text: page?.text ?? "No tables available. Check again later.",
      };
    } else {
      await ctx.guard();
      observation = await this.browser.observe(
        owner,
        monitor.url,
        typeof task.state.sessionId === "string" ? task.state.sessionId : undefined,
        task.id,
        ctx.trackResourceLeases,
      );
    }
    const text = observation.text.replace(/\s+/g, " ").trim();
    const currentHash = hash(text);
    const previousHash =
      typeof task.state.lastHash === "string" ? task.state.lastHash : monitor.lastHash;
    const matched =
      monitor.condition === "change"
        ? Boolean(previousHash && previousHash !== currentHash)
        : monitor.condition === "contains"
          ? text.toLowerCase().includes(monitor.value.toLowerCase())
          : this.matchesPrice(text, Number(monitor.value));
    const previouslyMatched = Boolean(task.state.matched);
    const shouldNotify = matched && (monitor.condition === "change" || !previouslyMatched);
    const nextCheckAt = new Date(Date.now() + monitor.intervalMinutes * 60000).toISOString();
    await ctx.guard();
    // Worker lease is checked before each publication; monitor control also invalidates that lease.
    const savedMonitor = await this.db.compareAndSwap(
      owner,
      "monitors",
      monitor.id,
      { status: "active" },
      {
        checks: monitor.checks + 1,
        lastCheckedAt: date(),
        lastHash: currentHash,
        lastValue: text.slice(0, 1000),
        nextCheckAt,
        error: null,
      },
    );
    if (!savedMonitor) throw new LostLeaseError();
    await ctx.event(
      "observation",
      previousHash ? "Checked for changes" : "Saved the first observation",
      text.slice(0, 1000),
    );
    if (shouldNotify) {
      await ctx.guard();
      await ctx.event("result", "A meaningful change was found", text.slice(0, 500));
    }
    return {
      status: "scheduled",
      nextRunAt: nextCheckAt,
      result: shouldNotify
        ? "Change found. A notification is ready."
        : "Watching. I'll check again on schedule.",
      state: {
        ...task.state,
        sessionId: observation.sessionId,
        lastHash: currentHash,
        resumingMonitor: false,
        matched,
        failures: 0,
        notice: shouldNotify
          ? {
              title: monitor.title,
              body: `Condition met at ${observation.url}: ${text.slice(0, 240)}`,
              key: `monitor:${monitor.id}:${currentHash}`,
            }
          : null,
      },
      error: null,
      evidence: [
        {
          id: monitor.id,
          kind: "web",
          title: observation.title,
          url: observation.url,
          excerpt: text.slice(0, 600),
        },
      ],
      plan: task.plan.map((s) => ({ ...s, status: "succeeded" })),
    };
  }
  private matchesPrice(text: string, threshold: number) {
    const matches = [...text.matchAll(/(?:\$|USD\s*)(\d+(?:,\d{3})*(?:\.\d{1,2})?)/g)];
    return matches.some((m) => Number(m[1].replace(/,/g, "")) < threshold);
  }
}
