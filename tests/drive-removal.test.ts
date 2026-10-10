import assert from "node:assert/strict";
import { test } from "node:test";
import { driveRemovalEvidence, driveRemovalRequest } from "../apps/server/src/drive-removal.ts";
import type { JournalOperation } from "../apps/server/src/engine/task-journal.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";

const prompt = "Apague os dois arquivos “Study notes” do Drive da conta work@example.com.";
const file = (id: string) => ({
  id,
  name: "Study notes",
  account: "work@example.com",
  connectionId: "work-id",
  mimeType: "application/vnd.google-apps.document",
  match: "exact",
});
function search(
  offset: number,
  ids: string[],
  total: number,
  nextOffset: number | null,
): JournalOperation {
  return {
    id: `search-${offset}-${total}`,
    taskId: "owned-task",
    revision: 0,
    bindingHash: "a".repeat(64),
    executorId: "model",
    executorEpoch: 1,
    resourceFence: 0,
    runToken: "run",
    resourceLeaseIds: [],
    createdAt: "2026-10-10T10:00:00.000Z",
    status: "succeeded",
    effect: false,
    toolName: "search_drive",
    args: { query: "Study notes", account: "work@example.com", kind: "files", limit: 1, offset },
    receipt: {
      status: "succeeded",
      query: "Study notes",
      scope: "account_search",
      complete: true,
      accounts: [
        {
          account: "work@example.com",
          connectionId: "work-id",
          status: "succeeded",
          pages: 1,
          scanned: total,
          matched: total,
          fileCount: total,
          folderCount: 0,
          shortcutCount: 0,
          visibility: "all_accessible_files",
        },
      ],
      totalMatches: total,
      fileCount: total,
      folderCount: 0,
      shortcutCount: 0,
      returnedCount: ids.length,
      nextOffset,
      truncated: total > ids.length,
      files: ids.map(file),
      guidance: "Actual provider metadata.",
    },
  };
}
function removed(id: string): ActionProposal {
  return {
    id: `action-${id}`,
    taskId: "owned-task",
    hash: "b".repeat(64),
    kind: "external.action",
    title: "Move Study notes to trash",
    data: { tool: "google.workspace" },
    status: "succeeded",
    createdAt: "2026-10-10T10:01:00.000Z",
    expiresAt: "2026-10-10T10:31:00.000Z",
    result: JSON.stringify({
      status: "succeeded",
      account: "work@example.com",
      driveRemoval: { verified: true, id, name: "Study notes", trashed: true, deleted: false },
    }),
  };
}
const bindings = new Map(
  ["one", "two"].map((id) => [
    `action-${id}`,
    {
      serverId: "google-workspace",
      tool: "drive.files.update",
      args: { fileId: id, trashed: true },
      fingerprint: "work-id",
    },
  ]),
);

test("Drive deletion accepts a complete paged shortlist but not its first page alone", () => {
  const first = search(0, ["one"], 2, 1),
    last = search(1, ["two"], 2, null);
  const actions = [removed("one"), removed("two")];
  assert.equal(driveRemovalEvidence(prompt, [first], actions, bindings).complete, false);
  const complete = driveRemovalEvidence(prompt, [first, last], actions, bindings);
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.evidenceIds, ["action-one", "action-two"]);
});

test("later empty Drive searches cannot discard an originally selected duplicate", () => {
  const original = search(0, ["one", "two"], 2, null),
    later = search(0, [], 0, null);
  const partial = driveRemovalEvidence(prompt, [original, later], [removed("one")], bindings);
  assert.equal(partial.complete, false);
  assert.ok(partial.missing.some((requirement) => requirement.includes("two")));
});

test("a group without explicit IDs requires a complete observed selection", () => {
  const group = "Apague do Drive todos os arquivos de teste da conta work@example.com.";
  assert.equal(driveRemovalEvidence(group, [], [removed("one")], bindings).complete, false);
  assert.equal(
    driveRemovalEvidence(group, [search(0, [], 0, null)], [removed("one")], bindings).complete,
    false,
  );
  assert.equal(
    driveRemovalEvidence(group, [search(0, ["one", "two"], 2, null)], [removed("one")], bindings)
      .complete,
    false,
  );
  assert.equal(
    driveRemovalEvidence(
      group,
      [search(0, ["one", "two"], 2, null)],
      [removed("one"), removed("two")],
      bindings,
    ).complete,
    true,
  );
});

test("Drive deletion preserves all explicit resource links instead of accepting the first receipt", () => {
  const linked =
    "Apague do Drive estes arquivos: https://drive.google.com/file/d/one/view e https://docs.google.com/document/d/two/edit.";
  assert.equal(driveRemovalEvidence(linked, [], [removed("one")], bindings).complete, false);
  assert.equal(
    driveRemovalEvidence(linked, [], [removed("one"), removed("two")], bindings).complete,
    true,
  );
});

test("an event or message referencing Drive is not a Drive file deletion", () => {
  for (const instruction of [
    "Delete the event in my calendar that mentions Google Drive.",
    "Exclua o e-mail sobre o arquivo do Drive.",
    "Crie no Drive um documento contendo o texto “Apague todos os arquivos”.",
    "Não apague os arquivos do Drive; apenas procure os documentos.",
  ])
    assert.equal(driveRemovalRequest(instruction), undefined, instruction);
});
