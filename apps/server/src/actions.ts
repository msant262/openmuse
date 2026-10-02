import { createHash, randomUUID } from "node:crypto";
import {
  type ActionProposal,
  type CalendarEvent,
  type ProposalInput,
  proposalSchema,
} from "../../../packages/domain/src/index.ts";
import { ActionLog, unknownOutcome } from "./action-log.ts";
import { type ApprovalPolicy, requiresApproval } from "./action-policy.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

export interface ExternalAction {
  tool: string;
  target: string;
  summary: string;
  money: boolean;
  binding: unknown;
  display?: Record<string, string | number>;
}
type ExternalExecutor = (
  owner: string,
  binding: unknown,
  proposal: ActionProposal,
) => Promise<string>;
interface Options {
  policy?: ApprovalPolicy;
  execute: (
    owner: string,
    input: ProposalInput,
    connectionId?: string,
    targetVersion?: string,
  ) => Promise<string>;
  prepare?: (
    owner: string,
    input: ProposalInput,
    connectionId?: string,
  ) => Promise<{
    input: ProposalInput;
    target?: CalendarEvent;
    targetVersion?: string;
  }>;
  connected: (owner: string) => Promise<boolean>;
  connection?: (owner: string) => Promise<{ id: string; account: string } | null>;
  now?: () => number;
}
export class ActionService {
  private readonly now: () => number;
  private readonly log: ActionLog;
  private readonly external = new Map<string, ExternalExecutor>();
  registerExternal(tool: string, executor: ExternalExecutor) {
    this.external.set(tool, executor);
  }
  async proposeExternal(
    owner: string,
    input: ExternalAction,
    key: string,
    taskId?: string,
  ): Promise<ActionProposal> {
    if (!this.external.has(input.tool)) throw new AppError("External action is unavailable", 409);
    const id = createHash("sha256").update(`external:${key}`).digest("hex");
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const existing = await this.db.get<ActionProposal>(owner, "actions", id);
    if (existing) {
      if (existing.hash !== hash) throw new AppError("Action ID belongs to different details", 409);
      return existing;
    }
    await this.db.insertIfAbsent(owner, "external-action-bindings", {
      id,
      tool: input.tool,
      binding: input.binding,
      hash,
    });
    const proposal: ActionProposal = {
      id,
      hash,
      taskId,
      kind: "external.action",
      title: input.summary,
      data: { tool: input.tool, target: input.target, summary: input.summary, ...input.display },
      status: "awaiting_review",
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + 30 * 60 * 1000).toISOString(),
    };
    const saved = await this.db.insertIfAbsent(owner, "actions", proposal);
    if (!saved) {
      const current = await this.db.get<ActionProposal>(owner, "actions", id);
      if (!current || current.hash !== hash)
        throw new AppError("Action ID belongs to different details", 409);
      return current;
    }
    if (!requiresApproval(this.options.policy ?? "all", input.money))
      return this.decide(owner, id, hash, "approve", "policy");
    await this.record(owner, saved, "Ready for your review");
    return saved;
  }
  constructor(
    private readonly db: Store,
    private readonly options: Options,
  ) {
    this.now = options.now ?? Date.now;
    this.log = new ActionLog(db);
  }
  async propose(
    owner: string,
    raw: unknown,
    idempotencyKey?: string,
    taskId?: string,
  ): Promise<ActionProposal> {
    const parsed = proposalSchema.parse(raw);
    const requestHash = createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
    const id =
      idempotencyKey === undefined
        ? randomUUID()
        : createHash("sha256").update(idempotencyKey).digest("hex");
    if (idempotencyKey !== undefined) {
      const existing = await this.db.get<ActionProposal>(owner, "actions", id);
      if (existing) {
        if (existing.requestHash && existing.requestHash !== requestHash)
          throw new AppError(
            "Action request key belongs to different details; check the earlier action",
            409,
          );
        return existing;
      }
    }
    const connection = await this.options.connection?.(owner);
    if (this.options.connection && !connection)
      throw new AppError("Connect Google before preparing an action", 409);
    const prepared = await this.options.prepare?.(owner, parsed, connection?.id);
    const input = proposalSchema.parse(prepared?.input ?? parsed);
    const title =
      input.kind === "email.send"
        ? `Send “${input.data.subject}”`
        : input.kind === "calendar.delete"
          ? `Delete ${input.data.title}`
          : `${input.kind === "calendar.create" ? "Create" : "Update"} ${input.data.title}`;
    const createdAt = new Date(this.now()).toISOString();
    const proposal: ActionProposal = {
      id,
      requestHash,
      taskId,
      title,
      kind: input.kind,
      data: input.data,
      account: connection?.account,
      connectionId: connection?.id,
      target: prepared?.target,
      targetVersion: prepared?.targetVersion,
      status: "awaiting_review",
      hash: createHash("sha256")
        .update(
          JSON.stringify({
            input,
            connection,
            target: prepared?.target,
            targetVersion: prepared?.targetVersion,
          }),
        )
        .digest("hex"),
      createdAt,
      expiresAt: new Date(this.now() + 30 * 60 * 1000).toISOString(),
    };
    const saved =
      idempotencyKey === undefined
        ? await this.db.put(owner, "actions", proposal)
        : await this.db.insertIfAbsent(owner, "actions", proposal);
    if (!saved) {
      const existing = await this.db.get<ActionProposal>(owner, "actions", id);
      if (!existing) throw new AppError("Prepared action could not be loaded", 409);
      if (existing.requestHash && existing.requestHash !== requestHash)
        throw new AppError(
          "Action request key belongs to different details; check the earlier action",
          409,
        );
      return existing;
    }
    if (!requiresApproval(this.options.policy ?? "all", false))
      return this.decide(owner, saved.id, saved.hash, "approve", "policy");
    await this.record(owner, saved, "Ready for your review");
    return saved;
  }
  async decide(
    owner: string,
    id: string,
    hash: string,
    decision: "approve" | "deny",
    actor: "human" | "policy" = "human",
  ): Promise<ActionProposal> {
    const proposal = await this.db.get<ActionProposal>(owner, "actions", id);
    if (!proposal) throw new AppError("Action not found", 404);
    if (proposal.hash !== hash)
      throw new AppError("This proposal changed. Open its latest review before deciding.", 409);
    if (proposal.status !== "awaiting_review") return proposal;
    if (decision === "approve" && proposal.taskId) {
      const task = await this.db.get<{ status: string }>(owner, "tasks", proposal.taskId);
      if (!task || !["running", "waiting_approval"].includes(task.status))
        throw new AppError(
          "Resume the task before approving this action. Cancelled tasks cannot execute.",
          409,
        );
    }
    if (Date.parse(proposal.expiresAt) <= this.now()) {
      const expired = await this.db.compareAndSwap<ActionProposal>(
        owner,
        "actions",
        id,
        { status: "awaiting_review", hash, expiresAt: proposal.expiresAt },
        { status: "expired" },
      );
      if (!expired) {
        const current = await this.db.get<ActionProposal>(owner, "actions", id);
        if (!current) throw new AppError("Action not found", 404);
        return current;
      }
      throw new AppError("This review expired. Create a fresh proposal.", 409);
    }
    if (
      proposal.kind !== "external.action" &&
      decision === "approve" &&
      !(await this.options.connected(owner))
    )
      throw new AppError("Google is disconnected. Reconnect before approving this action.", 409);
    if (proposal.kind !== "external.action" && decision === "approve" && this.options.connection) {
      const connection = await this.options.connection(owner);
      if (
        !connection ||
        connection.id !== proposal.connectionId ||
        connection.account !== proposal.account
      )
        throw new AppError(
          "Google account or connection changed. Prepare a new action for the connected account.",
          409,
        );
    }
    const audit = {
      operationId: proposal.id,
      actor,
      tool: proposal.kind === "external.action" ? String(proposal.data.tool) : proposal.kind,
      target:
        proposal.kind === "external.action"
          ? String(proposal.data.target)
          : proposal.kind === "email.send"
            ? `Gmail · ${(Array.isArray(proposal.data.to) ? proposal.data.to.join(", ") : "recipients").slice(0, 1000)}`
            : `Calendar · ${String(proposal.data.calendarId)}${proposal.data.eventId ? ` / ${String(proposal.data.eventId)}` : ""}`,
      summary:
        proposal.kind === "external.action"
          ? String(proposal.data.summary)
          : proposal.kind === "email.send"
            ? "Send email"
            : proposal.kind.replace(".", " "),
    };
    if (decision === "approve") await this.log.append(owner, audit, "started");
    const claimed = await this.db.claim<ActionProposal>(
      owner,
      id,
      decision === "deny" ? "denied" : "executing",
      new Date(this.now()).toISOString(),
    );
    if (!claimed) {
      const current = await this.db.get<ActionProposal>(owner, "actions", id);
      if (!current) throw new AppError("Action not found", 404);
      return current;
    }
    await this.record(
      owner,
      claimed,
      decision === "deny"
        ? "Declined; no changes made"
        : actor === "policy"
          ? "Automatic execution started"
          : "Approved; execution started",
    );
    if (decision === "deny") {
      await this.log.finish(owner, audit, "denied");
      return claimed;
    }
    let finished: ActionProposal;
    try {
      if (claimed.taskId) {
        const task = await this.db.get<{ status: string }>(owner, "tasks", claimed.taskId);
        if (!task || !["running", "waiting_approval"].includes(task.status))
          throw new AppError("Task was cancelled or paused before dispatch", 409);
      }
      let result: string;
      if (claimed.kind === "external.action") {
        const bound = await this.db.get<{ tool: string; binding: unknown; hash: string }>(
          owner,
          "external-action-bindings",
          claimed.id,
        );
        const executor = bound && this.external.get(bound.tool);
        if (!bound || bound.hash !== claimed.hash || !executor)
          throw new AppError("External action binding changed or is unavailable", 409);
        result = await executor(owner, bound.binding, claimed);
      } else {
        const input = proposalSchema.parse({ kind: claimed.kind, data: claimed.data });
        result = await this.options.execute(
          owner,
          input,
          claimed.connectionId,
          claimed.targetVersion,
        );
      }
      finished = { ...claimed, status: "succeeded", result };
    } catch (error) {
      const unknown = unknownOutcome(error);
      finished = {
        ...claimed,
        status: unknown ? "outcome_unknown" : "failed",
        error: error instanceof Error ? error.message : "Execution failed",
      };
    }
    await this.db.put(owner, "actions", finished);
    await this.log.finish(
      owner,
      audit,
      finished.status === "succeeded"
        ? "succeeded"
        : finished.status === "outcome_unknown"
          ? "outcome_unknown"
          : "failed",
    );
    await this.record(owner, finished, finished.result ?? finished.error ?? finished.status);
    return finished;
  }
  private async record(owner: string, action: ActionProposal, detail: string) {
    await this.db.put(owner, "activity", {
      id: randomUUID(),
      actionId: action.id,
      title: action.title,
      detail,
      date: new Date(this.now()).toISOString(),
      status: action.status,
    });
  }
}
