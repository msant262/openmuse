import pMap from "p-map";
import { GoogleApiError } from "../../../packages/integrations/src/google.ts";
import { decodeMimeHeader } from "../../../packages/integrations/src/google-parser.ts";
import type { GoogleWorkspaceCatalog } from "../../../packages/integrations/src/google-workspace-catalog.ts";
import type { WorkspaceService } from "./workspace.ts";

export interface MailSnapshot {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  labelIds: string[];
}
export interface MailChange {
  verified: true;
  processed: number;
  changed: number;
  archived: number;
  trashed: number;
  deleted: number;
  labelNames: string[];
  addLabelIds: string[];
  removeLabelIds: string[];
  messages: (MailSnapshot & { beforeLabelIds: string[]; url: string; deleted?: boolean })[];
}
export function gmailMessageMutation(toolId: string) {
  return /^gmail\.users\.(?:messages\.(?:modify|batchModify|trash|untrash|delete|batchDelete)|threads\.(?:modify|trash|untrash|delete))$/.test(
    toolId,
  );
}

/** Read only metadata; each independent request has its own retry deadline. */
export async function mailSnapshot(
  workspace: WorkspaceService,
  catalog: GoogleWorkspaceCatalog,
  owner: string,
  connectionId: string,
  ids: string[],
  signal?: AbortSignal,
  allowDeleted = false,
) {
  return pMap(
    ids,
    async (id) => {
      try {
        const message = (await workspace.google(owner, connectionId, signal).workspaceRequest(
          catalog.prepare({
            toolId: "gmail.users.messages.get",
            parameters: { id, format: "metadata", metadataHeaders: ["Subject", "From"] },
          }),
        )) as {
          id: string;
          threadId: string;
          labelIds?: string[];
          payload?: { headers?: { name: string; value: string }[] };
        };
        if (
          message.id !== id ||
          (message.labelIds !== undefined && !Array.isArray(message.labelIds))
        )
          throw new Error("Gmail did not return the selected message metadata");
        const header = (name: string) =>
          decodeMimeHeader(
            message.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "",
          );
        return {
          id,
          threadId: message.threadId,
          subject: header("subject"),
          from: header("from"),
          labelIds: message.labelIds ?? [],
        };
      } catch (error) {
        if (allowDeleted && error instanceof GoogleApiError && error.status === 404)
          return undefined;
        throw error;
      }
    },
    { concurrency: 8, signal },
  );
}

export async function verifyMailChange(
  workspace: WorkspaceService,
  catalog: GoogleWorkspaceCatalog,
  owner: string,
  connectionId: string,
  account: string,
  input: { toolId: string; body?: unknown },
  before: MailSnapshot[],
  labelNames: string[],
): Promise<MailChange> {
  const body = input.body as { addLabelIds?: string[]; removeLabelIds?: string[] } | undefined;
  const remove =
    body?.removeLabelIds ??
    (/\.trash$/.test(input.toolId) ? ["INBOX"] : /\.untrash$/.test(input.toolId) ? ["TRASH"] : []);
  const add = body?.addLabelIds ?? (/\.trash$/.test(input.toolId) ? ["TRASH"] : []);
  const deleted = /\.(?:delete|batchDelete)$/.test(input.toolId);
  const after = await mailSnapshot(
    workspace,
    catalog,
    owner,
    connectionId,
    before.map((m) => m.id),
    undefined,
    deleted,
  );
  const missing = before.filter((_, i) =>
    deleted
      ? after[i] !== undefined
      : !after[i] ||
        add.some((id) => !after[i]!.labelIds.includes(id)) ||
        remove.some((id) => after[i]!.labelIds.includes(id)),
  );
  if (missing.length)
    throw Object.assign(
      new Error(
        `Gmail did not confirm the requested changes for ${missing.length} of ${before.length} messages. Read their current labels before continuing; do not repeat this write.`,
      ),
      { outcomeUnknown: true },
    );
  return {
    verified: true,
    processed: before.length,
    changed: before.filter(
      (m, i) =>
        !after[i] || [...m.labelIds].sort().join() !== [...after[i]!.labelIds].sort().join(),
    ).length,
    archived: before.filter(
      (m, i) => !deleted && m.labelIds.includes("INBOX") && !after[i]!.labelIds.includes("INBOX"),
    ).length,
    trashed: before.filter(
      (m, i) => !deleted && !m.labelIds.includes("TRASH") && after[i]!.labelIds.includes("TRASH"),
    ).length,
    deleted: deleted ? before.length : 0,
    labelNames,
    addLabelIds: add,
    removeLabelIds: remove,
    messages: before.map((m, i) => ({
      ...(after[i] ?? m),
      beforeLabelIds: m.labelIds,
      ...(deleted ? { deleted: true } : {}),
      url: `https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}#all/${m.id}`,
    })),
  };
}
