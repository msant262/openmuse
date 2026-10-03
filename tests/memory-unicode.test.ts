import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore, Store } from "../apps/server/src/db.ts";
import { MemoryService } from "../apps/server/src/memory.ts";

for (const text of ["I live in İstanbul", "My location is ΟΣ"]) {
  test(`historical suppression excludes recovered Unicode copy: ${text}`, async () => {
    const db = await createStore();
    try {
      const memory = new MemoryService(db);
      const original = await memory.save("owner", text);
      await memory.update("owner", original.id, {
        text: "A different fact",
        expectedRevision: 1,
        requestId: "edit",
      });
      await memory.save("owner", text, "Recovered conversation");
      await memory.forget("owner", original.id, { expectedRevision: 2, requestId: "forget" });
      assert.deepEqual(await memory.recall("owner"), []);
    } finally {
      await db.close();
    }
  });
}

test("explicitly restored Unicode fact can retain its text while correcting provenance", async () => {
  const db = await createStore();
  try {
    const memory = new MemoryService(db);
    const fact = await memory.save("owner", "I live in İstanbul");
    await memory.forget("owner", fact.id, { expectedRevision: 1, requestId: "forget" });
    const restored = await memory.restore("owner", fact.id, {
      revision: 1,
      expectedRevision: 2,
      requestId: "restore",
      allowForgotten: true,
    });
    assert.ok(restored.revision !== undefined);
    const updated = await memory.update("owner", fact.id, {
      text: fact.text,
      source: "User corrected source",
      expectedRevision: restored.revision,
      requestId: "source",
    });
    assert.equal(updated.text, fact.text);
    assert.equal((await memory.recall("owner"))[0]?.id, fact.id);
  } finally {
    await db.close();
  }
});

// Instrument the real SQL boundary to exercise races without weakening production APIs.
function backend(db: Store) {
  return (db as unknown as { db: ConstructorParameters<typeof Store>[0] }).db;
}

test("legacy repair is owner-scoped and bounded, preserves revisions and paging order", async () => {
  const db = await createStore();
  try {
    for (const owner of ["owner", "other"])
      for (let i = 0; i < (owner === "owner" ? 205 : 1); i++)
        await db.put(owner, "memories", {
          id: `legacy-${String(i).padStart(3, "0")}`,
          text: `Ιstanbul ${i}`,
          source: "User",
          createdAt: "2026-10-02T10:00:00Z",
          revision: 4,
        });
    const query = backend(db).query.bind(backend(db));
    const before = await query(
      "SELECT jsonb_build_object('id',id,'updatedAt',updated_at) AS data FROM records WHERE owner='owner' AND kind='memories' ORDER BY updated_at DESC,id DESC",
    );
    const batches: number[] = [];
    const wrapped = new Store({
      query: async (sql, params) => {
        if (sql.startsWith("UPDATE records fact SET data=fact.data"))
          batches.push(JSON.parse(params?.[1] as string).length);
        return query(sql, params);
      },
      close: async () => {},
    });
    await new MemoryService(wrapped).recall("owner");
    assert.deepEqual(batches, [100, 100, 5]);
    assert.deepEqual(
      await query(
        "SELECT jsonb_build_object('id',id,'updatedAt',updated_at) AS data FROM records WHERE owner='owner' AND kind='memories' ORDER BY updated_at DESC,id DESC",
      ),
      before,
    );
    assert.equal(
      (await db.get<{ revision: number }>("owner", "memories", "legacy-000"))?.revision,
      4,
    );
    assert.equal(
      (await db.get<{ fingerprintVersion?: string }>("other", "memories", "legacy-000"))
        ?.fingerprintVersion,
      undefined,
    );
    assert.deepEqual(await db.list("owner", "memory-history"), []);
  } finally {
    await db.close();
  }
});

test("concurrent raw text change cannot receive a stale fingerprint or escape suppression", async () => {
  const db = await createStore();
  try {
    const memory = new MemoryService(db);
    const forgotten = await memory.save("owner", "Forgotten İstanbul");
    await memory.forget("owner", forgotten.id, { expectedRevision: 1, requestId: "forget" });
    await db.put("owner", "memories", {
      id: "legacy",
      text: "Old legacy text",
      source: "User",
      createdAt: "2026-10-02T10:00:00Z",
      revision: 1,
    });
    let changed = false;
    const wrapped = new Store({
      query: async (sql, params) => {
        if (!changed && sql.startsWith("UPDATE records fact SET data=fact.data")) {
          changed = true;
          await db.compareAndSwap(
            "owner",
            "memories",
            "legacy",
            {},
            { text: forgotten.text, revision: 2 },
          );
        }
        return backend(db).query(sql, params);
      },
      close: async () => {},
    });
    const raced = new MemoryService(wrapped);
    assert.deepEqual(await raced.recall("owner"), []);
    const current = await db.get<{ text: string; revision: number; fingerprint?: string }>(
      "owner",
      "memories",
      "legacy",
    );
    assert.equal(current?.text, forgotten.text);
    assert.equal(current?.revision, 2);
    assert.equal(current?.fingerprint, undefined);
    assert.deepEqual(await raced.recall("owner"), []);
  } finally {
    await db.close();
  }
});

test("repair write failure fails recall and marks the stopped-writer snapshot unsafe", async () => {
  const db = await createStore();
  try {
    await db.put("owner", "memories", {
      id: "legacy",
      text: "Unversioned text",
      source: "User",
      createdAt: "2026-10-02T10:00:00Z",
    });
    let fail = true;
    const wrapped = new Store({
      query: async (sql, params) => {
        if (fail && sql.startsWith("UPDATE records fact SET data=fact.data"))
          throw Error("repair storage unavailable");
        return backend(db).query(sql, params);
      },
      close: async () => {},
    });
    await assert.rejects(new MemoryService(wrapped).recall("owner"), /repair storage unavailable/);
    assert.equal(wrapped.persistenceFailed, true);
    fail = false;
    assert.equal((await new MemoryService(wrapped).recall("owner"))[0]?.id, "legacy");
  } finally {
    await db.close();
  }
});

test("save refuses an unresolved repair race instead of creating a duplicate fact", async () => {
  const db = await createStore();
  try {
    await db.put("owner", "memories", {
      id: "legacy",
      text: "Earlier text",
      source: "User",
      createdAt: "2026-10-02T10:00:00Z",
      revision: 1,
    });
    let changed = false;
    const wrapped = new Store({
      query: async (sql, params) => {
        if (!changed && sql.startsWith("UPDATE records fact SET data=fact.data")) {
          changed = true;
          await db.compareAndSwap("owner", "memories", "legacy", {}, { text: "  İstanbul  " });
        }
        return backend(db).query(sql, params);
      },
      close: async () => {},
    });
    const memory = new MemoryService(wrapped);
    await assert.rejects(memory.save("owner", "İstanbul"), { status: 409 });
    assert.equal(wrapped.persistenceFailed, false);
    assert.equal((await db.list("owner", "memories")).length, 1);
    assert.equal((await memory.save("owner", "İstanbul")).id, "legacy");
    assert.equal((await db.list("owner", "memories")).length, 1);
  } finally {
    await db.close();
  }
});
