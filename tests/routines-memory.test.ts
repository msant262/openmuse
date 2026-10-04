import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { MemoryService } from "../apps/server/src/memory.ts";
import { nextRoutineRun, RoutinesService } from "../apps/server/src/routines.ts";

test("weekday routine uses explicit timezone and rejects seconds or invalid timezone", () => {
  assert.equal(
    nextRoutineRun("0 8 * * 1-5", "Europe/Berlin", Date.parse("2026-10-02T07:00:00Z")),
    "2026-10-05T06:00:00.000Z",
  );
  assert.equal(
    nextRoutineRun("0 8 * * 1-5", "Europe/Berlin", Date.parse("2026-10-23T07:00:00Z")),
    "2026-10-26T07:00:00.000Z",
  );
  assert.throws(() => nextRoutineRun("0 * * * * *", "UTC", Date.now()), /five|5/);
  assert.throws(() => nextRoutineRun("0 8 * * *", "not-a-zone", Date.now()), /timezone/i);
});

test("routine slot survives enqueue failure, concurrent ticks deduplicate, pause and delete stop future slots", async () => {
  const db = await createStore();
  let now = Date.parse("2026-10-02T07:59:00Z"),
    fail = true;
  const enqueue = async (owner: string, raw: unknown, key: string) => {
    if (fail) {
      fail = false;
      throw new Error("process exit before enqueue");
    }
    const value = { id: key, status: "queued", input: raw };
    await db.insertIfAbsent(owner, "tasks", value);
    return value;
  };
  try {
    const routines = new RoutinesService(db, enqueue, "UTC", () => now);
    const saved = await routines.create(
      "wife",
      { title: "Agenda", prompt: "Today's agenda", cron: "0 8 * * 1-5" },
      "one",
    );
    now = Date.parse("2026-10-02T08:00:00Z");
    await assert.rejects(() => routines.tick(), /process exit/);
    assert.ok((await routines.get("wife", saved.id)).pending);
    await Promise.all([routines.tick(), new RoutinesService(db, enqueue, "UTC", () => now).tick()]);
    assert.equal((await db.list("wife", "tasks")).length, 1);
    assert.equal((await routines.get("wife", saved.id)).nextRunAt, "2026-10-05T08:00:00.000Z");
    await assert.rejects(() => routines.get("other", saved.id), /not found/);
    await routines.update("wife", saved.id, { enabled: false });
    now = Date.parse("2026-10-05T08:00:00Z");
    await routines.tick();
    assert.equal((await db.list("wife", "tasks")).length, 1);
    await routines.remove("wife", saved.id);
    assert.equal((await routines.list("wife")).length, 0);
  } finally {
    await db.close();
  }
});

test("persistent facts deduplicate, inject bounded data, recall and forget by owner", async () => {
  const db = await createStore();
  try {
    const memory = new MemoryService(db);
    const fact = await memory.save("wife", "I prefer morning meetings", "User");
    assert.equal((await memory.save("wife", "I prefer morning meetings", "User")).id, fact.id);
    assert.equal((await memory.recall("wife", "morning"))[0]?.id, fact.id);
    assert.deepEqual(await memory.recall("other", "morning"), []);
    assert.match(await memory.context("wife"), /morning meetings/);
    await assert.rejects(() => memory.forget("other", fact.id), /not found/);
    await memory.forget("wife", fact.id);
    assert.deepEqual(await memory.recall("wife", "morning"), []);
  } finally {
    await db.close();
  }
});

