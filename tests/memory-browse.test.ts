import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { MemoryService } from "../apps/server/src/memory.ts";

test("memory management filters before pagination and keeps forgotten facts out of saved results", async () => {
  const db = await createStore();
  const memory = new MemoryService(db);
  try {
    const active = await memory.save("owner", "Prefiro chá de manhã");
    const forgotten = await memory.save("owner", "Prefiro café de tarde");
    await memory.forget("owner", forgotten.id, { expectedRevision: 1, requestId: "forget" });
    const expired = await memory.save("owner", "Plano antigo de viagem", "User", {
      validUntil: "2020-01-01T00:00:00Z",
    });
    await memory.save("other", "Preferência privada");
    assert.deepEqual(
      (await memory.page("owner", { status: "active", limit: 1 })).entries.map((m) => m.id),
      [active.id],
    );
    assert.deepEqual(
      (
        await memory.page("owner", { status: "forgotten", includeInactive: true, limit: 1 })
      ).entries.map((m) => m.id),
      [forgotten.id],
    );
    assert.deepEqual(
      (
        await memory.page("owner", { status: "expired", includeInactive: true, limit: 1 })
      ).entries.map((m) => m.id),
      [expired.id],
    );
    const first = await memory.page("owner", { includeInactive: true, limit: 1 });
    assert.ok(first.nextCursor);
    const second = await memory.page("owner", {
      includeInactive: true,
      limit: 1,
      cursor: first.nextCursor,
    });
    assert.notEqual(first.entries[0].id, second.entries[0].id);
    assert.equal(
      (await memory.page("owner", { status: "forgotten", includeInactive: true, query: "chá" }))
        .entries.length,
      0,
    );
    assert.equal(
      (await memory.page("owner", { includeInactive: true, query: "privada" })).entries.length,
      0,
    );
  } finally {
    await db.close();
  }
});
