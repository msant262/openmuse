import { z } from "zod";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import { workspacePath } from "../computer.ts";
import { computerCommandCleanupConfirmed } from "../computer-contract.ts";
import { bindingHash } from "../conversation-inbox.ts";
import { AppError } from "../errors.ts";
import type { KanbanExecution } from "./kanban-tools.ts";
import type { KanbanCard, KanbanProject } from "./kanban-workflow.ts";
import { RuntimePause, RuntimePausedError } from "./runtime-pause.ts";
import type { AgentService } from "./service.ts";
import { TaskOutcomeUnknownError, taskOperationId } from "./task-journal.ts";
import type { TaskContext } from "./worker.ts";

export type KanbanWorkspace = {
  kind: "scratch" | "dir" | "worktree";
  requestedPath: string;
  branchName?: string;
  prepared?: { cwd: string; branchName?: string; operationId: string };
};

/** Intent is staged atomically with the native task; no physical effect occurs
 * while claiming a card. Only its admitted native worker may provision it. */
export function kanbanWorkspaceIntent(
  board: string,
  card: KanbanCard,
  project?: KanbanProject,
): KanbanWorkspace {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(board) || !/^[A-Za-z0-9_-]+$/.test(card.id))
    throw new AppError("Invalid task workspace identity", 422);
  const kind = card.workspaceKind ?? "scratch";
  const requestedPath =
    card.workspacePath ??
    (kind === "scratch"
      ? `/workspace/.okami/kanban/${board}/workspaces/${card.id}`
      : kind === "worktree" && project?.primaryPath
        ? `${project.primaryPath}/.worktrees/${card.id}`
        : undefined);
  if (!requestedPath)
    throw new AppError(
      "A directory or worktree requires an explicit workspace/repository path",
      409,
    );
  return {
    kind,
    requestedPath: workspacePath(requestedPath),
    ...(kind === "worktree" && {
      branchName: card.branchName ?? `${project?.slug ?? "wt"}/${card.id}`,
    }),
  };
}

// Run inside the existing private computer at /workspace, never in the API.
// Native file anchors enforce ownership; this script also rejects symlinks
// before Git can resolve a requested path to an unrelated checkout.
const worktreeScript = String.raw`
import json, os, pathlib, subprocess, sys
root = pathlib.Path.cwd()
data = json.loads(sys.argv[1])
def physical(virtual):
    if not isinstance(virtual, str) or not (virtual == '/workspace' or virtual.startswith('/workspace/')) or '..' in virtual.split('/') or '\x00' in virtual:
        raise ValueError('Invalid task workspace path')
    path = root / virtual.removeprefix('/workspace').lstrip('/')
    current = root
    for part in path.relative_to(root).parts:
        current = current / part
        if current.is_symlink(): raise ValueError('Task workspace cannot traverse a symlink')
    return path
def git(cwd, *args):
    value = subprocess.run(['git', '-C', str(cwd), *args], capture_output=True, text=True, check=True)
    return value.stdout.strip()
requested = physical(data['requestedPath'])
branch = data['branchName']
git(root, 'check-ref-format', '--branch', branch)
anchor = requested
while not anchor.exists() and anchor != root: anchor = anchor.parent
if not anchor.is_dir(): raise ValueError('Task workspace repository anchor is not a directory')
git(anchor, 'rev-parse', '--show-toplevel')
records = git(anchor, 'worktree', 'list', '--porcelain', '-z').split('\x00\x00')
worktrees = []
for record in records:
    fields = dict(field.split(' ', 1) for field in record.split('\x00') if ' ' in field)
    if 'worktree' in fields: worktrees.append(fields)
if not worktrees: raise ValueError('Task repository has no primary worktree')
repo = pathlib.Path(worktrees[0]['worktree'])
repo.relative_to(root)
physical('/workspace/' + str(repo.relative_to(root)))
target = repo / '.worktrees' / data['cardId'] if requested == repo else requested
existing = next((item for item in worktrees if pathlib.Path(item['worktree']) == target), None)
if existing and existing.get('branch') != 'refs/heads/' + branch:
    # An unrelated linked checkout is never silently reused for this card.
    target = repo / '.worktrees' / data['cardId']
    existing = next((item for item in worktrees if pathlib.Path(item['worktree']) == target), None)
if existing and existing.get('branch') != 'refs/heads/' + branch:
    raise ValueError('Task worktree is bound to a different branch')
physical('/workspace/' + str(target.relative_to(root)))
if not existing:
    target.parent.mkdir(parents=True, exist_ok=True)
    present = subprocess.run(['git', '-C', str(repo), 'show-ref', '--verify', '--quiet', 'refs/heads/' + branch]).returncode == 0
    if present: git(repo, 'worktree', 'add', '--', str(target), branch)
    else: git(repo, 'worktree', 'add', '-b', branch, '--', str(target))
if git(target, 'branch', '--show-current') != branch:
    raise ValueError('Actual task worktree branch does not match its host binding')
print(json.dumps({'cwd': '/workspace/' + str(target.relative_to(root)), 'branchName': branch}))
`;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const preparedSchema = z.object({
  cwd: z.string().transform((value) => workspacePath(value)),
  branchName: z.string().optional(),
});

