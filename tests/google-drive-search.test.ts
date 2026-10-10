import assert from "node:assert/strict";
import test from "node:test";
import { googleTaskTools } from "../apps/server/src/google-agent-context.ts";
import {
  type DriveAccount,
  driveNameQuery,
  driveSearchSchema,
  observedDriveSearch,
  searchGoogleDrive,
} from "../apps/server/src/google-drive-search.ts";
import { googleWorkspaceReadTool } from "../apps/server/src/google-workspace-tools.ts";

const scopes = ["https://www.googleapis.com/auth/drive.readonly"];
const accounts: DriveAccount[] = [
  { account: "personal@example.com", connectionId: "personal", capabilities: scopes },
  { account: "work@example.com", connectionId: "work", capabilities: scopes },
];
const folder = (id: string, name: string) => ({
  id,
  name,
  mimeType: "application/vnd.google-apps.folder",
  webViewLink: `https://drive.google.com/drive/folders/${id}`,
});

test("a dated file name does not broaden into thousands of numeric content matches", async () => {
  const calls: Record<string, unknown>[] = [];
  const docs = ["one", "two"].map((id) => ({
    id,
    name: "Okami teste Workspace 10 outubro",
    mimeType: "application/vnd.google-apps.document",
  }));
  const result = await searchGoogleDrive(
    driveSearchSchema.parse({ query: docs[0].name, account: "work", kind: "files", limit: 100 }),
    accounts,
    async (_account, parameters) => {
      calls.push(parameters);
      const broad = /name contains '10'|or fullText contains '10'/.test(String(parameters.q));
      return {
        files: broad
          ? [...docs, { id: "unrelated", name: "invoice 10.pdf", mimeType: "application/pdf" }]
          : docs,
      };
    },
  );
  assert.equal(result.totalMatches, 2);
  assert.equal(result.nextOffset, null);
  assert.deepEqual(
    result.files.map((f) => f.id),
    ["one", "two"],
  );
  assert.doesNotMatch(String(calls[0].q), /name contains '10'|or fullText contains '10'/);
});

test("unrelated content hits do not inflate name shortlist counts or pages", async () => {
  const result = await searchGoogleDrive(
    driveSearchSchema.parse({
      query: "Okami teste Workspace 10 outubro",
      account: "work",
      kind: "files",
      limit: 1,
    }),
    accounts,
    async (_account, parameters) =>
      parameters.pageToken
        ? {
            files: [
              {
                id: "two",
                name: "Okami teste Workspace 10 outubro",
                mimeType: "application/vnd.google-apps.document",
              },
            ],
          }
        : {
            files: [
              {
                id: "one",
                name: "Okami teste Workspace 10 outubro",
                mimeType: "application/vnd.google-apps.document",
              },
              { id: "unrelated", name: "invoice 10.pdf", mimeType: "application/pdf" },
            ],
            nextPageToken: "next",
          },
  );
  assert.equal(result.totalMatches, 2);
  assert.equal(result.accounts[0].scanned, 3);
  assert.equal(result.accounts[0].matched, 2);
  assert.equal(result.nextOffset, 1);
  assert.equal(result.accounts[0].pages, 2);
});

test("a punctuation-only file name still produces a valid provider query", async () => {
  const result = await searchGoogleDrive(
    driveSearchSchema.parse({ query: "---", account: "work", kind: "files" }),
    accounts,
    async (_account, parameters) => {
      assert.doesNotMatch(String(parameters.q), /\(\)/);
      return { files: [{ id: "punctuation", name: "---", mimeType: "text/plain" }] };
    },
  );
  assert.equal(result.complete, true);
  assert.equal(result.files[0]?.id, "punctuation");
});

test("a paginated folder listing distinguishes files, folders and shortcuts before limiting presentation", async () => {
  const result = await searchGoogleDrive(
    driveSearchSchema.parse({ parentId: "moving", account: "work", limit: 1 }),
    accounts,
    async (_account, parameters) =>
      parameters.pageToken
        ? {
            files: [
              { id: "pdf", name: "permit.pdf", mimeType: "application/pdf" },
              {
                id: "link",
                name: "documents link",
                mimeType: "application/vnd.google-apps.shortcut",
                shortcutDetails: {
                  targetId: "docs",
                  targetMimeType: "application/vnd.google-apps.folder",
                },
              },
            ],
          }
        : { files: [folder("docs", "Documents")], nextPageToken: "next" },
  );
  assert.equal(result.totalMatches, 3);
  assert.equal(result.fileCount, 1);
  assert.equal(result.folderCount, 2);
  assert.equal(result.shortcutCount, 1);
  assert.equal(result.files.length, 1);
});

