import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserService } from "../apps/server/src/browser.ts";
import { BrowserError } from "../apps/server/src/browser-contract.ts";
import { browserTools } from "../apps/server/src/browser-tools.ts";
import { createStore } from "../apps/server/src/db.ts";
import { TaskBrowserHistory } from "../apps/server/src/engine/browser-history.ts";
import { PushService } from "../apps/server/src/push.ts";

for (const change of ["unregister", "rotation", "reenrollment"] as const) {
  test(`native consent ${change} during audit-start await suppresses provider dispatch`, async () => {
    const db = await createStore();
    let sends = 0,
      held = false;
    let began!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const append = db.appendActionLog.bind(db);
    db.appendActionLog = async (owner, entry) => {
      await append(owner, entry);
      if (!held && entry.tool === "push.native" && entry.result === "started") {
        held = true;
        began();
        await barrier;
      }
    };
    const push = new PushService(db, {
      ios: async () => {
        sends++;
        return "accepted";
      },
    });
    const registration = {
      installationId: "private-phone",
      platform: "ios",
      token: "a".repeat(64),
    };
    let notifying: Promise<void> | undefined;
    try {
      await push.register("wife", registration);
      const notice = {
        id: "notice",
        title: "Private title",
        body: "Private body",
        read: false,
        createdAt: new Date().toISOString(),
      };
      notifying = push.notify("wife", notice);
      await started;
      if (change === "unregister" || change === "reenrollment")
        await push.unregister("wife", registration.installationId);
      if (change === "rotation")
        await push.register("wife", { ...registration, token: "b".repeat(64) });
      if (change === "reenrollment") await push.register("wife", registration);
      assert.equal(sends, 0);
      release();
      await notifying;
      assert.equal(sends, 0, "consent must still match after every awaited pre-dispatch write");
      assert.equal((await db.list("wife", "push-deliveries"))[0]?.status, "suppressed");
      assert.equal((await db.get("wife", "notifications", notice.id))?.nativeDelivery, "rejected");
      await push.recover();
      await push.deliver("wife", notice);
      assert.equal(sends, 0, "frozen target suppression must never be retried");
      const entries = (await db.actionLog("wife", 200)).entries;
      assert.deepEqual(entries.map((entry) => entry.result).sort(), ["denied", "started"]);
      for (const secret of [
        registration.token,
        "b".repeat(64),
        registration.installationId,
        notice.title,
        notice.body,
      ])
        assert.ok(!JSON.stringify(entries).includes(secret));
    } finally {
      release();
      await notifying;
      await push.close();
      await db.close();
    }
  });
}

test("browser act queued after a known pause dispatches once after fresh-executor resume", async () => {
  const db = await createStore();
  const sessionId = crypto.randomUUID();
  let stopped = false,
    effects = 0,
    validSnapshot = crypto.randomUUID();
  const service = {
    agentSession: async () => sessionId,
    get: async () => ({ title: "Form", url: "https://example.com/" }),
    snapshot: async () => {
      throw new BrowserError("BROWSER_CONTROLLED", "Hand back", 409, sessionId);
    },
    act: async (_owner: string, _session: string, action: { snapshotId: string }) => {
      assert.equal(action.snapshotId, validSnapshot);
      effects++;
      return { sessionId, snapshotId: crypto.randomUUID(), text: "Submitted once" };
    },
  } as unknown as BrowserService;
  const options = async () => {
    const history = await TaskBrowserHistory.load(db, "owner", "task");
    let tail = Promise.resolve();
    const tools = browserTools(service, "owner", {
      sessionId: () => sessionId,
      stopped: () => stopped,
      paused: async () => {
        stopped = true;
      },
      queue: (operation) => {
        const result = tail.then(operation);
        tail = result.then(
          () => {},
          () => {},
        );
        return result;
      },
      record: (name, args, operation) => history.run(name, args, operation),
    });
    const snapshot = tools.find((tool) => tool.name === "browser_snapshot");
    const act = tools.find((tool) => tool.name === "browser_act");
    assert.ok(snapshot?.execute && act?.execute);
    return {
      history,
      snapshot: snapshot.execute,
      act: act.execute as (args: unknown) => Promise<unknown>,
    };
  };
  try {
    const first = await options();
    const args = () => ({
      operationId: "queued-submit",
      act: { action: "click", snapshotId: validSnapshot, element: 1 },
    });
    const [, skipped] = await Promise.all([first.snapshot({}), first.act(args())]);
    assert.equal(effects, 0);
    assert.equal((skipped as { paused: boolean }).paused, true);
    stopped = false;
    validSnapshot = crypto.randomUUID();
    const resumed = await options();
    assert.equal(
      resumed.history.unconfirmedAction,
      false,
      "known skips are not uncertain dispatches",
    );
    const receipt = await resumed.act(args());
    assert.equal(
      effects,
      1,
      "same logical ID must remain executable when the old call never dispatched",
    );
    const reloaded = await options();
    validSnapshot = crypto.randomUUID();
    assert.deepEqual(await reloaded.act(args()), receipt);
    assert.equal(effects, 1, "completed effects still deduplicate");
    const context = JSON.stringify(reloaded.history.messages());
    assert.match(context, /skipped/);
    assert.match(context, /Submitted once/);
    assert.ok(!context.includes("outcomeUnknown"));
  } finally {
    await db.close();
  }
});

test("audit-start failure blocks native sender and retains a nonretryable receipt", async () => {
  const db = await createStore();
  let sends = 0,
    failed = false;
  const append = db.appendActionLog.bind(db);
  db.appendActionLog = async (owner, entry) => {
    if (!failed && entry.tool === "push.native" && entry.result === "started") {
      failed = true;
      throw new Error("Injected audit start failure");
    }
    await append(owner, entry);
  };
  const push = new PushService(db, {
    ios: async () => {
      sends++;
      return "accepted";
    },
  });
  try {
    await push.register("wife", {
      installationId: "phone",
      platform: "ios",
      token: "a".repeat(64),
    });
    const notice = {
      id: "n",
      title: "Notice",
      body: "",
      read: false,
      createdAt: new Date().toISOString(),
    };
    await push.notify("wife", notice);
    await push.recover();
    await push.deliver("wife", notice);
    assert.equal(sends, 0);
    assert.equal((await db.list("wife", "push-deliveries"))[0]?.status, "outcome_unknown");
    assert.ok(
      (await db.actionLog("wife")).entries.some((entry) => entry.result === "outcome_unknown"),
    );
  } finally {
    await push.close();
    await db.close();
  }
});

test("previously stored completed paused browser receipts normalize into truthful skips", async () => {
  const db = await createStore();
  try {
    await db.put("owner", "task-browser-history", {
      id: "task",
      entries: [
        {
          id: "old",
          name: "browser_act",
          args: { operationId: "submit" },
          key: "intent:submit",
          status: "completed",
          result: { paused: true, reason: "The task is paused or finished." },
        },
      ],
    });
    const history = await TaskBrowserHistory.load(db, "owner", "task");
    assert.equal(history.unconfirmedAction, false);
    assert.match(JSON.stringify(history.messages()), /skipped/);
    let effects = 0;
    await history.run("browser_act", { operationId: "submit" }, async () => {
      effects++;
      return { text: "Submitted once" };
    });
    assert.equal(effects, 1);
  } finally {
    await db.close();
  }
});