export async function prepareKanbanWorkspace(
  service: Pick<AgentService, "db" | "config" | "computer" | "journal" | "executionProfiles">,
  owner: string,
  task: AgentTask,
  ctx: Pick<TaskContext, "guard" | "signal" | "event">,
): Promise<{ cwd: string; sessionId: string } | undefined> {
  const execution = await service.db.get<KanbanExecution>(owner, "kanban-executions", task.id);
  if (!execution) return undefined;
  const cardKind = `kanban-cards:${execution.board}`;
  const card = await service.db.get<KanbanCard>(owner, cardKind, execution.cardId);
  // A committed handoff is recovered by kanbanTaskTools using its exact native
  // proof. Do not provision or claim a new workspace on this recovery path.
  if (card && (!card.currentRun || card.currentRun.id !== execution.runId)) return undefined;
  if (!card || card.currentRun?.nativeTaskId !== task.id) {
    // Historical manual bindings keep their old execution contract. A current
    // canonical dispatch must have its exact card/run identity.
    if (!execution.workspace && !card?.currentRun?.nativeTaskId) return undefined;
    throw new AppError("The task workspace has no matching native card binding", 409);
  }
  if (
    execution.id !== task.id ||
    card.currentRun.id !== execution.runId ||
    card.currentRun.profile !== execution.profile ||
    !execution.workspace
  )
    throw new AppError("The task workspace/run binding changed", 409);
  await ctx.guard();
  const profile = await service.executionProfiles.get(owner, execution.profile);
  if (!service.executionProfiles.kanbanEnabled(profile, "task", true))
    throw new AppError("This task's execution profile disabled kanban workspace preparation", 409);
  const authority = await service.db.kanbanRunAuthority(
    owner,
    execution.board,
    card.id,
    execution.runId,
    task.id,
  );
  if (
    authority?.task?.status !== "running" ||
    authority.task.leaseId !== task.leaseId ||
    !(Date.parse(authority.task.leaseUntil ?? "") > Date.now())
  )
    throw new AppError("The task workspace requires the current native worker", 409);
  const intent = execution.workspace;
  const sessionId = `kanban:${task.id}:${execution.runId}`;
  if (intent.prepared) return { cwd: workspacePath(intent.prepared.cwd), sessionId };
  if (service.config.computerEnabled !== true)
    throw new AppError("Enable the agent computer to prepare this task workspace", 409);
  const callId = `workspace:${execution.runId}:${Number(task.state.appliedRevision ?? 0)}`;
  const raw = await service.journal.run(
    owner,
    task,
    {
      id: callId,
      name: "prepare_kanban_workspace",
      args: { ...intent, cardId: card.id },
    },
    async () => {
      await ctx.guard();
      if (intent.kind !== "worktree") {
        const result = await service.computer.mkdir(owner, intent.requestedPath);
        if (result.path !== intent.requestedPath)
          throw new AppError("The computer prepared a different task workspace", 409);
        return { cwd: result.path };
      }
      const command = await service.computer.execute(
        owner,
        {
          command: `python3 -c ${quote(worktreeScript)} ${quote(JSON.stringify({ ...intent, cardId: card.id }))}`,
          cwd: "/workspace",
          timeoutMs: 120_000,
          background: false,
        },
        { idempotencyKey: taskOperationId(), signal: ctx.signal, dispatchGuard: ctx.guard },
      );
      if (!computerCommandCleanupConfirmed(command))
        throw new TaskOutcomeUnknownError([command.id]);
      if (command.status !== "succeeded" || command.exitCode !== 0)
        throw new AppError(
          `Task worktree preparation failed: ${command.stderr.slice(0, 1000)}`,
          409,
        );
      return preparedSchema.parse(JSON.parse(command.stdout));
    },
    true,
  );
  const prepared = { ...preparedSchema.parse(raw), operationId: `tool:${task.id}:${callId}` };
  await ctx.guard();
  const result = await service.db.durableMutation(
    owner,
    `kanban-workspace:${task.id}:${execution.runId}`,
    bindingHash({ execution, prepared }),
    [
      {
        kind: "tasks",
        id: task.id,
        mode: "check",
        activeTaskLease: true,
        expected: { status: "running", leaseId: task.leaseId, state: task.state },
        value: {},
      },
      {
        kind: "execution-profiles",
        id: execution.profile,
        mode: "check",
        expected: { revision: profile.revision },
        value: {},
      },
      {
        kind: "kanban-executions",
        id: task.id,
        mode: "merge",
        expected: execution,
        value: { workspace: { ...intent, prepared } },
      },
      {
        kind: cardKind,
        id: card.id,
        mode: "merge",
        expected: { revision: card.revision, currentRun: card.currentRun },
        value: {
          workspacePath: prepared.cwd,
          ...(prepared.branchName && { branchName: prepared.branchName }),
          revision: card.revision + 1,
          updatedAt: new Date().toISOString(),
        },
      },
    ],
    [],
    true,
  );
  if (result.status === "paused")
    throw new RuntimePausedError(await new RuntimePause(service.db).get(owner));
  if (!["applied", "duplicate"].includes(result.status))
    throw new AppError("Task workspace authority changed before its binding was saved", 409);
  await ctx.event("step", "Task workspace prepared", prepared.cwd, prepared.operationId);
  return { cwd: prepared.cwd, sessionId };
}
