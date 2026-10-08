import assert from "node:assert/strict";
import test from "node:test";
import { ConversationInbox } from "../apps/server/src/conversation-inbox.ts";
import { createStore } from "../apps/server/src/db.ts";
import { TaskJournal } from "../apps/server/src/engine/task-journal.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";

type QueryDatabase = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: { data: Record<string, unknown> }[] }>;
};

test("a blocked worker heartbeat does not accumulate another write for every timer tick", async (t) => {
  const db = await createStore();
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const put = db.put.bind(db);
  let writes = 0;
  t.mock.method(db, "put", async (...args: Parameters<typeof put>) => {
    if (args[1] === "worker-status") {
      writes++;
      entered();
      await barrier;
    }
    return put(...args);
  });
  const worker = new TaskWorker(db, async () => {});
  t.after(async () => {
    release();
    await worker.stop();
    await db.close();
  });
  worker.start();
  await blocked;
  const overlapping = Array.from({ length: 200 }, () => worker.tick());
  assert.equal(writes, 1, "backpressure must be applied before persistence begins");
  release();
  await Promise.all(overlapping);
});

test("a task journal reads only that task's receipts, independent of tenant history", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const underlying = (db as unknown as { db: QueryDatabase }).db;
  await underlying.query(`INSERT INTO records(owner,kind,id,data)
    SELECT 'owner','task-operations','history-' || n,jsonb_build_object('id','history-' || n,'taskId','old-' || n,
      'createdAt','2026-10-01T00:00:00Z','receipt',repeat('previous research ',2000)) FROM generate_series(1,1000) n`);
  for (const [owner, id, taskId] of [
    ["owner", "current-2", "current"],
    ["owner", "current-1", "current"],
    ["other", "other", "current"],
  ])
    await db.put(owner, "task-operations", { id, taskId, createdAt: "2026-10-08T00:00:00Z" });
  const query = underlying.query.bind(underlying);
  let rowsTransferred = 0;
  t.mock.method(underlying, "query", async (...args: Parameters<typeof query>) => {
    const result = await query(...args);
    rowsTransferred += result.rows.length;
    return result;
  });
  assert.deepEqual(
    (await new TaskJournal(db).operations("owner", "current")).map((op) => op.id),
    ["current-1", "current-2"],
  );
  assert.equal(rowsTransferred, 2, "unrelated research receipts must stay in the database");
});

test("inbox polling transfers due work, never completed history or future retries", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const underlying = (db as unknown as { db: QueryDatabase }).db;
  await underlying.query(`INSERT INTO records(owner,kind,id,data)
    SELECT 'owner','conversation-inbox','old-' || n,jsonb_build_object('id','old-' || n,'status','finished',
      'createdAt','2026-10-01T00:00:00Z','text',repeat('previous message ',200)) FROM generate_series(1,2000) n`);
  for (const [id, status, retryAfter] of [
    ["due", "accepted", null],
    ["future", "accepted", "2099-01-01T00:00:00Z"],
    ["recover", "dispatching", null],
  ] as const)
    await db.put("owner", "conversation-inbox", {
      id,
      status,
      retryAfter,
      createdAt: "2026-10-08T00:00:00Z",
    });
  const query = underlying.query.bind(underlying);
  let rowsTransferred = 0;
  t.mock.method(underlying, "query", async (...args: Parameters<typeof query>) => {
    const result = await query(...args);
    rowsTransferred += result.rows.length;
    return result;
  });
  assert.deepEqual(
    (await new ConversationInbox(db).pending()).map(({ value }) => value.id),
    ["due", "recover"],
  );
  assert.equal(rowsTransferred, 2);
});
