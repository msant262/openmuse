import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JWT } from "google-auth-library";
import { createStore } from "../apps/server/src/db.ts";
import { nativePushAdapters, PushService } from "../apps/server/src/push.ts";

test("native notification stays durable with explicit missing credentials and private device tokens", async () => {
  const db = await createStore();
  try {
    const push = new PushService(db, {});
    await push.register("wife", {
      installationId: "phone",
      platform: "ios",
      token: "a".repeat(64),
    });
    const notice = {
      id: "n",
      title: "Agenda",
      body: "Sensitive result",
      createdAt: new Date().toISOString(),
      read: false,
    };
    await push.notify("wife", notice);
    assert.equal((await db.get("wife", "notifications", "n"))?.nativeDelivery, "not_configured");
    assert.deepEqual(await push.devices("other"), []);
    assert.ok(!JSON.stringify(await push.devices("wife")).includes("a".repeat(64)));
  } finally {
    await db.close();
  }
});

test("native send claims once, marks uncertain dispatch without replay, and accepted is not phone delivery", async () => {
  const db = await createStore();
  let sends = 0;
  try {
    const push = new PushService(db, {
      ios: async (_device, payload) => {
        sends++;
        assert.equal(payload.body, undefined);
        throw new Error("timeout after dispatch");
      },
    });
    await push.register("wife", {
      installationId: "phone",
      platform: "ios",
      token: "a".repeat(64),
    });
    const notice = {
      id: "n",
      title: "Agenda",
      body: "Sensitive",
      createdAt: new Date().toISOString(),
      read: false,
    };
    await Promise.all([push.notify("wife", notice), push.notify("wife", notice)]);
    await new PushService(db, {
      ios: async () => {
        sends++;
        return "accepted";
      },
    }).deliver("wife", notice);
    assert.equal(sends, 1);
    assert.equal((await db.get("wife", "notifications", "n"))?.nativeDelivery, "outcome_unknown");
  } finally {
    await db.close();
  }
});

test("a read notice keeps its original targets across token rotation, new phones and restart", async () => {
  const db = await createStore();
  const sent: string[] = [];
  const senders = {
    ios: async (device: { token: string }) => {
      sent.push(device.token);
      return "accepted" as const;
    },
  };
  const push = new PushService(db, senders);
  const notice = {
    id: "old-agenda",
    title: "Agenda",
    body: "Private",
    createdAt: new Date().toISOString(),
    read: false,
  };
  try {
    await push.register("wife", {
      installationId: "phone",
      platform: "ios",
      token: "a".repeat(64),
    });
    await push.notify("wife", notice);
    await db.compareAndSwap("wife", "notifications", notice.id, {}, { read: true });
    await push.register("wife", {
      installationId: "phone",
      platform: "ios",
      token: "b".repeat(64),
    });
    await push.register("wife", {
      installationId: "new-phone",
      platform: "ios",
      token: "c".repeat(64),
    });
    const restarted = new PushService(db, senders);
    const saved = await db.get<typeof notice>("wife", "notifications", notice.id);
    assert.ok(saved?.read);
    await Promise.all([push.deliver("wife", saved), restarted.deliver("wife", saved)]);
    await restarted.recover();
    assert.deepEqual(sent, ["a".repeat(64)]);
    assert.equal((await db.list("wife", "push-deliveries")).length, 1);
    await restarted.notify("wife", { ...notice, id: "fresh-agenda" });
    assert.deepEqual(sent.slice(1).sort(), ["b".repeat(64), "c".repeat(64)].sort());
  } finally {
    await push.close();
    await db.close();
  }
});