test("an empty name search recovers a misspelled folder from all accounts without treating unrelated folders as matches", async () => {
  const calls: string[] = [];
  const result = await searchGoogleDrive(
    driveSearchSchema.parse({ query: "MOVIGN DE", kind: "folders", limit: 1 }),
    accounts,
    async (account, parameters) => {
      const direct = String(parameters.q).includes("name contains");
      calls.push(`${account.connectionId}:${direct ? "name" : "folder"}`);
      if (direct) return { files: [] };
      if (account.connectionId === "personal") return { files: [folder("unrelated", "Vacation")] };
      if (!parameters.pageToken)
        return { files: [folder("unrelated2", "Taxes")], nextPageToken: "last" };
      return { files: [folder("correct", "MovingDE")] };
    },
  );
  assert.ok(calls.includes("work:folder"));
  assert.equal(result.complete, true);
  assert.equal(result.files[0]?.id, "correct");
  assert.equal(result.files[0].match, "approximate");
  assert.equal(result.totalMatches, 1);
  assert.match(result.guidance, /candidate/i);
});

test("MOVING DE finds MovingDE in the second account after an empty default account", async () => {
  const calls: string[] = [];
  const result = await searchGoogleDrive(
    driveSearchSchema.parse({ query: "MOVING DE", kind: "folders" }),
    accounts,
    async (account, parameters) => {
      calls.push(account.connectionId);
      assert.match(String(parameters.q), /name contains 'MOVING'/);
      assert.match(String(parameters.q), /name contains 'MOVINGDE'/);
      assert.equal(parameters.includeItemsFromAllDrives, true);
      assert.equal(parameters.supportsAllDrives, true);
      assert.match(String(parameters.fields), /incompleteSearch/);
      return {
        files:
          account.connectionId === "work"
            ? [folder("moving", "Moving"), folder("moving-de", "MovingDE")]
            : [],
        incompleteSearch: false,
      };
    },
  );
  assert.deepEqual(calls, ["personal", "work"]);
  assert.equal(result.complete, true);
  assert.equal(result.files[0].id, "moving-de");
  assert.equal(result.files[0].account, "work@example.com");
  assert.equal(result.files[0].match, "name_variant");
  assert.equal(observedDriveSearch(result), true);
});

test("result limit does not omit later pages or a better match in another account", async () => {
  const calls: string[] = [];
  const result = await searchGoogleDrive(
    driveSearchSchema.parse({ query: "MOVING DE", limit: 1 }),
    accounts,
    async (account, parameters) => {
      calls.push(`${account.connectionId}:${parameters.pageToken ?? "first"}`);
      if (account.connectionId === "personal") return { files: [folder("old", "Moving old")] };
      if (!parameters.pageToken) return { files: [], nextPageToken: "next" };
      return { files: [folder("correct", "MovingDE")] };
    },
  );
  assert.deepEqual(calls, ["personal:first", "work:first", "work:next"]);
  assert.equal(result.files[0].id, "correct");
  assert.equal(result.accounts[1].pages, 2);
  assert.equal(result.totalMatches, 2);
  assert.equal(result.returnedCount, 1);
  assert.equal(result.truncated, true);
});

test("a named account scopes folder listing and preserves shortcut target metadata", async () => {
  const result = await searchGoogleDrive(
    driveSearchSchema.parse({
      parentId: "actual-folder",
      account: "WORK@example.com",
      kind: "folders",
    }),
    accounts,
    async (account, parameters) => {
      assert.equal(account.connectionId, "work");
      assert.match(String(parameters.q), /'actual-folder' in parents/);
      return {
        files: [
          {
            id: "shortcut",
            name: "Docs",
            mimeType: "application/vnd.google-apps.shortcut",
            shortcutDetails: {
              targetId: "target",
              targetMimeType: "application/vnd.google-apps.folder",
              targetResourceKey: "resource-key",
            },
          },
        ],
      };
    },
  );
  assert.equal(result.accounts.length, 1);
  assert.equal(result.files[0].shortcutDetails?.targetId, "target");
});

