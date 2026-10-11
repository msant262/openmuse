import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { KanbanWorkflow } from "../apps/server/src/engine/kanban-workflow.ts";

const coordinator = { role: "orchestrator" as const, profile: "coordinator" };

test("actual attachment preservation precedes the review handoff, is atomic with its metadata and survives ACK loss", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  let copies = 0;
  const board = new KanbanWorkflow(db, "owner", "report", {
    profileExists: () => true,
    beforeHandoff: async (card, handoff) => {
      if (!handoff.artifacts?.length) return;
      copies++;
      return {
        handoff: { ...handoff, artifacts: ["durable-file"] },
        attachments: [
          {
            id: "actual-file-copy",
            taskId: card.id,
            fileId: "durable-file",
            filename: "report.txt",
            contentType: "text/plain",
            size: 12,
            sha256: "a".repeat(64),
            uploadedBy: card.currentRun!.profile,
            createdAt: "2026-10-11T00:00:00.000Z",
          },
        ],
      };
    },
  });
  const card = await board.create(coordinator, { title: "Deliver", assignee: "writer" }, "create");
  const run = await board.claim(card.id, "writer", "claim");
  const input = {
    summary: "Actual report ready",
    reviewer: "reviewer",
    artifacts: ["/workspace/scratch/report.txt"],
  };
  const result = await board.requestReview(run, input, "review");
  assert.deepEqual(result.handoff?.artifacts, ["durable-file"]);
  assert.equal((await board.attachments(card.id)).values[0].fileId, "durable-file");
  assert.deepEqual(await board.requestReview(run, input, "review"), result);
  assert.equal(copies, 1, "lost ACK cannot copy or attach a file twice");
  const reviewer = await board.claim(card.id, "reviewer", "reviewer");
  await board.complete(reviewer, { summary: "Checked actual output" }, "done");
  assert.equal((await board.attachments(card.id)).values[0].fileId, "durable-file");
  assert.equal((await board.show(card.id)).attachments.values[0].sha256, "a".repeat(64));
});

test("inline attachment input is validated before copying; stale and foreign workers cannot attach", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  let now = 1000,
    copies = 0;
  const board = new KanbanWorkflow(db, "owner", "report", {
    now: () => now,
    leaseMs: 100,
    profileExists: () => true,
    storeAttachment: async (card, scope, input, requestId) => {
      copies++;
      assert.equal(Buffer.from(input.bytes).toString(), "Real bytes");
      return {
        id: requestId,
        taskId: card.id,
        fileId: "actual-file",
        filename: "report.txt",
        contentType: "text/plain",
        size: input.bytes.length,
        sha256: "b".repeat(64),
        uploadedBy: scope.profile,
        createdAt: new Date(now).toISOString(),
      };
    },
  });
  const card = await board.create(coordinator, { title: "Attach", assignee: "worker" }, "create");
  const old = await board.claim(card.id, "worker", "first");
  const input = {
    filename: "../report.txt",
    contentBase64: Buffer.from("Real bytes").toString("base64"),
    contentType: "text/plain",
  };
  await assert.rejects(
    board.attach(old, card.id, { ...input, contentBase64: "invalid!" }, "invalid"),
    /base64/i,
  );
  assert.equal(copies, 0);
  now += 101;
  const current = await board.claim(card.id, "worker", "current");
  await assert.rejects(board.attach(old, card.id, input, "stale"), /run ownership/i);
  const sibling = await board.create(
    coordinator,
    { title: "Sibling", assignee: "worker" },
    "sibling",
  );
  await assert.rejects(board.attach(current, sibling.id, input, "foreign"), /run ownership/i);
  assert.equal(copies, 0);
  const result = await board.attach(current, card.id, input, "attach");
  assert.equal(result.fileId, "actual-file");
  assert.deepEqual(await board.attach(current, card.id, input, "attach"), result);
  assert.equal(copies, 1);
  const recordedEvents = await db.list("owner", `kanban-events:report:${card.id}`);
  assert.ok(
    !JSON.stringify(recordedEvents).includes(input.contentBase64),
    "binary attachment payloads must not be duplicated in event history",
  );
  const stranger = new KanbanWorkflow(db, "other-owner", "report", { profileExists: () => true });
  await assert.rejects(stranger.attachments(card.id), /not found/i);
});

test("a reclaimed run cannot alter another queued card's dependencies", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  let now = 1000;
  const board = new KanbanWorkflow(db, "owner", "report", {
    now: () => now,
    leaseMs: 100,
    profileExists: () => true,
  });
  const card = await board.create(coordinator, { title: "Work", assignee: "worker" }, "create");
  const old = await board.claim(card.id, "worker", "first");
  now += 101;
  await board.claim(card.id, "worker", "current");
  const a = await board.create(coordinator, { title: "A", assignee: "worker" }, "a");
  const b = await board.create(coordinator, { title: "B", assignee: "worker" }, "b");
  const before = await board.get(b.id);
  await assert.rejects(board.link(old, a.id, b.id, "stale-link"), /run ownership/i);
  assert.deepEqual(await board.get(b.id), before);
});