test("creation freezes eligible targets before dispatch; late configuration never sends historical notices", async () => {
  const db = await createStore();
  const sent: string[] = [];
  const push = new PushService(db, {
    ios: async (device) => {
      sent.push(device.token);
      return "accepted";
    },
  });
  const notice = {
    id: "notice-crash",
    title: "Agenda",
    body: "Private",
    createdAt: new Date().toISOString(),
    read: false,
  };
  try {
    await push.register("wife", {
      installationId: "phone",
      platform: "ios",
      token: "a".repeat(64),
    });
    // Exact crash boundary: notification/intent commit, no receipt or OS call yet.
    await push.register("wife", {
      installationId: "unchanged-phone",
      platform: "ios",
      token: "d".repeat(64),
    });
    await db.insertNotification("wife", notice, ["ios"]);
    await push.register("wife", {
      installationId: "phone",
      platform: "ios",
      token: "b".repeat(64),
    });
    await push.register("wife", {
      installationId: "new-phone",
      platform: "ios",
      token: "c".repeat(64),
    });
    await push.register("wife", {
      installationId: "unchanged-phone",
      platform: "ios",
      token: "d".repeat(64),
    });
    await push.recover();
    await push.notify("wife", notice);
    assert.deepEqual(
      sent,
      ["d".repeat(64)],
      "only the still-consenting original target is recovered",
    );
    assert.ok(
      (await db.pushDeliveries<{ status: string }>("wife", notice.id)).some(
        (delivery) => delivery.status === "suppressed",
      ),
    );
    const unavailable = new PushService(db, {});
    const old = { ...notice, id: "not-configured" };
    await unavailable.notify("wife", old);
    await db.compareAndSwap("wife", "notifications", old.id, {}, { read: true });
    await push.notify("wife", old);
    assert.equal(sent.length, 1);
    assert.equal((await db.get("wife", "notifications", old.id))?.nativeDelivery, "not_configured");
    // Receipt/intent committed but the visible native status update was interrupted.
    await db.put("wife", "notifications", { ...old, read: true });
    await push.recover();
    assert.equal((await db.get("wife", "notifications", old.id))?.nativeDelivery, "not_configured");
    assert.equal(sent.length, 1);
    // Pre-upgrade notices without a target intent cannot acquire today's devices.
    await db.put("wife", "notifications", { ...old, id: "legacy-read", read: true });
    await push.deliver("wife", { ...old, id: "legacy-read", read: true });
    assert.equal(sent.length, 1);
  } finally {
    await push.close();
    await db.close();
  }
});

test("disable/logout after notice creation prevents crash recovery sends and cannot enroll a replacement", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-push-consent-"));
  let db = await createStore({ dataDir: join(directory, "db") });
  const sent: string[] = [];
  const senders = {
    ios: async (device: { token: string }) => {
      sent.push(device.token);
      return "accepted" as const;
    },
  };
  let push = new PushService(db, senders);
  const notice = {
    id: "consent-crash",
    title: "Agenda",
    body: "Private",
    createdAt: new Date().toISOString(),
    read: false,
  };
  try {
    await push.register("wife", {
      installationId: "phone",
      platform: "ios",
      token: "a".repeat(64),
    });
    // Commit only the original delivery intent, then revoke via the disable/logout seam.
    await db.insertNotification("wife", notice, ["ios"]);
    await push.unregister("wife", "phone");
    assert.deepEqual(await push.devices("wife"), []);
    await push.close();
    await db.close();
    db = await createStore({ dataDir: join(directory, "db") });
    push = new PushService(db, senders);
    await push.recover();
    assert.deepEqual(sent, [], "revoked consent suppresses the unfinished original send");
    await push.register("wife", {
      installationId: "phone",
      platform: "ios",
      token: "a".repeat(64),
    });
    await push.register("wife", {
      installationId: "new-phone",
      platform: "ios",
      token: "b".repeat(64),
    });
    await push.notify("wife", notice);
    await push.recover();
    assert.deepEqual(sent, [], "reenabling the same token cannot revive the historical notice");
    const deliveries = await db.pushDeliveries<{ status: string }>("wife", notice.id);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].status, "suppressed");
    // Re-enrollment before recovery must revoke the original consent too, even with the same token.
    await push.register("reenabled", {
      installationId: "phone",
      platform: "ios",
      token: "a".repeat(64),
    });
    await db.insertNotification("reenabled", notice, ["ios"]);
    await push.unregister("reenabled", "phone");
    await push.register("reenabled", {
      installationId: "phone",
      platform: "ios",
      token: "a".repeat(64),
    });
    await push.recover();
    assert.deepEqual(sent, []);
    assert.equal(
      (await db.pushDeliveries<{ status: string }>("reenabled", notice.id))[0].status,
      "suppressed",
    );
    // Revocation can also commit after the atomic claim but before external dispatch.
    const claim = db.claimPushDelivery.bind(db);
    t.mock.method(
      db,
      "claimPushDelivery",
      async <T extends { id: string }>(
        owner: string,
        value: T,
        device: { id: string; token: string; platform: string; registrationId?: string },
      ): Promise<T | null> => {
        const result = await claim(owner, value, device);
        if (owner === "during-claim" && result) await push.unregister(owner, device.id);
        return result;
      },
    );
    await push.register("during-claim", {
      installationId: "phone",
      platform: "ios",
      token: "a".repeat(64),
    });
    await push.notify("during-claim", notice);
    assert.deepEqual(sent, []);
    assert.equal(
      (await db.pushDeliveries<{ status: string }>("during-claim", notice.id))[0].status,
      "suppressed",
    );
    // An in-flight invalid response cannot remove a new consent epoch with the same token.
    let invalidBegan!: () => void, releaseInvalid!: () => void;
    const invalidStarted = new Promise<void>((resolve) => {
      invalidBegan = resolve;
    });
    const invalidGate = new Promise<void>((resolve) => {
      releaseInvalid = resolve;
    });
    const late = new PushService(db, {
      ios: async () => {
        invalidBegan();
        await invalidGate;
        return "invalid_token";
      },
    });
    await late.register("late-provider", {
      installationId: "phone",
      platform: "ios",
      token: "a".repeat(64),
    });
    const invalidSend = late.notify("late-provider", notice);
    await invalidStarted;
    await late.unregister("late-provider", "phone");
    await late.register("late-provider", {
      installationId: "phone",
      platform: "ios",
      token: "a".repeat(64),
    });
    releaseInvalid();
    await invalidSend;
    await late.close();
    assert.equal((await late.devices("late-provider")).length, 1);
    await push.notify("wife", { ...notice, id: "fresh-consented" });
    assert.deepEqual(sent.sort(), ["a".repeat(64), "b".repeat(64)].sort());
  } finally {
    await push.close();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an invalid old token cannot remove its concurrently rotated installation; shutdown aborts in-flight delivery", async () => {
  const db = await createStore();
  let began!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const push = new PushService(db, {
    ios: async () => {
      began();
      await wait;
      return "invalid_token";
    },
  });
  const notice = {
    id: "rotating",
    title: "Agenda",
    body: "Result",
    createdAt: new Date().toISOString(),
    read: false,
  };
  try {
    await push.register("wife", {
      installationId: "phone",
      platform: "ios",
      token: "a".repeat(64),
    });
    const sending = push.notify("wife", notice);
    await started;
    await push.register("wife", {
      installationId: "phone",
      platform: "ios",
      token: "b".repeat(64),
    });
    release();
    await sending;
    assert.equal((await db.get("wife", "push-devices", "phone"))?.token, "b".repeat(64));
    const interrupted = new PushService(db, {
      ios: async (_device, _payload, signal) => {
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        );
        return "accepted";
      },
    });
    const second = { ...notice, id: "shutdown" };
    const delivery = interrupted.notify("wife", second);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await interrupted.close();
    await delivery;
    assert.equal(
      (await db.get("wife", "notifications", second.id))?.nativeDelivery,
      "outcome_unknown",
    );
  } finally {
    await push.close();
    await db.close();
  }
});

