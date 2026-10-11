import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Auth } from "../apps/server/src/auth.ts";
import { createStore } from "../apps/server/src/db.ts";
import { KanbanArtifacts } from "../apps/server/src/engine/kanban-artifacts.ts";
import { KanbanWorkflow } from "../apps/server/src/engine/kanban-workflow.ts";
import { Files } from "../apps/server/src/files.ts";
import { PublicWeb } from "../apps/server/src/public-web.ts";
import { config as base } from "./helpers/computer.ts";

const coordinator = { role: "orchestrator" as const, profile: "coordinator" };

test("a native deliverable is copied before review and remains readable after scratch deletion and database restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kanban-native-file-"));
  const config = { ...base, dataDir: dir };
  const database = join(dir, "database");
  let db = await createStore({ dataDir: database });
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const files = new Files(db, config, new Auth(db, config, "test-key"));
  const bytes = Buffer.from([0, 255, 128, 3, 4, 0, 245, 71]);
  const scratch = join(dir, "scratch.zip");
  await writeFile(scratch, bytes);
  let verified = 0;
  const transport = new KanbanArtifacts(
    "owner",
    files,
    {
      fileBytes: async (owner, path) => {
        assert.equal(owner, "owner");
        assert.equal(path, "/workspace/scratch/report.zip");
        return { name: "report.zip", bytes: await readFile(scratch) };
      },
    },
    new PublicWeb(),
    async (_card, handoff) => {
      assert.equal(handoff.artifacts?.length, 1);
      assert.ok(handoff.artifacts?.[0]);
      assert.deepEqual(await files.bytes("owner", handoff.artifacts[0]), bytes);
      verified++;
    },
  );
  let board = new KanbanWorkflow(db, "owner", "deliveries", {
    profileExists: () => true,
    beforeHandoff: transport.handoff.bind(transport),
    storeAttachment: transport.store.bind(transport),
  });
  const card = await board.create(
    coordinator,
    { title: "Actual report", assignee: "writer" },
    "create",
  );
  const worker = await board.claim(card.id, "writer", "claim");
  const input = {
    summary: "Report ready",
    reviewer: "reviewer",
    artifacts: ["/workspace/scratch/report.zip"],
  };
  const review = await board.requestReview(worker, input, "review");
  await rm(scratch);
  assert.deepEqual(await board.requestReview(worker, input, "review"), review);
  assert.equal(verified, 1);
  await db.close();
  db = await createStore({ dataDir: database });
  board = new KanbanWorkflow(db, "owner", "deliveries", { profileExists: () => true });
  const restoredFiles = new Files(db, config, new Auth(db, config, "test-key"));
  const [attachment] = (await board.attachments(card.id)).values;
  assert.ok(attachment);
  assert.equal((await board.get(card.id)).status, "review");
  assert.deepEqual((await board.get(card.id)).handoff?.artifacts, [attachment.fileId]);
  assert.equal(attachment.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(await restoredFiles.bytes("owner", attachment.fileId), bytes);
  await assert.rejects(restoredFiles.bytes("stranger", attachment.fileId), /not found/i);
});

test("a missing native artifact leaves the run live; the same request can succeed after the file is produced", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kanban-missing-file-"));
  const db = await createStore();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const config = { ...base, dataDir: dir };
  const files = new Files(db, config, new Auth(db, config, "test-key"));
  const scratch = join(dir, "result.txt");
  let verified = 0;
  const transport = new KanbanArtifacts(
    "owner",
    files,
    {
      fileBytes: async () => ({ name: "result.txt", bytes: await readFile(scratch) }),
    },
    new PublicWeb(),
    async () => {
      verified++;
    },
  );
  const board = new KanbanWorkflow(db, "owner", "deliveries", {
    profileExists: () => true,
    beforeHandoff: transport.handoff.bind(transport),
  });
  const card = await board.create(coordinator, { title: "Deliver", assignee: "writer" }, "create");
  const worker = await board.claim(card.id, "writer", "claim");
  const input = { summary: "Ready", artifacts: ["/workspace/result.txt"] };
  await assert.rejects(board.complete(worker, input, "finish"), /ENOENT/);
  assert.equal((await board.get(card.id)).status, "running");
  assert.equal((await board.attachments(card.id)).values.length, 0);
  assert.equal(verified, 0);
  await writeFile(scratch, "Actual result");
  assert.equal((await board.complete(worker, input, "finish")).status, "done");
  assert.equal(verified, 1);
});

test("URL attachment replay returns the committed file after the worker run ends without another download", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kanban-url-file-"));
  const db = await createStore();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const config = { ...base, dataDir: dir };
  const files = new Files(db, config, new Auth(db, config, "test-key"));
  const bytes = Buffer.from([255, 254, 0, 128, 71]);
  let downloads = 0;
  const web = new PublicWeb({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    requestBinary: async () => {
      downloads++;
      return { status: 200, headers: { "content-type": "application/zip" }, bytes };
    },
  });
  const transport = new KanbanArtifacts(
    "owner",
    files,
    {
      fileBytes: async () => {
        throw new Error("not a native file");
      },
    },
    web,
    async () => {},
  );
  const board = new KanbanWorkflow(db, "owner", "deliveries", {
    profileExists: () => true,
    storeAttachment: transport.store.bind(transport),
  });
  const card = await board.create(coordinator, { title: "Attach", assignee: "writer" }, "create");
  const worker = await board.claim(card.id, "writer", "claim");
  const input = { url: "https://files.example/report.zip" };
  const attachment = await transport.attachUrl(board, worker, card.id, input, "download");
  assert.deepEqual(await files.bytes("owner", attachment.fileId), bytes);
  await board.complete(worker, { summary: "Done" }, "finish");
  assert.deepEqual(
    await transport.attachUrl(board, worker, card.id, input, "download"),
    attachment,
  );
  assert.equal(downloads, 1, "a lost confirmation must not download different bytes");
  await assert.rejects(
    transport.attachUrl(
      board,
      worker,
      card.id,
      { url: "https://files.example/other.zip" },
      "download",
    ),
    /another board action/i,
  );
  assert.equal(downloads, 1);
});

test("a worker whose lease expires during copying cannot end the run or commit attachment metadata", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kanban-expired-copy-"));
  const db = await createStore();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const config = { ...base, dataDir: dir };
  const files = new Files(db, config, new Auth(db, config, "test-key"));
  let now = 1000;
  const transport = new KanbanArtifacts(
    "owner",
    files,
    {
      fileBytes: async () => {
        now += 101;
        return { name: "actual.txt", bytes: Buffer.from("Actual bytes") };
      },
    },
    new PublicWeb(),
    async () => {},
  );
  const board = new KanbanWorkflow(db, "owner", "deliveries", {
    now: () => now,
    leaseMs: 100,
    profileExists: () => true,
    beforeHandoff: transport.handoff.bind(transport),
  });
  const card = await board.create(coordinator, { title: "Deliver", assignee: "writer" }, "create");
  const worker = await board.claim(card.id, "writer", "claim");
  await assert.rejects(
    board.complete(worker, { summary: "Done", artifacts: ["/workspace/actual.txt"] }, "finish"),
    /run ownership/i,
  );
  assert.equal((await board.get(card.id)).status, "running");
  assert.equal((await board.get(card.id)).handoff, null);
  assert.equal((await board.attachments(card.id)).values.length, 0);
});
