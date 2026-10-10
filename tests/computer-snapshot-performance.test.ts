import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ActionLog } from "../apps/server/src/action-log.ts";
import { auditedComputer } from "../apps/server/src/audited-computer.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ResourceLeases } from "../apps/server/src/engine/resource-leases.ts";
import { ExecutorRegistry } from "../apps/server/src/executors/registry.ts";
import { RemoteComputerBackend } from "../apps/server/src/executors/remote-computer.ts";
import { authority, context, hello, registration } from "./helpers/executors.ts";

type QueryDatabase = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: { data: Record<string, unknown> }[] }>;
};

async function fixture(t: TestContext) {
  const db = await createStore();
  t.after(() => db.close());
  const registry = new ExecutorRegistry(db, {
    registrations: [registration],
    authority: authority(db),
  });
  const { epoch } = await registry.register(hello);
  await registry.reconcile(registration.executorId, {
    epoch,
    bootId: hello.bootId,
    operations: [],
    contained: true,
  });
  const underlying = (db as unknown as { db: QueryDatabase }).db;
  await underlying.query(`INSERT INTO records(owner,kind,id,data)
    SELECT '__executors__','deliveries','history-' || lpad(n::text,4,'0'),jsonb_build_object(
      'id','history-' || lpad(n::text,4,'0'),'owner','owner','state','settled','sequence',1,
      'createdAt',to_char(timestamp '2026-10-09' + n * interval '1 second','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'operation',jsonb_build_object('executorId','lenovo-okami','kind','command','capability','command',
        'createdAt','2026-10-09T00:00:00Z','args',jsonb_build_object('command','printf old','cwd','/workspace','timeoutMs',1000,'background',true)),
      'receipt',jsonb_build_object('status','succeeded','data',jsonb_build_object(
        'id','history-' || lpad(n::text,4,'0'),'command','printf old','cwd','/workspace','kind','command',
        'timeoutMs',1000,'background',true,'status','succeeded','exitCode',0,'stdout',repeat('previous result ',256),
        'stderr','','truncated',false,'cleanupConfirmed',true,'startedAt','2026-10-09T00:00:00Z','completedAt','2026-10-09T01:00:00Z')))
    FROM generate_series(1,1000) n`);
  await underlying.query(`INSERT INTO records(owner,kind,id,data)
    SELECT 'owner','computer-commands',id,data->'receipt'->'data' FROM records WHERE owner='__executors__' AND kind='deliveries'`);
  await underlying.query(`INSERT INTO records(owner,kind,id,data)
    SELECT 'owner','computer-audit',id,jsonb_build_object('id',id,'operationId',id,'phase','complete','complete',true,
      'tool','computer.command','target','Private workspace','summary','Computer command','leases','[]'::jsonb)
    FROM records WHERE owner='__executors__' AND kind='deliveries'`);
  const sample = await registry.delivery("owner", "history-1000");
  assert.ok(sample);
  for (const [id, owner, executorId, kind] of [
    ["other-owner", "other", registration.executorId, "command"],
    ["other-executor", "owner", "other-executor", "command"],
    ["new-file", "owner", registration.executorId, "file"],
  ])
    await db.put("__executors__", "deliveries", {
      ...sample,
      id,
      owner,
      createdAt: "2099-01-01T00:00:00Z",
      operation: { ...sample.operation, executorId, kind },
    });
  const native = new RemoteComputerBackend(registry, {
    executorId: registration.executorId,
    context: async () => context,
  });
  const resources = new ResourceLeases(db);
  const computer = auditedComputer(
    native,
    new ActionLog(db),
    "native",
    resources,
    registration.hostId,
  );
  const query = underlying.query.bind(underlying);
  const stats = { queries: 0, rows: 0, writes: 0 };
  t.mock.method(underlying, "query", async (...args: Parameters<typeof query>) => {
    stats.queries++;
    if (/^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(args[0])) stats.writes++;
    const result = await query(...args);
    stats.rows += result.rows.length;
    return result;
  });
  return { db, registry, native, computer, resources, stats };
}