test("native FCM shutdown finishes even when token acquisition never resolves, with auth deadline and abort", {
  timeout: 5000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-fcm-fixture-"));
  const credentials = join(directory, "account.json");
  await writeFile(
    credentials,
    JSON.stringify({
      client_email: "fixture@example.test",
      private_key: "unused mocked credential",
    }),
  );
  let begin!: () => void, authSignal: AbortSignal | undefined, timeout: unknown;
  const started = new Promise<void>((resolve) => {
    begin = resolve;
  });
  t.mock.method(JWT.prototype, "getAccessToken", function (this: JWT) {
    authSignal = this.transporter.defaults.signal ?? undefined;
    timeout = this.transporter.defaults.timeout;
    begin();
    return new Promise(() => {});
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Fixture cannot call live push services");
  });
  const db = await createStore();
  const push = new PushService(
    db,
    nativePushAdapters({ fcmCredentialsFile: credentials, fcmProjectId: "fixture" }),
  );
  try {
    await push.register("wife", {
      installationId: "phone",
      platform: "android",
      token: "android-fixture-token",
    });
    const notice = {
      id: "n",
      title: "Agenda",
      body: "Private",
      createdAt: new Date().toISOString(),
      read: false,
    };
    const delivery = push.notify("wife", notice);
    await started;
    assert.equal(timeout, 15000);
    assert.ok(authSignal);
    await push.close();
    await delivery;
    assert.equal(authSignal.aborted, true);
    assert.equal((await db.get("wife", "notifications", "n"))?.nativeDelivery, "outcome_unknown");
  } finally {
    await push.close();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart recovery surfaces an expired native send as uncertain without sending it again", async () => {
  const db = await createStore();
  let sends = 0;
  const push = new PushService(db, {
    ios: async () => {
      sends++;
      return "accepted";
    },
  });
  try {
    const token = "a".repeat(64);
    await push.register("wife", { installationId: "phone", platform: "ios", token });
    const notice = {
      id: "n",
      title: "Agenda",
      body: "Private",
      createdAt: new Date().toISOString(),
      read: false,
      nativeDelivery: "pending" as const,
    };
    await db.put("wife", "notifications", notice);
    const id = createHash("sha256").update(`n:phone:${token}`).digest("hex");
    await db.put("wife", "push-deliveries", {
      id,
      status: "sending",
      deviceId: "phone",
      notificationId: "n",
      leaseUntil: "2020-01-01T00:00:00Z",
    });
    await push.recover();
    assert.equal((await db.get("wife", "notifications", "n"))?.nativeDelivery, "outcome_unknown");
    await push.deliver("wife", notice);
    assert.equal(sends, 0);
  } finally {
    await push.close();
    await db.close();
  }
});
