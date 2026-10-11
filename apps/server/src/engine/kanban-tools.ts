import type { ToolDefinition } from "@copilotkit/runtime/v2";
import { z } from "zod";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type { CompletionAssessment } from "../../../../packages/domain/src/runtime.ts";
import { AppError } from "../errors.ts";
import { kanbanToolSchemas } from "./hermes/kanban-tool-schemas.ts";
import { KanbanArtifacts } from "./kanban-artifacts.ts";
import {
  type Handoff,
  type KanbanCard,
  type KanbanScope,
  KanbanWorkflow,
} from "./kanban-workflow.ts";
import type { AgentService } from "./service.ts";
import { taskOperationId } from "./task-journal.ts";

/** Written by the host dispatcher, never accepted from task input or tool args. */
export type KanbanExecution = {
  id: string;
  board: string;
  cardId: string;
  profile: string;
  runId: string;
};
export type KanbanHandoffVerification = { completion: CompletionAssessment; revision: number };
export type KanbanTaskSurface = {
  tools: ToolDefinition[];
  deliver?: (handoff: Handoff) => Promise<{ completion?: CompletionAssessment }>;
};
type NativeTool = <T extends z.ZodType>(
  name: string,
  description: string,
  parameters: T,
  execute: (args: z.output<T>) => Promise<unknown>,
) => ToolDefinition;

/** Reuses the existing guarded executor, journal, owner store, file service
 * and progressive discovery. It is not a second tool executor. */
