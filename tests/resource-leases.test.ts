import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { ResourceLeases } from "../apps/server/src/engine/resource-leases.ts";

test("resource lease fences reject stale holders and enforce shared/exclusive locks", async () => {
  const db = await createStore();
  let now = Date.parse("2026-10-02T10:00:00.000Z");
  const leases = new ResourceLeases(db, { now: () => now, leaseMs: 1_000 });
  try {
    const first = await leases.acquire("owner", "task-1", [
      { key: "browser-profile:lenovo:personal", units: 1, mode: "exclusive" },
    ]);
    assert.ok(first);
    assert.equal(first[0].fence, 1);
    assert.equal(
      await leases.acquire("owner", "task-2", [
        { key: "browser-profile:lenovo:personal", units: 1, mode: "exclusive" },
      ]),
      null,
    );

    now += 1_001;
    assert.equal(await leases.renew(first[0]), null, "an expired lease cannot renew its fence");
    const replacement = await leases.acquire("owner", "task-2", [
      { key: "browser-profile:lenovo:personal", units: 1, mode: "exclusive" },
    ]);
    assert.ok(replacement);
    assert.equal(replacement[0].fence, 2);
    await leases.release(first[0]);
    assert.equal(
      await leases.acquire("owner", "task-3", [
        { key: "browser-profile:lenovo:personal", units: 1, mode: "exclusive" },
      ]),
      null,
      "releasing an old fence cannot release its replacement",
    );
    await leases.release(replacement[0]);

    const readers = await Promise.all([
      leases.acquire("owner", "reader-1", [{ key: "files:shared", units: 1, mode: "shared" }]),
      leases.acquire("owner", "reader-2", [{ key: "files:shared", units: 1, mode: "shared" }]),
    ]);
    assert.ok(readers[0] && readers[1], "shared leases may overlap");
    assert.equal(
      await leases.acquire("owner", "writer", [
        { key: "files:shared", units: 1, mode: "exclusive" },
      ]),
      null,
      "an exclusive writer waits for active shared leases",
    );

    await assert.rejects(
      () =>
        leases.acquire("owner", "unsupported", [
          { key: "heavy:lenovo", units: 2, mode: "exclusive" },
        ]),
      { status: 422 },
    );
  } finally {
    await db.close();
  }
});

test("held resource leases preserve physical-job occupancy across expiry and restart", async () => {
  const db = await createStore();
  let now = Date.parse("2026-10-02T10:00:00.000Z");
  const firstWorker = new ResourceLeases(db, { now: () => now, leaseMs: 1_000 });
  const request = [{ key: "heavy:lenovo", units: 1, mode: "exclusive" as const }];
  try {
    const lease = await firstWorker.acquire("owner", "physical-job", request);
    assert.ok(lease);
    await firstWorker.holdTask("physical-job");
    now += 60_000;

    const restartedWorker = new ResourceLeases(db, { now: () => now, leaseMs: 1_000 });
    assert.equal(await restartedWorker.acquire("owner", "other-job", request), null);
    const recovered = await restartedWorker.acquire("owner", "physical-job", request);
    assert.deepEqual(recovered, lease, "the original fence is recoverable by task identity");
    assert.ok(await restartedWorker.renew(lease[0]), "held lease fences remain authoritative");
    await restartedWorker.releaseTask("physical-job");
    assert.ok(await restartedWorker.acquire("owner", "other-job", request));
  } finally {
    await db.close();
  }
});
