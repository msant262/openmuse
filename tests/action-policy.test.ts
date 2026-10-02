import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ActionLog } from "../apps/server/src/action-log.ts";
import { approvalPolicy } from "../apps/server/src/action-policy.ts";
import { ActionService } from "../apps/server/src/actions.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

let db: Store;
before(async () => {
  db = await createStore();
});
after(async () => {
  await db.close();
});
const email = {
  kind: "email.send",
  data: {
    to: ["someone@example.com"],
    subject: "hello",
    body: "PRIVATE BODY secret-token",
    attachmentIds: [],
  },
};
test("live default is money-only; scripted samples keep reviews", () => {
  assert.equal(approvalPolicy({ mode: "live" }), "money");
  assert.equal(approvalPolicy({ mode: "sample", approvalPolicy: "money" }), "all");
  assert.equal(approvalPolicy({ mode: "live", approvalPolicy: "all" }), "all");
});
test("automatic Google dispatch is claimed once and audits no message payload", async () => {
  let calls = 0;
  const service = new ActionService(db, {
    policy: "money",
    connected: async () => true,
    execute: async () => {
      calls++;
      return "sent";
    },
  });
  const [first, second] = await Promise.all([
    service.propose("auto", email, "mail-1"),
    service.propose("auto", email, "mail-1"),
  ]);
  assert.equal((await db.get("auto", "actions", first.id))?.status, "succeeded");
  assert.equal(first.id, second.id);
  await service.propose("auto", email, "mail-1");
  assert.equal(calls, 1);
  const log = await db.actionLog("auto");
  assert.deepEqual(log.entries.map((e) => e.result).sort(), ["started", "succeeded"]);
  assert.equal(JSON.stringify(log).includes("PRIVATE BODY"), false);
  assert.equal((await db.actionLog("other")).entries.length, 0);
});
test("audit insert failure prevents external dispatch and terminal status uses safe categories", async () => {
  const log = new ActionLog(db);
  let calls = 0;
  const original = db.appendActionLog.bind(db);
  db.appendActionLog = async () => {
    throw new Error("database offline");
  };
  try {
    await assert.rejects(
      log.run("owner", { tool: "test", target: "example.com", summary: "Call tool" }, async () => {
        calls++;
      }),
    );
  } finally {
    db.appendActionLog = original;
  }
  assert.equal(calls, 0);
  await assert.rejects(
    log.run("safe", { tool: "test", target: "example.com", summary: "Call tool" }, async () => {
      throw new Error("Bearer do-not-log-secret");
    }),
  );
  assert.equal(JSON.stringify(await db.actionLog("safe")).includes("do-not-log-secret"), false);
});
test("generic financial actions require native decisions and private binding never reaches review data", async () => {
  let calls = 0;
  const service = new ActionService(db, {
    policy: "money",
    connected: async () => false,
    execute: async () => "unused",
  });
  service.registerExternal("connector.pay", async (_owner, binding) => {
    assert.deepEqual(binding, { private: "secret" });
    calls++;
    return "completed";
  });
  const proposal = await service.proposeExternal(
    "pay",
    {
      tool: "connector.pay",
      target: "shop.example",
      summary: "Pay order",
      money: true,
      binding: { private: "secret" },
    },
    "pay-1",
  );
  assert.equal(proposal.status, "awaiting_review");
  assert.equal(JSON.stringify(proposal).includes("secret"), false);
  assert.equal(
    (await service.decide("pay", proposal.id, proposal.hash, "approve")).status,
    "succeeded",
  );
  await service.decide("pay", proposal.id, proposal.hash, "approve");
  assert.equal(calls, 1);
});

test("lost native response reuses exact receipt and rejects changed payload under the same request key", async () => {
  let calls = 0;
  const service = new ActionService(db, {
    policy: "money",
    connected: async () => true,
    execute: async () => {
      calls++;
      return "confirmed";
    },
  });
  await service.propose("lost-response", email, "native:stable-request-key");
  const replay = await service.propose("lost-response", email, "native:stable-request-key");
  assert.equal(replay.status, "succeeded");
  assert.equal(calls, 1);
  await assert.rejects(
    service.propose(
      "lost-response",
      { ...email, data: { ...email.data, body: "different" } },
      "native:stable-request-key",
    ),
    /different details/,
  );
  assert.equal(calls, 1);
});
test("known terminal audit completion is recovered from durable action receipt after transient failure", async (t) => {
  t.mock.method(console, "error", () => {});
  let calls = 0;
  const append = db.appendActionLog.bind(db);
  let fail = true;
  db.appendActionLog = async (owner, entry) => {
    if (fail && entry.result === "succeeded") {
      fail = false;
      throw new Error("transient audit failure");
    }
    return append(owner, entry);
  };
  const service = new ActionService(db, {
    policy: "money",
    connected: async () => true,
    execute: async () => {
      calls++;
      return "sent";
    },
  });
  try {
    const receipt = await service.propose("audit-recovery", email, "stable-audit");
    assert.equal(receipt.status, "succeeded");
  } finally {
    db.appendActionLog = append;
  }
  assert.equal((await db.actionLog("audit-recovery")).entries.length, 1);
  await new ActionLog(db).reconcile(true);
  assert.deepEqual((await db.actionLog("audit-recovery")).entries.map((e) => e.result).sort(), [
    "started",
    "succeeded",
  ]);
  assert.equal(calls, 1);
});
test("SQL mutation and truncation of the separate audit table are rejected", async () => {
  const sql = (db as unknown as { db: { query(sql: string): Promise<unknown> } }).db;
  for (const statement of [
    "UPDATE external_action_log SET data='{}'::jsonb",
    "DELETE FROM external_action_log",
    "TRUNCATE external_action_log",
  ])
    await assert.rejects(sql.query(statement), /append-only/);
  await db.put("safe", "external_action_log", { id: "mutable-lookalike", result: "fake" });
  assert.equal(
    (await db.actionLog("safe")).entries.some((e) => e.id === "mutable-lookalike"),
    false,
  );
});

test("automatic claims retain task cancellation, account binding and uncertain outcomes", async () => {
  const connection = { id: "account-a", account: "me@example.com" };
  let changed = false;
  let calls = 0;
  const service = new ActionService(db, {
    policy: "money",
    connected: async () => true,
    connection: async () =>
      changed ? { id: "account-b", account: "other@example.com" } : connection,
    prepare: async (_owner, input) => {
      changed = true;
      return { input };
    },
    execute: async () => {
      calls++;
      return "sent";
    },
  });
  await assert.rejects(service.propose("auto-account", email, "account-key"), /connection changed/);
  assert.equal(calls, 0);
  await db.put("auto-cancel", "tasks", { id: "task", status: "cancelled" });
  const cancelled = new ActionService(db, {
    policy: "money",
    connected: async () => true,
    execute: async () => {
      calls++;
      return "sent";
    },
  });
  await assert.rejects(
    cancelled.propose("auto-cancel", email, "cancel-key", "task"),
    /Cancelled tasks/,
  );
  assert.equal(calls, 0);
  const uncertain = new ActionService(db, {
    policy: "money",
    connected: async () => true,
    execute: async () => {
      calls++;
      throw Object.assign(new Error("Response lost"), { outcomeUnknown: true });
    },
  });
  assert.equal(
    (await uncertain.propose("auto-unknown", email, "unknown-key")).status,
    "outcome_unknown",
  );
  assert.equal(
    (await uncertain.propose("auto-unknown", email, "unknown-key")).status,
    "outcome_unknown",
  );
  assert.equal(calls, 1);
});