test("desktop status transfers only its latest command window, independent of native delivery history", async (t) => {
  const f = await fixture(t);
  const snapshot = await f.native.snapshot("owner");
  assert.equal(snapshot.status, "running");
  assert.equal(snapshot.commands.length, 100);
  assert.equal(snapshot.commands[0].id, "history-1000");
  assert.equal(snapshot.commands.at(-1)?.id, "history-0901");
  t.diagnostic(JSON.stringify(f.stats));
  assert.ok(
    f.stats.rows <= 110,
    `historical and foreign deliveries must stay in the database: ${JSON.stringify(f.stats)}`,
  );
  assert.equal(
    (await f.registry.deliveries("owner", registration.executorId)).length,
    1001,
    "reconciliation and explicit delivery retrieval retain the complete history",
  );
});

test("repeated audited desktop status does not rewrite settled commands or repeat completed audit effects", async (t) => {
  const f = await fixture(t);
  const first = await f.computer.snapshot("owner");
  const second = await f.computer.snapshot("owner");
  assert.deepEqual(second, first);
  t.diagnostic(JSON.stringify(f.stats));
  assert.equal(
    f.stats.writes,
    0,
    "observing completed history must not perform persistence or audit writes",
  );
  assert.ok(
    f.stats.queries <= 10,
    "each idle snapshot must use bounded reads rather than serial per-command requests",
  );
});

test("desktop status still validates the canonical binding before trusting a cached terminal projection", async (t) => {
  const f = await fixture(t);
  const delivery = await f.registry.delivery("owner", "history-1000");
  assert.ok(delivery?.receipt?.data);
  await f.db.put("__executors__", "deliveries", {
    ...delivery,
    receipt: {
      ...delivery.receipt,
      data: { ...delivery.receipt.data, command: "different command" },
    },
  });
  await assert.rejects(f.native.snapshot("owner"), /receipt binding does not match/);
  await assert.rejects(f.native.snapshot("other"), /belongs to another owner/);
});

test("desktop status retains uncertain resources and releases them only after confirmed native cleanup", async (t) => {
  const f = await fixture(t);
  const id = "history-1000";
  const delivery = await f.registry.delivery("owner", id);
  assert.ok(delivery?.receipt?.data);
  const leases = await f.resources.acquire("owner", id, [
    { key: "cpu-heavy:lenovo", mode: "exclusive", units: 1 },
  ]);
  assert.ok(leases);
  await f.resources.holdTask(id);
  await f.db.put("owner", "computer-audit", {
    id,
    operationId: id,
    phase: "dispatching",
    complete: false,
    tool: "computer.command",
    target: "Private workspace",
    summary: "Computer command",
    leases,
  });
  await f.db.put("owner", "computer-commands", {
    ...delivery.receipt.data,
    id,
    status: "running",
    cleanupConfirmed: false,
    completedAt: undefined,
  });
  await f.db.put("__executors__", "deliveries", {
    ...delivery,
    receipt: { status: "outcome_unknown", data: { cleanupConfirmed: false } },
  });
  const pending = (await f.computer.snapshot("owner")).commands[0];
  assert.equal(pending.status, "running");
  assert.equal(pending.outcomeUnknown, true);
  assert.deepEqual(await f.resources.listForTask(id), leases);
  await f.db.put("__executors__", "deliveries", {
    ...delivery,
    receipt: { status: "outcome_unknown", data: { cleanupConfirmed: true } },
  });
  const settled = (await f.computer.snapshot("owner")).commands[0];
  assert.equal(settled.status, "interrupted");
  assert.equal(settled.outcomeUnknown, true);
  assert.equal(settled.cleanupConfirmed, true);
  assert.deepEqual(await f.resources.listForTask(id), []);
});

test("a completed audit with a retained physical handle is still cleaned up without another audit entry", async (t) => {
  const f = await fixture(t);
  const id = "history-1000";
  const leases = await f.resources.acquire("owner", id, [
    { key: "cpu-heavy:lenovo", mode: "exclusive", units: 1 },
  ]);
  assert.ok(leases);
  await f.resources.holdTask(id);
  await f.db.put("owner", "computer-audit", {
    id,
    operationId: id,
    phase: "complete",
    complete: true,
    tool: "computer.command",
    target: "Private workspace",
    summary: "Computer command",
    leases,
  });
  await f.computer.snapshot("owner");
  assert.deepEqual(await f.resources.listForTask(id), []);
  assert.deepEqual(await f.db.list("owner", "action-log"), []);
});