test("provider incompleteness, OAuth app-only access and account errors never prove absence", async () => {
  for (const mode of ["provider", "scope", "failure", "cycle"]) {
    const selected = [
      {
        ...accounts[0],
        capabilities: mode === "scope" ? ["https://www.googleapis.com/auth/drive.file"] : scopes,
      },
    ];
    let calls = 0;
    const result = await searchGoogleDrive(
      driveSearchSchema.parse({ query: "MOVING DE" }),
      selected,
      async () => {
        calls++;
        if (mode === "failure")
          throw Object.assign(new Error("Google API unavailable"), { code: "GOOGLE_API_DISABLED" });
        return {
          files: [],
          ...(mode === "provider" ? { incompleteSearch: true } : {}),
          ...(mode === "cycle" ? { nextPageToken: "repeated" } : {}),
        };
      },
    );
    assert.equal(result.complete, false, mode);
    assert.equal(result.status, "partial", mode);
    assert.equal(observedDriveSearch(result), false, mode);
    if (mode === "cycle") assert.equal(calls, 2);
    if (mode === "failure") assert.equal(result.accounts[0].errorCode, "GOOGLE_API_DISABLED");
  }
});

test("an account failure retains a real result from the other account with explicit partial coverage", async () => {
  const result = await searchGoogleDrive(
    driveSearchSchema.parse({ query: "MOVING DE" }),
    accounts,
    async (account) => {
      if (account.connectionId === "personal") throw new Error("Read timeout");
      return { files: [folder("actual", "MovingDE")] };
    },
  );
  assert.equal(result.files[0].id, "actual");
  assert.equal(result.complete, false);
  assert.equal(result.accounts[0].status, "failed");
  assert.equal(result.accounts[1].status, "succeeded");
});

test("aborting pagination stops the search before accessing another account", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    searchGoogleDrive(
      driveSearchSchema.parse({ query: "MOVING DE" }),
      accounts,
      async () => {
        calls++;
        controller.abort(new Error("Search cancelled"));
        return { files: [], nextPageToken: "next" };
      },
      controller.signal,
    ),
    /Search cancelled/,
  );
  assert.equal(calls, 1);
});

test("Drive query treats apostrophes/backslashes as name data and the tool is a native read", () => {
  const q = driveNameQuery(
    driveSearchSchema.parse({ query: "O'Brien \\ Docs", parentId: "folder'quoted" }),
  );
  assert.ok(q.includes("name contains 'O\\'Brien \\\\ Docs'"));
  assert.ok(q.includes("'folder\\'quoted' in parents"));
  assert.ok(
    googleTaskTools("Veja os documentos na pasta MOVING DE do Google Drive").includes(
      "search_drive",
    ),
  );
  assert.equal(googleWorkspaceReadTool("search_drive", { query: "MOVING DE" }), true);
  assert.equal(driveSearchSchema.safeParse({}).success, false);
});

test("file searches exclude folders while folder searches keep navigable shortcuts", () => {
  const files = driveNameQuery(driveSearchSchema.parse({ query: "Moving", kind: "files" }));
  const folders = driveNameQuery(driveSearchSchema.parse({ query: "Moving", kind: "folders" }));
  assert.match(files, /mimeType != 'application\/vnd.google-apps.folder'/);
  assert.match(folders, /mimeType = 'application\/vnd.google-apps.shortcut'/);
});