test("remembering an edited fact saves the requested text and deduplicates current content", async () => {
  const db = await createStore();
  try {
    const memory = new MemoryService(db);
    const original = await memory.save("wife", "I prefer morning meetings", "User");
    await db.compareAndSwap(
      "wife",
      "memories",
      original.id,
      {},
      {
        text: "I prefer evening meetings",
      },
    );
    const remembered = await memory.save("wife", "I prefer morning meetings", "User");
    assert.equal(remembered.text, "I prefer morning meetings");
    assert.notEqual(remembered.id, original.id);
    assert.equal((await memory.save("wife", "I prefer evening meetings")).id, original.id);
    const saves = await Promise.all([
      memory.save("wife", "I prefer morning meetings"),
      new MemoryService(db).save("wife", "I prefer morning meetings"),
    ]);
    assert.ok(saves.every((fact) => fact.id === remembered.id));
    assert.equal((await memory.recall("wife")).length, 2);
    const concurrent = await Promise.all([
      memory.save("wife", "My timezone is Europe/Berlin"),
      new MemoryService(db).save("wife", "My timezone is Europe/Berlin"),
    ]);
    assert.equal(concurrent[0].id, concurrent[1].id);
    await memory.forget("wife", concurrent[0].id);
    await memory.forget("wife", original.id);
    // Forgetting suppresses both the raw current text and its recorded prior version,
    // including the old-text copy recovered before the forget.
    assert.deepEqual(await memory.recall("wife"), []);
    await assert.rejects(memory.save("wife", remembered.text), /forgotten|suppressed/i);
    await assert.rejects(memory.save("wife", "I prefer evening meetings"), /forgotten|suppressed/i);
    assert.equal((await memory.save("other", "I prefer morning meetings")).text, remembered.text);
  } finally {
    await db.close();
  }
});

test("concurrent different routine intents sharing a create key conflict; a deleted key never recreates a routine", async (t) => {
  const db = await createStore();
  let entries = 0,
    release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const insert = db.insertIfAbsent.bind(db);
  t.mock.method(
    db,
    "insertIfAbsent",
    async <T extends { id: string }>(owner: string, kind: string, value: T): Promise<T | null> => {
      if (kind === "routines") {
        entries++;
        if (entries === 2) release();
        if (entries <= 2) await barrier;
      }
      return insert(owner, kind, value);
    },
  );
  try {
    const routines = new RoutinesService(db, async () => ({ id: "unused" }));
    const results = await Promise.allSettled([
      routines.create(
        "wife",
        { title: "Agenda", prompt: "Read agenda", cron: "0 8 * * 1-5" },
        "same-key",
      ),
      routines.create(
        "wife",
        { title: "Mail", prompt: "Read mail", cron: "0 8 * * 1-5" },
        "same-key",
      ),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const failed = results.find((result) => result.status === "rejected");
    assert.ok(failed && failed.status === "rejected");
    assert.match(failed.reason.message, /different|conflict/);
    const winner = results.find((result) => result.status === "fulfilled");
    assert.ok(winner && winner.status === "fulfilled");
    await routines.remove("wife", winner.value.id);
    await assert.rejects(
      () =>
        routines.create(
          "wife",
          { title: winner.value.title, prompt: winner.value.prompt, cron: winner.value.cron },
          "same-key",
        ),
      /deleted|new request key/,
    );
    assert.deepEqual(await routines.list("wife"), []);
  } finally {
    await db.close();
  }
});

test("an oversized HTTP/legacy fact cannot blank later short preferences in bounded context", async () => {
  const db = await createStore();
  try {
    const memory = new MemoryService(db);
    await memory.save("wife", "I prefer morning meetings", "User");
    const large = await memory.save("wife", "x".repeat(12000), "HTTP memory");
    assert.equal((await memory.recall("wife"))[0].id, large.id);
    const context = await memory.context("wife");
    assert.match(context, /morning meetings/);
    assert.match(context, /"truncated":true/);
    assert.ok(context.length < 8200, "context budget includes fact IDs, source and timestamps");
    assert.equal(
      (await memory.recall("wife", large.id))[0].text.length,
      12000,
      "stored memory remains complete",
    );
  } finally {
    await db.close();
  }
});

test("routine partial edits preserve pause and explicit resume remains required", async () => {
  const db = await createStore();
  try {
    const routines = new RoutinesService(db, async () => ({ id: "unused" }));
    const saved = await routines.create("wife", {
      title: "Paused",
      prompt: "Send email",
      cron: "0 8 * * *",
      enabled: false,
    });
    for (const patch of [
      { title: "Renamed paused email" },
      { title: "Mobile edit", prompt: "Send agenda", cron: "0 9 * * *", timezone: "Europe/Berlin" },
    ]) {
      assert.equal((await routines.update("wife", saved.id, patch)).enabled, false);
    }
    assert.equal((await routines.update("wife", saved.id, { enabled: true })).enabled, true);
    assert.equal((await routines.update("wife", saved.id, { enabled: false })).enabled, false);
    assert.equal(
      (
        await routines.create("wife", {
          title: "Default",
          prompt: "Read agenda",
          cron: "0 8 * * *",
        })
      ).enabled,
      true,
    );
  } finally {
    await db.close();
  }
});