export async function kanbanTaskTools(
  service: AgentService,
  owner: string,
  task: AgentTask,
  tool: NativeTool,
  options: {
    signal?: AbortSignal;
    currentTask?: () => AgentTask;
    guard?: () => Promise<void>;
    transition?: (card: KanbanCard, verification?: KanbanHandoffVerification) => Promise<void>;
  } = {},
): Promise<KanbanTaskSurface> {
  if (typeof task.state.parentTaskId === "string") return { tools: [] };
  const execution = await service.db.get<KanbanExecution>(owner, "kanban-executions", task.id);
  const profile = await service.executionProfiles.get(owner, execution?.profile ?? "default");
  if (!service.executionProfiles.kanbanEnabled(profile, "task", Boolean(execution)))
    return { tools: [] };
  const scope: KanbanScope = execution
    ? {
        role: "worker",
        profile: execution.profile,
        taskId: execution.cardId,
        runId: execution.runId,
      }
    : { role: "orchestrator", profile: profile.id };
  const activeBoard = execution?.board ?? profile.board ?? "default";
  let verification: KanbanHandoffVerification | undefined;
  const artifacts = new KanbanArtifacts(
    owner,
    service.files,
    service.computer,
    service.web,
    async (card, handoff) => {
      // A prose claim cannot replace a native goal or exact-head CI verdict.
      if (card.goalMode || (card.completionContract && card.completionContract !== "local-only"))
        throw new AppError(
          "Goal or PR completion requires the dispatcher’s actual completion gate",
          409,
        );
      verification = undefined;
      await options.guard?.();
      const current = options.currentTask?.() ?? task;
      const revision = Number(current.state.appliedRevision ?? 0);
      const proof = await service.verification.assess(
        owner,
        task.id,
        revision,
        handoff.summary ?? handoff.result,
      );
      if (proof.status !== "verified")
        throw new AppError(
          `The actual task requirements remain incomplete: ${proof.remaining.join("; ")}`,
          409,
        );
      await options.guard?.();
      verification = { completion: proof, revision };
    },
  );
  const workflow = (board = activeBoard) =>
    new KanbanWorkflow(service.db, owner, board, {
      profileExists: (name) => service.executionProfiles.exists(owner, name),
      storeAttachment: (...args) => artifacts.store(...args),
      beforeHandoff: async (...args) => {
        const preserved = await artifacts.handoff(...args);
        const current = options.currentTask?.() ?? task;
        if (!verification || !current.leaseId)
          throw new AppError("The native handoff has no verified lease authority", 409);
        if (
          Number(current.state.desiredRevision ?? 0) !== verification.revision ||
          Number(current.state.appliedRevision ?? 0) !== verification.revision
        )
          throw new AppError("A later direction requires a new handoff verification", 409);
        // A direction can arrive after assess() returns. Both the board result
        // and its native proof must fail together if that revision or lease moved.
        return {
          ...preserved,
          mutations: [
            {
              kind: "tasks",
              id: task.id,
              mode: "merge" as const,
              expected: {
                status: "running",
                leaseId: current.leaseId,
                // durableMutation compares each expected top-level value exactly.
                // Match the full state to retain its mailbox/revision authority.
                state: current.state,
              },
              value: {
                completion: verification.completion,
                state: { ...current.state, verificationRevision: verification.revision },
              },
            },
          ],
        };
      },
    });
  if (execution) {
    if (execution.id !== task.id)
      throw new AppError("Dispatcher execution binding is invalid", 409);
    await workflow().authorizeAttachment(scope, execution.cardId);
  }
  const requestId = () => {
    const id = taskOperationId();
    if (!id) throw new AppError("A native journal operation is required for board mutations", 409);
    return `${task.id}:${id}`;
  };
  const complete = async (board: string, input: Handoff) => {
    const changed = await workflow(board).complete(scope, input, requestId());
    await options.transition?.(changed, verification);
    return {
      ok: true,
      task_id: changed.id,
      task: changed,
      attachments: await workflow(board).attachments(changed.id),
      completion: verification?.completion,
    };
  };
  const tools = kanbanToolSchemas
    .filter(
      (definition) =>
        scope.role !== "worker" || !["kanban_list", "kanban_unblock"].includes(definition.name),
    )
    .map((definition) => {
      const parameters = JSON.parse(JSON.stringify(definition.parameters));
      let description: string = definition.description;
      parameters.additionalProperties = false;
      parameters.properties.board.description =
        "Owner-scoped board slug. Defaults to the authenticated execution profile’s active board. Workers stay on their dispatcher-assigned board.";
      if (parameters.properties.task_id)
        parameters.properties.task_id.description =
          "Task ID. May be omitted only by a dispatcher-assigned worker for its own card. Other callers discover IDs with kanban_list.";
      if (parameters.properties.artifacts) {
        parameters.properties.artifacts.description =
          "Final deliverables only: an existing app file ID or an absolute native /workspace path. The host verifies the bytes and preserves workspace files in durable owner storage before ending the run. A missing file keeps the handoff incomplete. Omit intermediate drafts.";
        description = description.replace(
          "list their absolute paths",
          "list their app file IDs or absolute native /workspace paths",
        );
      }
      if (definition.name === "kanban_attach")
        description = description.replace(
          "under the task's attachments dir",
          "in the app's durable owner file store",
        );
      if (definition.name === "kanban_attachments")
        description =
          "List preserved task files with app file IDs, filenames, content types, byte sizes, SHA-256 and upload attribution. Read or download using the actual file ID. Follow the returned cursor for additional pages.";
      if (["kanban_list", "kanban_attachments"].includes(definition.name))
        parameters.properties.after = {
          type: "string",
          description: "Continuation cursor returned by the previous page.",
        };
      if (definition.name === "kanban_show") {
        parameters.properties.collection = {
          type: "string",
          enum: ["children", "comments", "runs", "attachments"],
          description: "Read another page of a collection marked incomplete by kanban_show.",
        };
        parameters.properties.after = {
          type: "string",
          description: "Collection continuation cursor.",
        };
      }
      return tool(definition.name, description, z.fromJSONSchema(parameters), async (raw) => {
        const args = raw as Record<string, unknown>;
        const board = (args.board as string | undefined) ?? activeBoard;
        if (scope.role === "worker" && board !== activeBoard)
          throw new AppError("The worker does not own another board", 409);
        const kb = workflow(board);
        const target =
          (args.task_id as string | undefined) ??
          (scope.role === "worker" ? scope.taskId : undefined);
        const requireTarget = () => {
          if (!target)
            throw new AppError(
              "Pass task_id from kanban_list; this session has no dispatcher-assigned card",
              400,
            );
          return target;
        };
        const ownedTarget = () => {
          const id = requireTarget();
          if (scope.role === "worker" && scope.taskId !== id)
            throw new AppError(
              "The worker does not own this card; use a comment for cross-task findings",
              409,
            );
          return id;
        };
        const handoff = (): Handoff => ({
          summary: args.summary as string | undefined,
          result: args.result as string | undefined,
          metadata: args.metadata as Record<string, unknown> | undefined,
          artifacts: args.artifacts as string[] | undefined,
          createdCards: args.created_cards as string[] | undefined,
        });
        let changed: KanbanCard;
        switch (definition.name) {
          case "kanban_show": {
            if (!target)
              return {
                current_task: null,
                hint: "Use kanban_list to find a task, then kanban_show with its task_id.",
              };
            const after = args.after as string | undefined;
            switch (args.collection) {
              case "children":
                return kb.children(target, after);
              case "comments":
                return kb.comments(target, after);
              case "runs":
                return kb.runHistory(target, after);
              case "attachments":
                return kb.attachments(target, after);
              default:
                return kb.show(target);
            }
          }
          case "kanban_list":
            return kb.list(scope, {
              assignee: args.assignee as string | undefined,
              status: args.status as KanbanCard["status"] | undefined,
              tenant: args.tenant as string | undefined,
              includeArchived: args.include_archived as boolean | undefined,
              limit: args.limit as number | undefined,
              after: args.after as string | undefined,
            });
          case "kanban_create": {
            const card = await kb.create(
              scope,
              {
                title: args.title as string,
                assignee: args.assignee as string,
                body: args.body as string | undefined,
                tenant: args.tenant as string | undefined,
                priority: args.priority as number | undefined,
                parents: args.parents as string[] | undefined,
                workspaceKind: args.workspace_kind as "scratch" | "dir" | "worktree" | undefined,
                workspacePath: args.workspace_path as string | undefined,
                project: args.project as string | undefined,
                triage: args.triage as boolean | undefined,
                idempotencyKey: args.idempotency_key as string | undefined,
                maxRuntimeSeconds: args.max_runtime_seconds as number | undefined,
                initialStatus: args.initial_status as "running" | "blocked" | undefined,
                skills: args.skills as string[] | undefined,
                goalMode: args.goal_mode as boolean | undefined,
                completionContract: args.completion_contract as string | undefined,
                goalMaxTurns: args.goal_max_turns as number | undefined,
                model: args.model as string | undefined,
                provider: args.provider as string | undefined,
              },
              requestId(),
            );
            return { ok: true, task_id: card.id, task: card };
          }
          case "kanban_comment":
            return kb.comment(scope, requireTarget(), args.body as string, requestId());
          case "kanban_attach":
            return kb.attach(
              scope,
              ownedTarget(),
              {
                filename: args.filename as string,
                contentBase64: args.content_base64 as string,
                contentType: args.content_type as string | undefined,
              },
              requestId(),
            );
          case "kanban_attach_url":
            return artifacts.attachUrl(
              kb,
              scope,
              ownedTarget(),
              {
                url: args.url as string,
                filename: args.filename as string | undefined,
                contentType: args.content_type as string | undefined,
              },
              requestId(),
              options.signal,
            );
          case "kanban_attachments":
            return kb.attachments(requireTarget(), args.after as string | undefined);
          case "kanban_link":
            return kb.link(scope, args.parent_id as string, args.child_id as string, requestId());
          case "kanban_unblock":
            return kb.unblock(scope, requireTarget(), requestId());
          case "kanban_heartbeat": {
            ownedTarget();
            const card = await kb.heartbeat(scope, args.note as string | undefined, requestId());
            return { ok: true, task_id: card.id, task: card };
          }
          case "kanban_complete":
            ownedTarget();
            return complete(board, handoff());
          case "kanban_request_review":
            ownedTarget();
            changed = await kb.requestReview(
              scope,
              { ...handoff(), reviewer: args.reviewer as string | undefined },
              requestId(),
            );
            break;
          case "kanban_request_changes":
            ownedTarget();
            changed = await kb.requestChanges(scope, args.reason as string, requestId());
            break;
          case "kanban_block":
            ownedTarget();
            changed = await kb.block(
              scope,
              (args.kind as
                | "dependency"
                | "needs_input"
                | "capability"
                | "transient"
                | undefined) ?? "needs_input",
              args.reason as string,
              requestId(),
            );
            break;
          case "kanban_schedule":
            ownedTarget();
            changed = await kb.schedule(scope, args.reason as string | undefined, requestId());
            break;
          default:
            throw new AppError("Unknown kanban operation", 400);
        }
        await options.transition?.(changed, verification);
        return {
          ok: true,
          task_id: changed.id,
          task: changed,
          attachments: await kb.attachments(changed.id),
        };
      });
    });
  return { tools, ...(execution && { deliver: (input: Handoff) => complete(activeBoard, input) }) };
}