test("recursive file lookup follows every child page and folder shortcut even when names and presentation limits exclude directories", async () => {
  const calls: string[] = [];
  const result = await searchGoogleDrive(
    driveSearchSchema.parse({
      parentId: "root",
      account: "work",
      query: "permit",
      kind: "files",
      recursive: true,
      limit: 1,
    }),
    accounts,
    async (account, parameters) => {
      assert.equal(account.connectionId, "work");
      const q = String(parameters.q);
      assert.ok(!q.includes("name contains"), "Names must not prune unrelated directory names");
      assert.ok(!q.includes("mimeType !="), "File-only results must still traverse folders");
      const parent = q.match(/'([^']+)' in parents/)![1];
      calls.push(`${parent}:${parameters.pageToken ?? "first"}`);
      if (parent === "root" && !parameters.pageToken)
        return {
          files: [
            folder("docs", "Documents"),
            { id: "root-file", name: "permit old.pdf", mimeType: "application/pdf" },
          ],
          nextPageToken: "root-next",
        };
      if (parent === "root")
        return {
          files: [
            {
              id: "link",
              name: "More records",
              mimeType: "application/vnd.google-apps.shortcut",
              shortcutDetails: {
                targetId: "docs",
                targetMimeType: "application/vnd.google-apps.folder",
              },
            },
          ],
        };
      if (parent === "docs" && !parameters.pageToken)
        return {
          files: [folder("nested", "Residence"), folder("root", "Cycle")],
          nextPageToken: "root-next",
        };
      if (parent === "docs")
        return { files: [{ id: "other", name: "invoice.pdf", mimeType: "application/pdf" }] };
      return { files: [{ id: "latest", name: "permit.pdf", mimeType: "application/pdf" }] };
    },
  );
  assert.deepEqual(calls, [
    "root:first",
    "root:root-next",
    "docs:first",
    "docs:root-next",
    "nested:first",
  ]);
  assert.equal(result.complete, true);
  assert.equal(result.fileCount, 2);
  assert.equal(result.totalMatches, 2);
  assert.equal(result.files[0].id, "latest");
  assert.equal(result.truncated, true);
  assert.equal(result.scope, "folder_tree");
  assert.equal(result.accounts[0].foldersScanned, 3);
  assert.equal(result.accounts[0].foldersScannedIncludesRoot, true);
  assert.equal(result.accounts[0].descendantFolderTargetsScanned, 2);
});

test("a failed descendant listing preserves partial matches and cannot prove folder-tree absence", async () => {
  const result = await searchGoogleDrive(
    driveSearchSchema.parse({ parentId: "root", account: "work", kind: "files", recursive: true }),
    accounts,
    async (_account, parameters) => {
      if (String(parameters.q).includes("'root' in parents"))
        return {
          files: [
            folder("denied", "Private records"),
            { id: "file", name: "permit.pdf", mimeType: "application/pdf" },
          ],
        };
      throw Object.assign(new Error("Folder access denied"), { code: "GOOGLE_FORBIDDEN" });
    },
  );
  assert.equal(result.complete, false);
  assert.equal(result.fileCount, 1);
  assert.equal(result.accounts[0].errorCode, "GOOGLE_FORBIDDEN");
  assert.equal(observedDriveSearch(result), false);
  assert.equal(driveSearchSchema.safeParse({ query: "permit", recursive: true }).success, false);
  const direct = await searchGoogleDrive(
    driveSearchSchema.parse({ parentId: "root", account: "work" }),
    accounts,
    async () => ({ files: [] }),
  );
  assert.equal(direct.scope, "direct_children");
});

test("a Drive shortlist can be paged without native API discovery or losing later provider-page matches", async () => {
  const read = async (_account: DriveAccount, parameters: Record<string, unknown>) =>
    parameters.pageToken
      ? {
          files: [
            { id: "b", name: "B.pdf", mimeType: "application/pdf" },
            { id: "c", name: "C.pdf", mimeType: "application/pdf" },
          ],
        }
      : { files: [{ id: "a", name: "A.pdf", mimeType: "application/pdf" }], nextPageToken: "next" };
  const first = await searchGoogleDrive(
    driveSearchSchema.parse({ parentId: "root", account: "work", limit: 1 }),
    accounts,
    read,
  );
  assert.equal(first.nextOffset, 1);
  const second = await searchGoogleDrive(
    driveSearchSchema.parse({
      parentId: "root",
      account: "work",
      limit: 1,
      offset: first.nextOffset,
    }),
    accounts,
    read,
  );
  assert.equal(second.files[0].id, "b");
  assert.equal(second.totalMatches, 3);
  assert.equal(second.nextOffset, 2);
  const last = await searchGoogleDrive(
    driveSearchSchema.parse({
      parentId: "root",
      account: "work",
      limit: 1,
      offset: second.nextOffset,
    }),
    accounts,
    read,
  );
  assert.equal(last.files[0].id, "c");
  assert.equal(last.nextOffset, null);
});
