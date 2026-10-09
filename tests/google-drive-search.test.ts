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
