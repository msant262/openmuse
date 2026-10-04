import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import { AgentProfile } from "../apps/server/src/agent-profile.ts";
import { createStore, Store } from "../apps/server/src/db.ts";
import { agentRoutes } from "../apps/server/src/engine/routes.ts";
import type { AgentService } from "../apps/server/src/engine/service.ts";
import { MemoryService } from "../apps/server/src/memory.ts";
import { personalTools } from "../apps/server/src/personal-tools.ts";

test("forget normalizes stale legacy fingerprints and suppresses current unversioned text as well as history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "okami-legacy-fingerprint-"));
  let db = await createStore({ dataDir: dir });
  try {
    const memory = new MemoryService(db);
    const fact = await memory.save("owner", "Legacy morning preference", "User");
    await db.compareAndSwap(
      "owner",
      "memories",
      fact.id,
      {},
      { text: "Legacy evening preference" },
    );
    await memory.forget("owner", fact.id, { expectedRevision: 1, requestId: "forget-raw-edit" });
    await db.close();
    db = await createStore({ dataDir: dir });
    const restarted = new MemoryService(db);
    await assert.rejects(
      restarted.save("owner", "Legacy evening preference", "Recovered current text"),
      /forgotten|suppressed/i,
    );
    await assert.rejects(
      restarted.save("owner", fact.text, "Recovered history"),
      /forgotten|suppressed/i,
    );
    assert.deepEqual(await restarted.recall("owner"), []);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("recall derives a fact's current fingerprint and ignores stale legacy fingerprint/restore metadata", async () => {
  const db = await createStore();
  const memory = new MemoryService(db);
  try {
    const original = await memory.save("owner", "Suppressed original text", "User");
    await memory.forget("owner", original.id, { expectedRevision: 1, requestId: "forget" });
    const other = await memory.save("owner", "Different current fact", "User");
    const old = await db.get<{ fingerprint: string }>("owner", "memories", original.id);
    await db.compareAndSwap("owner", "memories", other.id, {}, { fingerprint: old?.fingerprint });
    assert.equal((await memory.recall("owner", other.text))[0]?.id, other.id);
    const copied = await memory.save("owner", "Unrelated prior text", "User");
    await db.compareAndSwap("owner", "memories", copied.id, {}, { text: `\t${original.text}\n` });
    assert.deepEqual(await memory.recall("owner", original.text), []);
    await memory.restore("owner", original.id, {
      revision: 1,
      expectedRevision: 2,
      requestId: "settings-restore",
      allowForgotten: true,
    });
    await db.compareAndSwap(
      "owner",
      "memories",
      original.id,
      {},
      { text: "Different explicitly edited fact" },
    );
    assert.deepEqual(await memory.recall("owner", "Suppressed"), []);
    assert.equal((await memory.recall("owner", "Different explicitly"))[0]?.id, original.id);
    await assert.rejects(
      memory.save("owner", "Suppressed original text", "Automatic duplicate"),
      /forgotten|suppressed/i,
    );
  } finally {
    await db.close();
  }
});

test("correct_memory cannot recover a forgotten fingerprint; authenticated settings restore remains recallable", async () => {
  const db = await createStore();
  const memory = new MemoryService(db);
  try {
    const forgotten = await memory.save("owner", "My address is Rua Um", "User");
    await memory.forget("owner", forgotten.id, { expectedRevision: 1, requestId: "forget" });
    const other = await memory.save("owner", "My unrelated preference is morning", "User");
    const source = { messageId: "address", threadId: "chat", runId: "run-address" };
    await db.put("owner", "conversation-inbox", {
      id: "chat:address",
      ...source,
      text: forgotten.text,
      createdAt: new Date().toISOString(),
      status: "dispatching",
    });
    const tool = personalTools(
      { db, memory, routines: { timezone: "Europe/Berlin" } } as AgentService,
      "owner",
      "chat",
      { profileSource: source },
    ).find((item) => item.name === "correct_memory") as {
      execute: (input: unknown) => Promise<unknown>;
    };
    await assert.rejects(
      tool.execute({
        id: other.id,
        text: forgotten.text,
        expectedRevision: 1,
        requestId: "recover",
        category: "fact",
        evidence: [{ quote: "My address is Rua Um" }],
      }),
      /forgotten|suppressed/i,
    );
    assert.deepEqual(await memory.recall("owner", "Rua Um"), []);
    assert.equal((await memory.history("owner", other.id)).entries.length, 1);
    const app = new Hono<{ Variables: { owner: string } }>();
    app.use("*", async (c, next) => {
      c.set("owner", "owner");
      await next();
    });
    app.route("/", agentRoutes({ memory } as AgentService));
    const restore = await app.request(`/memories/${forgotten.id}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: 1, expectedRevision: 2, requestId: "trusted-undo" }),
    });
    assert.equal(restore.status, 200);
    assert.equal((await memory.recall("owner", "Rua Um"))[0]?.id, forgotten.id);
    assert.equal(
      (await memory.save("owner", forgotten.text, "Recovered conversation")).id,
      forgotten.id,
    );
    await assert.rejects(
      memory.update("owner", other.id, {
        text: forgotten.text,
        expectedRevision: 1,
        requestId: "still-suppressed",
      }),
      /forgotten|suppressed/i,
    );
  } finally {
    await db.close();
  }
});

test("forget filters previously recovered copies and serializes concurrent save/correction suppression across restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "okami-forget-copies-"));
  let db = await createStore({ dataDir: dir });
  try {
    const memory = new MemoryService(db);
    const original = await memory.save("copies", "Original factual text", "User");
    await memory.update("copies", original.id, {
      text: "Corrected factual text",
      expectedRevision: 1,
      requestId: "edit",
    });
    const copy = await memory.save("copies", original.text, "Recovered conversation");
    await db.put("copies", "memories", {
      id: "legacy-copy",
      text: original.text,
      source: "Earlier legacy recovery",
      createdAt: original.createdAt,
    });
    await memory.forget("copies", original.id, { expectedRevision: 2, requestId: "forget" });
    assert.deepEqual(await memory.recall("copies"), []);
    await assert.rejects(
      memory.save("copies", copy.text, "Recovered again"),
      /forgotten|suppressed/i,
    );
    for (let i = 0; i < 6; i++) {
      const owner = `race-${i}`;
      const fact = await memory.save(owner, "Suppressed race text", "User");
      const other = await memory.save(owner, "Unrelated race fact", "User");
      const effects = [
        () => memory.forget(owner, fact.id, { expectedRevision: 1, requestId: "forget" }),
        () =>
          memory.update(owner, other.id, {
            text: fact.text,
            expectedRevision: 1,
            requestId: "correct",
          }),
        () => memory.save(owner, fact.text, "Recovered conversation"),
      ];
      const results = await Promise.allSettled(
        (i % 2 ? effects.reverse() : effects).map((run) => run()),
      );
      assert.equal(
        results.filter((entry) => entry.status === "fulfilled" && "forgotten" in entry.value)
          .length,
        1,
      );
      assert.deepEqual(await memory.recall(owner, "Suppressed"), []);
      await assert.rejects(
        memory.save(owner, fact.text, "Recovered after race"),
        /forgotten|suppressed/i,
      );
    }
    await db.close();
    db = await createStore({ dataDir: dir });
    assert.deepEqual(await new MemoryService(db).recall("copies"), []);
    assert.doesNotMatch(
      await new MemoryService(db).context("copies", "Original factual"),
      /Original factual text/,
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent memory edits use CAS; undo is a new revision with original acquisition time", async () => {
  const db = await createStore();
  const memory = new MemoryService(db);
  try {
    const fact = await memory.save("owner", "Prefiro reuniões de manhã", "User");
    const results = await Promise.allSettled([
      memory.update("owner", fact.id, {
        text: "Prefiro reuniões à tarde",
        expectedRevision: 1,
        requestId: "human",
      }),
      memory.update("owner", fact.id, {
        text: "Prefiro reuniões à noite",
        expectedRevision: 1,
        requestId: "agent",
      }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const failure = results.find((r) => r.status === "rejected");
    assert.equal(failure?.status === "rejected" && failure.reason.status, 409);
    const restored = await memory.restore("owner", fact.id, {
      revision: 1,
      expectedRevision: 2,
      requestId: "undo",
    });
    assert.equal(restored.revision, 3);
    assert.equal(restored.text, fact.text);
    assert.equal(restored.createdAt, fact.createdAt);
    assert.equal((await memory.history("owner", fact.id)).entries.length, 3);
    assert.equal(
      (
        await memory.restore("owner", fact.id, {
          revision: 1,
          expectedRevision: 2,
          requestId: "undo",
        })
      ).revision,
      3,
    );
    await assert.rejects(
      memory.restore("owner", fact.id, { revision: 1, expectedRevision: 2, requestId: "stale" }),
      { status: 409 },
    );
  } finally {
    await db.close();
  }
});

test("forget suppression and paginated history survive disk restart; recovery cannot resurrect it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "okami-memory-"));
  let db = await createStore({ dataDir: dir });
  try {
    const memory = new MemoryService(db);
    const fact = await memory.save("owner", "My address is Rua Um", "User");
    await memory.update("owner", fact.id, {
      text: "My address is Rua Dois",
      expectedRevision: 1,
      requestId: "edit",
    });
    await memory.forget("owner", fact.id, { expectedRevision: 2, requestId: "forget" });
    await db.close();
    db = await createStore({ dataDir: dir });
    const restored = new MemoryService(db);
    assert.deepEqual(await restored.recall("owner"), []);
    await assert.rejects(
      restored.save("owner", "My address is Rua Um", "Recovered conversation"),
      /forgotten|suppressed/i,
    );
    await assert.rejects(
      restored.save("owner", "My address is Rua Dois", "Recovered conversation"),
      /forgotten|suppressed/i,
    );
    const page = await restored.history("owner", fact.id, { limit: 1 });
    assert.equal(page.entries[0].revision, 3);
    assert.ok(page.nextCursor);
    assert.equal(
      (await restored.history("owner", fact.id, { limit: 1, cursor: page.nextCursor })).entries[0]
        .revision,
      2,
    );
    await assert.rejects(
      restored.restore("owner", fact.id, {
        revision: 1,
        expectedRevision: 3,
        requestId: "auto-undo",
      }),
      /forgotten|explicit/i,
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("memory validity respects explicit offsets across Berlin DST and never infers a language", async () => {
  const db = await createStore();
  let now = Date.parse("2026-10-25T00:59:59Z");
  const memory = new MemoryService(db, () => now);
  try {
    const fact = await memory.save("owner", "Temporary meeting preference", "User", {
      validUntil: "2026-10-25T02:00:00+01:00",
      timezone: "Europe/Berlin",
    });
    assert.equal((await memory.recall("owner"))[0].id, fact.id);
    now = Date.parse("2026-10-25T01:00:00Z");
    assert.deepEqual(await memory.recall("owner"), []);
    await assert.rejects(
      memory.save("owner", "Another", "User", {
        validUntil: "2026-10-25T02:00:00",
        timezone: "Europe/Berlin",
      }),
    );
    assert.equal((await new AgentProfile(db).get("owner")).fields.language, "en-US");
  } finally {
    await db.close();
  }
});

test("profile undo preserves per-scope authority and facts; arbitrary chat source cannot restore", async () => {
  const db = await createStore();
  const profile = new AgentProfile(db);
  try {
    await db.put("owner", "threads", { id: "a" });
    await db.put("owner", "threads", { id: "b" });
    await new MemoryService(db).save("owner", "Keep this fact", "User");
    await profile.update("owner", {
      scope: { kind: "conversation", threadId: "a" },
      expectedRevision: 0,
      requestId: "a1",
      origin: { kind: "settings" },
      patch: { responseLength: "detailed" },
    });
    await profile.update("owner", {
      scope: { kind: "conversation", threadId: "b" },
      expectedRevision: 0,
      requestId: "b1",
      origin: { kind: "settings" },
      patch: { tone: "thoughtful" },
    });
    await profile.update("owner", {
      scope: { kind: "conversation", threadId: "a" },
      expectedRevision: 1,
      requestId: "a2",
      origin: { kind: "settings" },
      patch: { responseLength: "concise" },
    });
    const restored = await profile.restore("owner", {
      scope: { kind: "conversation", threadId: "a" },
      revision: 1,
      expectedRevision: 2,
      requestId: "a3",
      origin: { kind: "settings" },
    });
    assert.equal(restored.revisions.conversation, 3);
    assert.equal(restored.fields.responseLength, "detailed");
    assert.equal((await profile.get("owner", "b")).fields.tone, "thoughtful");
    assert.equal((await new MemoryService(db).recall("owner")).length, 1);
    assert.equal(
      (await profile.history("owner", { kind: "conversation", threadId: "a" })).entries.length,
      4,
    );
    await assert.rejects(
      profile.restore("owner", {
        scope: { kind: "global" },
        revision: 0,
        expectedRevision: 0,
        requestId: "forged",
        origin: { kind: "chat", messageId: "source" },
      }),
      { status: 403 },
    );
  } finally {
    await db.close();
  }
});

test("new CAS/history writes invalidate a stopped-writer snapshot after a disk write failure", async () => {
  const db = new Store({
    query: async () => {
      throw new Error("disk unavailable");
    },
    close: async () => {},
  });
  await assert.rejects(
    db.durableMutation("owner", "memory:edit", "binding", []),
    /disk unavailable/,
  );
  assert.equal(db.persistenceFailed, true);
  await assert.rejects(
    db.memoryMutation("owner", "memory:edit", "binding", [], false),
    /disk unavailable/,
  );
});

test("notification reads stay local and bounded; settings memory correction/history use the same CAS", async () => {
  const db = await createStore();
  const memory = new MemoryService(db);
  const service = {
    db,
    memory,
    profiles: new AgentProfile(db),
    snapshot: () => {
      throw new Error("workspace/connectors must not be loaded");
    },
  } as unknown as AgentService;
  const app = new Hono<{ Variables: { owner: string } }>();
  app.use("*", async (c, next) => {
    c.set("owner", "owner");
    await next();
  });
  app.route("/", agentRoutes(service));
  try {
    for (let i = 0; i < 105; i++)
      await db.put("owner", "notifications", {
        id: `n${String(i).padStart(3, "0")}`,
        title: "Notice",
        body: "fixture",
        createdAt: "2026-10-02T00:00:00Z",
        read: false,
      });
    const notices = await app.request("/notifications");
    assert.equal(notices.status, 200);
    assert.equal((await notices.json()).length, 100);
    const page = await (await app.request("/notifications/page?limit=7")).json();
    assert.equal(page.entries.length, 7);
    assert.equal(page.nextCursor, "n006");
    assert.equal(
      (await (await app.request(`/notifications/page?limit=7&cursor=${page.nextCursor}`)).json())
        .entries[0].id,
      "n007",
    );
    const fact = await memory.save("owner", "First fact", "User");
    const response = await app.request(`/memories/${fact.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Corrected fact",
        expectedRevision: 1,
        requestId: "ui-correction",
      }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).revision, 2);
    const history = await (await app.request(`/memories/${fact.id}/history`)).json();
    assert.equal(history.entries[0].value.origin.kind, "settings");
    assert.equal(history.entries[1].value.text, "First fact");
  } finally {
    await db.close();
  }
});
