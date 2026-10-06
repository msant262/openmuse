import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import {
  procedureCatalogSchema,
  procedureInputSchema,
  procedureReadSchema,
} from "../../../../packages/domain/src/playbooks.ts";
import { bindingHash, type InboxMessage } from "../conversation-inbox.ts";
import type { AgentService } from "../engine/service.ts";
import { tanstackAgent } from "../engine/tanstack-agent.ts";
import type { TaskContext } from "../engine/worker.ts";
import { AppError } from "../errors.ts";
import type { ProviderContinuationCheckpoint } from "../providers/models.ts";
import { modelSelection, selectionContextModel } from "../providers/preferences.ts";
import { sourcedMemoryInput as learningMemoryInput, writeSourcedMemory } from "./memory-writer.ts";
import { learningReviewPrompt } from "./prompts.ts";

type Source = { kind: string; id: string };
type State = {
  id: string;
  generation: number;
  activeTaskId: string | null;
  lastReviewedAt?: string;
  lastError?: string | null;
  changes?: number;
};

export { sourcedMemoryInput as learningMemoryInput } from "./memory-writer.ts";

/** Hermes post-turn review pattern on the existing durable worker, never a second runner. */
export class PersonalLearning {
  private readonly active = new Map<string, () => void>();
  constructor(
    private readonly service: AgentService,
    private readonly now = Date.now,
  ) {}
  private get db() {
    return this.service.db;
  }
  get enabled() {
    return (
      this.service.config.memoryLearningEnabled === true &&
      this.service.config.agentBackend === "model"
    );
  }
  interrupt(owner: string) {
    this.active.get(owner)?.();
  }
  async settled(owner: string) {
    if (!this.enabled) return true;
    if (await this.db.learningConversationActive(owner)) return false;
    const status = await this.status(owner);
    if (status.activeTask && status.activeTask.status !== "succeeded") return false;
    return (await this.db.learningCandidates(owner, 1)).length === 0;
  }
  async status(owner: string) {
    const state = await this.db.get<State>(owner, "learning-state", "review");
    const task = state?.activeTaskId
      ? await this.db.get<AgentTask>(owner, "tasks", state.activeTaskId)
      : null;
    return {
      enabled: this.enabled,
      ...state,
      activeTask: task
        ? { id: task.id, status: task.status, error: task.error, nextRunAt: task.nextRunAt }
        : null,
    };
  }
  async retry(owner: string) {
    await this.service.runtimePause.assertResumed(owner);
    const status = await this.status(owner);
    if (status.activeTask?.status !== "failed")
      throw new AppError("There is no failed learning review to retry", 409);
    return this.service.control(owner, status.activeTask.id, "retry");
  }
  async scheduleDue(owner: string): Promise<string | undefined> {
    if (!this.enabled || (await this.service.runtimePause.get(owner)).paused) return;
    await this.db.insertIfAbsent(owner, "learning-state", {
      id: "review",
      generation: 0,
      activeTaskId: null,
    });
    let state = (await this.db.get<State>(owner, "learning-state", "review"))!;
    if (state.activeTaskId) {
      const task = await this.db.get<AgentTask>(owner, "tasks", state.activeTaskId);
      if (task && !["succeeded", "failed", "cancelled"].includes(task.status)) return task.id;
      // Removed evidence can be retired without inference. Valid failed corrections
      // remain pending; a cancelled review is never restarted automatically.
      if (task?.status === "failed") {
        const sources = (task.input.learningSources ?? []) as Source[];
        if (sources.length && !(await this.db.learningReviewSources(owner, sources)).length)
          await this.db.compareAndSwapTask(
            owner,
            task.id,
            { status: "failed" },
            {
              status: "queued",
              error: null,
              nextRunAt: null,
            },
          );
        return task.id;
      }
      if (task?.status === "cancelled") return task.id;
      await this.db.compareAndSwap(
        owner,
        "learning-state",
        "review",
        { activeTaskId: state.activeTaskId, generation: state.generation },
        {
          activeTaskId: null,
          lastReviewedAt: task?.updatedAt,
          lastError: task?.status === "succeeded" ? null : (task?.error ?? "Review interrupted"),
          changes: Number(task?.state.learningChanges ?? 0),
        },
      );
      state = (await this.db.get<State>(owner, "learning-state", "review"))!;
      if (state.activeTaskId) return state.activeTaskId;
    }
    const candidates = await this.db.learningCandidates(owner, 8);
    if (!candidates.length) return;
    const sources = candidates.map(({ kind, value }) => ({ kind, id: value.id }));
    const id = bindingHash({ kind: "personal-learning", owner, sources });
    const task = await this.service.taskRecord(
      owner,
      {
        title: "Review personal memory and learned procedures",
        prompt: "Consolidate useful sourced personal context and verified procedures.",
        input: { memoryReview: true, internalActivity: true, learningSources: sources },
        timing: { priority: "low", timezone: this.service.routines.timezone },
      },
      id,
    );
    const result = await this.db.durableMutation(
      owner,
      `learning-schedule:${id}`,
      bindingHash(sources),
      [
        {
          kind: "learning-state",
          id: "review",
          mode: "merge",
          expected: { generation: state.generation, activeTaskId: null },
          value: { generation: state.generation + 1, activeTaskId: id },
        },
        { kind: "tasks", id, mode: "insert", value: { ...task } },
        {
          kind: "task-budgets",
          id,
          mode: "insert",
          value: {
            id,
            revision: 0,
            maxSteps: 24,
            usedSteps: 0,
            maxMilliseconds: 300000,
            usedMilliseconds: 0,
          },
        },
        ...sources.map((s) => ({
          kind: "learning-sources",
          id: `${s.kind}:${s.id}`,
          mode: "insert" as const,
          value: { id: `${s.kind}:${s.id}`, reviewTaskId: id },
        })),
      ],
      [],
      true,
    );
    if (result.status === "paused") return;
    if (result.status === "revision_conflict")
      return (
        (await this.db.get<State>(owner, "learning-state", "review"))?.activeTaskId ?? undefined
      );
    return id;
  }
  async learn(owner: string, raw: unknown, messages: InboxMessage[], reviewTaskId: string) {
    return writeSourcedMemory(
      this.service,
      owner,
      raw,
      messages,
      { kind: "learning", taskId: reviewTaskId, messageId: messages.at(-1)?.messageId },
      `learn:${reviewTaskId}`,
      this.now,
    );
  }
  async review(owner: string, task: AgentTask, ctx: TaskContext): Promise<Partial<AgentTask>> {
    await ctx.guard();
    const defer = () => ({
      status: "scheduled" as const,
      nextRunAt: new Date(this.now() + 30000).toISOString(),
      state: task.state,
    });
    if (await this.db.learningConversationActive(owner)) return defer();
    const watermark = await this.db.learningWatermark(owner);
    let preempted = false;
    let sourcesChanged = false;
    let availableKeys: Set<string> | undefined;
    const sources = task.input.learningSources as Source[];
    const guard = async () => {
      await ctx.guard();
      if (preempted || (await this.db.learningWatermark(owner)) !== watermark)
        throw new AppError(
          "Learning deferred for the newer conversation",
          409,
          "LEARNING_PREEMPTED",
        );
      if (availableKeys) {
        const expectedKeys = availableKeys;
        const current = await this.db.learningReviewSources(owner, sources);
        if (
          current.length !== expectedKeys.size ||
          current.some((s) => !expectedKeys.has(`${s.kind}:${s.value.id}`))
        ) {
          sourcesChanged = true;
          throw new AppError(
            "Learning evidence was removed; review the remaining sources",
            409,
            "LEARNING_SOURCE_CHANGED",
          );
        }
      }
    };
    const messages: InboxMessage[] = [];
    const completed: AgentTask[] = [];
    const available = await this.db.learningReviewSources(owner, sources);
    const liveKeys = new Set(available.map((s) => `${s.kind}:${s.value.id}`));
    availableKeys = liveKeys;
    const retired = sources.filter((s) => !liveKeys.has(`${s.kind}:${s.id}`));
    const pendingWrites = new Map<string, string>(
      Array.isArray(task.state.learningWriteErrors)
        ? (task.state.learningWriteErrors as [string, string][])
        : [],
    );
    for (const s of retired) if (s.kind === "tasks") pendingWrites.delete(`procedure:${s.id}`);
    task.state = {
      ...task.state,
      learningRetiredSources: retired,
      learningWriteErrors: [...pendingWrites],
    };
    if (!available.length) {
      // This is a retirement receipt, not a claim that removed evidence was learned.
      return {
        status: "succeeded",
        error: null,
        result:
          "Review retired because its source data was removed. No new learning was performed.",
        state: {
          ...task.state,
          learningWriteErrors: [],
          learningSummary: "Source data removed; nothing to review.",
        },
        completion: { status: "verified", checks: [], remaining: [] },
      };
    }
    for (const s of available)
      if (s.kind === "conversation-inbox") messages.push(s.value as unknown as InboxMessage);
      else if (s.kind === "tasks") completed.push(s.value as unknown as AgentTask);
    // Like Hermes' conversation snapshot, retain later user context during backlog recovery.
    const recent = await this.db.learningConversation(owner, [
      ...new Set(messages.map((m) => m.threadId)),
    ]);
    for (const m of recent)
      if (!messages.some((existing) => existing.id === m.id)) messages.push(m);
    messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const selection = await modelSelection(this.db, this.service.config, owner);
    if (!selection.model) throw new AppError("No connected model for personal learning", 503);
    const memories = (await this.service.memory.page(owner, { limit: 40, includeInactive: true }))
      .entries;
    const viewedProcedures = new Set<string>();
    let toolQueue: Promise<unknown> = Promise.resolve();
    const written = new Set(
      (await this.service.journal.operations(owner, task.id))
        .filter(
          (o) =>
            o.status === "succeeded" && ["learn_memory", "learn_procedure"].includes(o.toolName),
        )
        .map((o) => o.id),
    );
    let changes = written.size,
      finished = false,
      learningSummary = "";
    let providerFailure: ProviderContinuationCheckpoint | undefined;
    const countChanges = async () => {
      changes = (await this.service.journal.operations(owner, task.id)).filter(
        (o) => o.status === "succeeded" && ["learn_memory", "learn_procedure"].includes(o.toolName),
      ).length;
      await ctx.checkpoint({ state: { ...task.state, learningChanges: changes } });
    };
    const tools = [
      defineTool({
        name: "learn_procedure",
        description:
          "Save a verified reusable method, or update an existing automatically learned procedure. Source task and tools must have successful receipts; user-owned procedures are protected.",
        parameters: procedureInputSchema,
        execute: async (input) => {
          await guard();
          if (input.id && !viewedProcedures.has(`${input.id}:${input.expectedVersion}`))
            throw new AppError("Read the current procedure before changing it", 409);
          const writeKey = `procedure:${input.sourceTaskId}`;
          pendingWrites.set(
            writeKey,
            "Read the current procedure and retry the failed write with its exact id/version",
          );
          const result = await this.service.journal.run(
            owner,
            task,
            {
              id: `learning-procedure:${bindingHash(input)}`,
              name: "learn_procedure",
              args: input,
            },
            () =>
              this.service.playbooks.saveLearned(
                owner,
                { ...input, requestId: `learning:${task.id}:${input.requestId}` },
                completed.map((t) => t.id),
              ),
            true,
          );
          if (!result || typeof result !== "object" || !("id" in result))
            throw new AppError("Procedure write did not produce a saved record", 409);
          pendingWrites.delete(writeKey);
          await countChanges();
          return result;
        },
      }),
      defineTool({
        name: "list_procedures",
        description:
          "Discover existing reusable procedures with bounded metadata. Read the matching exact method before updating or creating a duplicate.",
        parameters: procedureCatalogSchema,
        execute: async (input) => {
          await guard();
          return this.service.playbooks.catalog(owner, input);
        },
      }),
      defineTool({
        name: "read_procedure",
        description:
          "Read one exact reusable method before changing it. Pinned and user-owned methods are protected from automatic learning.",
        parameters: procedureReadSchema,
        execute: async (input) => {
          await guard();
          const procedure = await this.service.playbooks.read(
            owner,
            input,
            `learning:${task.id}:${input.id}`,
          );
          viewedProcedures.add(`${procedure.id}:${procedure.version}`);
          return procedure;
        },
      }),
      defineTool({
        name: "learn_memory",
        description:
          "Save or correct a compact user fact, taste, evidenced habit or follow-up plan. Quote the supplied user evidence. Update matching memory by id/revision.",
        parameters: learningMemoryInput,
        execute: async (input) => {
          await guard();
          const writeKey = `memory:${input.category}:${input.evidence
            .map((e) => e.messageId)
            .sort()
            .join(":")}`;
          pendingWrites.set(
            writeKey,
            "Use recall_memory to obtain the exact current memory id/revision, then repair the failed write",
          );
          const result = await this.service.journal.run(
            owner,
            task,
            { id: `learning-memory:${bindingHash(input)}`, name: "learn_memory", args: input },
            () => this.learn(owner, input, messages, task.id),
            true,
          );
          if (!result || typeof result !== "object" || !("id" in result))
            throw new AppError("Memory write did not produce a saved record", 409);
          pendingWrites.delete(writeKey);
          await countChanges();
          return result;
        },
      }),
      defineTool({
        name: "recall_memory",
        description: "Search saved facts before adding a duplicate or contradiction.",
        parameters: z.object({ query: z.string().max(500).default("") }),
        execute: async ({ query }) => {
          await guard();
          return this.service.memory.recall(owner, query);
        },
      }),
      defineTool({
        name: "finish_learning",
        description:
          "Finish this review after confirmed saves, or explicitly report no durable learning.",
        parameters: z.object({ summary: z.string().max(500) }),
        execute: async ({ summary }) => {
          await guard();
          if (pendingWrites.size)
            throw new AppError(
              `Learning is incomplete: ${JSON.stringify([...pendingWrites])}. Repair these writes before finishing.`,
              409,
            );
          learningSummary = summary;
          finished = true;
          return { finished: true, changes, summary };
        },
      }),
    ];
    const agent = tanstackAgent({
      model: selection.model,
      fallbacks: selection.fallbacks,
      providers: this.service.config.modelProviders,
      contextModel:
        selectionContextModel(this.service.config, selection) ?? this.service.contextModel,
      maxSteps: 8,
      tools,
      prompt: learningReviewPrompt,
      workClass: "background",
      onProviderInterrupted: async (checkpoint) => {
        providerFailure = checkpoint;
        task = await ctx.checkpoint({ state: { ...task.state, providerCheckpoint: checkpoint } });
      },
      shouldContinue: () => !finished,
      trackTool: (execute) => this.service.toolOperations.run(execute),
      executeTool: (_call, execute) => {
        const result = toolQueue.then(execute);
        toolQueue = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
      promptContext: async () => {
        await guard();
        task = await this.service.actor.beforeInference(owner, task, ctx);
        return "";
      },
    });
    agent.threadId = `learning-${task.id}`;
    agent.setMessages([
      {
        id: `learning-evidence-${task.id}`,
        role: "user",
        content: JSON.stringify({
          now: new Date(this.now()).toISOString(),
          timezone: this.service.routines.timezone,
          unresolvedWrites: [...pendingWrites],
          // The selected model's ContextBudget owns admission. Never silently
          // consume a source while hiding its evidence behind a fixed char cap.
          userMessages: messages.map((m) => ({
            messageId: m.messageId,
            threadId: m.threadId,
            createdAt: m.createdAt,
            text: m.text,
          })),
          existingMemories: memories.map((m) => ({
            id: m.id,
            text: m.text.slice(0, 1800),
            revision: m.revision,
            status: m.status,
            category: m.category,
            followUp: m.followUp,
            validUntil: m.validUntil,
          })),
          verifiedTasks: await Promise.all(
            completed.map(async (t) => ({
              id: t.id,
              prompt: t.prompt.slice(0, 2000),
              result: t.result?.slice(0, 3000),
              successfulTools: (await this.service.journal.operations(owner, t.id))
                .filter((o) => o.status === "succeeded")
                .map((o) => ({
                  name: o.toolName,
                  receipt: JSON.stringify(o.receipt ?? null).slice(0, 900),
                }))
                .slice(-15),
            })),
          ),
        }),
      },
    ]);
    const interrupt = () => {
      preempted = true;
      agent.abortRun();
    };
    this.active.set(owner, interrupt);
    const started = this.now();
    const abort = () => agent.abortRun();
    ctx.signal.addEventListener("abort", abort, { once: true });
    try {
      await agent.runAgent({ runId: `learning-${task.id}-${task.attempts}` });
      await guard();
      if (pendingWrites.size)
        throw new AppError("Learning ended with failed writes; the source remains pending", 502);
    } catch (error) {
      if (
        preempted ||
        sourcesChanged ||
        (error instanceof AppError && error.code === "LEARNING_PREEMPTED")
      )
        return { ...defer(), state: { ...task.state, learningWriteErrors: [...pendingWrites] } };
      await ctx.guard();
      const failures = Number(task.state.learningFailures ?? 0) + 1;
      const retryAt = providerFailure?.retryAt && Date.parse(providerFailure.retryAt);
      if (retryAt && Number.isFinite(retryAt))
        return {
          status: "waiting_provider",
          nextRunAt: new Date(
            Math.max(
              retryAt,
              this.now() + Math.min(1800000, 60000 * 2 ** Math.min(failures - 1, 5)),
            ),
          ).toISOString(),
          error: error instanceof Error ? error.message : String(error),
          state: {
            ...task.state,
            learningFailures: failures,
            learningChanges: changes,
            learningWriteErrors: [...pendingWrites],
          },
        };
      if (failures < 3)
        return {
          ...defer(),
          nextRunAt: new Date(this.now() + failures * 60000).toISOString(),
          error: error instanceof Error ? error.message : String(error),
          state: {
            ...task.state,
            learningFailures: failures,
            learningChanges: changes,
            learningWriteErrors: [...pendingWrites],
          },
        };
      task = await ctx.checkpoint({
        state: {
          ...task.state,
          learningFailures: failures,
          learningChanges: changes,
          learningWriteErrors: [...pendingWrites],
        },
      });
      throw error;
    } finally {
      if (this.active.get(owner) === interrupt) this.active.delete(owner);
      ctx.signal.removeEventListener("abort", abort);
      await this.service.actor.chargeElapsed(owner, task, this.now() - started);
    }
    if (!finished && !changes)
      throw new AppError("Learning review ended without a persistence or no-change receipt", 502);
    return {
      status: "succeeded",
      error: null,
      result: changes
        ? `Saved ${changes} personal learning changes`
        : "No durable learning in this review",
      state: {
        ...task.state,
        learningChanges: changes,
        learningSummary,
        learningWriteErrors: [],
        providerCheckpoint: null,
      },
      completion: { status: "verified", checks: [], remaining: [] },
    };
  }
}
