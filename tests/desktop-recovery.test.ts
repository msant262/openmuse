import assert from "node:assert/strict";
import test from "node:test";
import { registration } from "./helpers/executors.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

type QueryDatabase = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: { data: unknown }[] }>;
};

test("desktop restart recovery leaves settled viewer history in storage without rewriting it", async (t) => {
  const f = await taskRuntime(t, {
    computerEnabled: true,
    computerBackend: "native",
    nativeExecutorId: registration.executorId,
    nativeExecutors: [{ ...registration, owner: "owner" }],
    taskWorkerEnabled: false,
  });
  assert.ok(f.desktopViewers);
  const sql = (f.db as unknown as { db: QueryDatabase }).db;
  await sql.query(`INSERT INTO records(owner,kind,id,data)
    SELECT 'owner','desktop-viewer-sessions','settled-' || n,
      jsonb_build_object('id','settled-' || n,'closed',true,'sessionId','desktop','deviceId','device','generation','generation')
    FROM generate_series(1,50) n`);
  await f.db.put("another-owner", "task-operations", {
    id: "unrelated-input",
    taskId: "settled-1",
    status: "outcome_unknown",
    effect: true,
    nativeEnvelope: { id: "unrelated-input" },
    receipt: { data: { cleanupConfirmed: false } },
  });
  await sql.query(`INSERT INTO records(owner,kind,id,data)
    SELECT 'owner','tasks','settled-' || n,
      jsonb_build_object('id','settled-' || n,'status','cancelled','leaseId',null,'state','{}'::jsonb)
    FROM generate_series(1,50) n`);
  const before = await sql.query(`SELECT jsonb_build_object('id',id,'updatedAt',updated_at) AS data
    FROM records WHERE owner='owner' AND kind='desktop-viewer-sessions' ORDER BY id`);
  const query = sql.query.bind(sql);
  let transferred = 0;
  const writes: string[] = [];
  const observed = t.mock.method(sql, "query", async (...args: Parameters<typeof query>) => {
    const result = await query(...args);
    transferred += result.rows.length;
    if (/\b(?:INSERT|UPDATE|DELETE)\b/i.test(args[0])) writes.push(args[0]);
    return result;
  });
  await f.desktopViewers.recover();
  observed.mock.restore();
  const after = await sql.query(`SELECT jsonb_build_object('id',id,'updatedAt',updated_at) AS data
    FROM records WHERE owner='owner' AND kind='desktop-viewer-sessions' ORDER BY id`);
  assert.equal(
    writes.length,
    0,
    "settled history must not create persistence work on every restart",
  );
  assert.equal(transferred, 0, "settled viewer/task payloads must stay in the database");
  assert.deepEqual(after.rows, before.rows, "recovery must preserve timestamps of closed viewers");
});

test("desktop restart still cancels open viewers and retains unconfirmed inputs even without recovery flags", async (t) => {
  const f = await taskRuntime(t, {
    computerEnabled: true,
    computerBackend: "native",
    nativeExecutorId: registration.executorId,
    nativeExecutors: [{ ...registration, owner: "owner" }],
    taskWorkerEnabled: false,
  });
  assert.ok(f.desktopViewers);
  for (const id of ["open", "unknown", "cleaned"])
    await f.db.put("owner", "desktop-viewer-sessions", {
      id,
      closed: id !== "open",
      sessionId: "desktop",
      deviceId: "device",
      generation: "generation",
    });
  for (const id of ["open", "unknown", "cleaned"])
    await f.db.put("owner", "tasks", {
      id,
      status: id === "open" ? "running" : "cancelled",
      leaseId: id === "open" ? "lease" : null,
      state: {},
    });
  const receipts = [
    {
      id: "unknown-input",
      taskId: "unknown",
      status: "outcome_unknown",
      effect: true,
      nativeEnvelope: { id: "unknown-input" },
      receipt: { data: { cleanupConfirmed: false } },
    },
    {
      id: "cleaned-input",
      taskId: "cleaned",
      status: "outcome_unknown",
      effect: true,
      nativeEnvelope: { id: "cleaned-input" },
      receipt: { data: { cleanupConfirmed: true } },
    },
  ];
  for (const receipt of receipts) await f.db.put("owner", "task-operations", receipt);
  for (const id of ["unknown", "cleaned"])
    await f.db.put("__runtime__", "work-admissions", { id, hold: true });
  await f.desktopViewers.recover();
  assert.equal((await f.db.get("owner", "desktop-viewer-sessions", "open"))?.closed, true);
  const open = await f.db.get("owner", "tasks", "open");
  assert.equal(open?.status, "cancelled");
  assert.equal(open?.leaseId, null);
  const unknown = await f.db.get<{ state: { nativeAdmissionPending?: boolean } }>(
    "owner",
    "tasks",
    "unknown",
  );
  assert.equal(unknown?.state.nativeAdmissionPending, true);
  assert.equal((await f.db.get("__runtime__", "work-admissions", "unknown"))?.hold, true);
  assert.equal(await f.db.get("__runtime__", "work-admissions", "cleaned"), null);
  assert.deepEqual(
    (await f.db.list("owner", "task-operations")).sort((a, b) =>
      String(a.id).localeCompare(String(b.id)),
    ),
    [...receipts].sort((a, b) => a.id.localeCompare(b.id)),
    "recovery preserves both receipts and never replays an input",
  );
});
