import { randomUUID } from "node:crypto";
import { bindingHash } from "../../apps/server/src/conversation-inbox.ts";
import type { JournalOperation } from "../../apps/server/src/engine/task-journal.ts";
import type { ActionProposal } from "../../packages/domain/src/index.ts";

export function reviewedRemoval(taskId: string) {
  const sessionId = randomUUID(),
    dialogId = randomUUID(),
    snapshotId = randomUUID();
  const url = "https://example.com/document";
  const before = {
    sessionId,
    snapshotId,
    url,
    title: "Own document",
    control: "agent",
    text: "Document: Quarterly notes\nDelete document\nNo changes made.",
    elements: [
      {
        number: 1,
        tag: "button",
        role: "button",
        label: "Delete document",
        disabled: false,
        frameUrl: url,
      },
    ],
    truncated: false,
    truncatedElements: false,
  };
  const dialog = {
    id: dialogId,
    type: "confirm",
    message: "Delete this document permanently?",
    defaultValue: "",
    truncated: false,
    requiresApproval: true,
  };
  const input = { dialogId, accept: true };
  const privateBinding = {
    tool: "browser.dialog",
    hash: "a".repeat(64),
    binding: { sessionId, input, url, dialog },
  };
  const result = {
    ...before,
    snapshotId: randomUUID(),
    text: "Document deleted. Deletions: 1.",
    response: { dialogId, accept: true },
  };
  const action: ActionProposal = {
    id: "approved-dialog",
    hash: privateBinding.hash,
    taskId,
    kind: "external.action",
    status: "succeeded",
    preparedRevision: 0,
    dispatchedRevision: 0,
    dispatchedAt: "2026-10-10T00:00:04Z",
    data: { tool: "browser.dialog", requiresHumanApproval: true },
    title: "Confirm browser dialog",
    createdAt: "2026-10-10T00:00:03Z",
    expiresAt: "2026-10-10T00:30:03Z",
    result: JSON.stringify(result),
  };
  const operations: JournalOperation[] = [
    ["observed-page", "browser_navigate", { url }, before, false],
    [
      "opened-delete",
      "browser_act",
      { sessionId, act: { action: "click", snapshotId, element: 1 } },
      {
        ...before,
        snapshotId: randomUUID(),
        text: "A browser dialog is pending.",
        elements: [],
        dialog,
      },
      true,
    ],
    [
      "prepared-delete",
      "browser_dialog",
      { sessionId, ...input },
      { sessionId, actionId: action.id, approvalRequired: true, dispatched: false, dialog },
      true,
    ],
  ].map(([id, toolName, args, receipt, effect], i) => ({
    id: String(id),
    toolName: String(toolName),
    args,
    receipt,
    effect: Boolean(effect),
    taskId,
    revision: 0,
    status: "succeeded",
    bindingHash: bindingHash({ name: toolName, args }),
    executorId: "vps",
    executorEpoch: 1,
    resourceFence: 0,
    resourceLeaseIds: [],
    runToken: "fixture",
    createdAt: `2026-10-10T00:00:0${i}Z`,
  }));
  return {
    action,
    privateBinding: { id: action.id, ...privateBinding },
    operations,
    before,
    result,
  };
}
