import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import {
  assessMonitor,
  MonitorObservations,
} from "../apps/server/src/engine/monitor-observations.ts";
import { observationContent } from "../apps/worker/src/observation-content.ts";
import type { AgentTask, Monitor } from "../packages/domain/src/agent.ts";

const owner = "owner";
const page = (text: string) => ({ url: "https://example.com/product", title: "Product", text });
const initial: Monitor = {
  id: "watch",
  taskId: "task",
  title: "Watch",
  url: page("").url,
  condition: "change",
  value: "",
  checks: 0,
  status: "active",
  intervalMinutes: 15,
  nextCheckAt: new Date().toISOString(),
};
test("monitor observations persist distinct occurrences, fence stale commits, and recover a failed publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "okami-monitor-occurrences-"));
  const db = await createStore({ dataDir: directory });
  try {
    const delivered = new Set<string>();
    let fail = false;
    const publish = async (
      _owner: string,
      _title: string,
      _body: string,
      _task: string,
      key: string,
    ) => {
      if (fail) {
        fail = false;
        throw new Error("publication interrupted");
      }
      delivered.add(key);
    };
    const observations = new MonitorObservations(db, publish);
    await db.put(owner, "monitors", initial);
    let sequence = 0;
    async function observe(text: string) {
      const task = { id: "task", status: "running", leaseId: `lease-${++sequence}` } as AgentTask;
      await db.put(owner, "tasks", task);
      const monitor = (await db.get<Monitor>(owner, "monitors", "watch"))!;
      await observations.commit(owner, task, monitor, page(text), initial.nextCheckAt);
      return { task, monitor };
    }
    const stale = await observe("A");
    await observe("B");
    await observe("A");
    await observe("B");
    assert.equal(delivered.size, 3, "A→B→A→B is three occurrences, regardless of repeated hashes");
    await assert.rejects(
      observations.commit(owner, stale.task, stale.monitor, page("old"), initial.nextCheckAt),
      /paused|taken over/,
    );
    assert.equal((await db.get<Monitor>(owner, "monitors", "watch"))?.checks, 4);
    fail = true;
    await assert.rejects(observe("C"), /publication interrupted/);
    assert.equal((await db.get<Monitor>(owner, "monitors", "watch"))?.checks, 5);
    await new MonitorObservations(db, publish).flush();
    await new MonitorObservations(db, publish).flush();
    assert.equal(delivered.size, 4);
    await observe("C");
    assert.equal(delivered.size, 4);
    const monitor = (await db.get<Monitor>(owner, "monitors", "watch"))!;
    const task = (await db.get<AgentTask>(owner, "tasks", "task"))!;
    await db.compareAndSwap(owner, "monitors", "watch", {}, { status: "stopped" });
    await assert.rejects(
      observations.commit(owner, task, monitor, page("D"), initial.nextCheckAt),
      /paused|taken over/,
    );
    assert.equal((await db.get<Monitor>(owner, "monitors", "watch"))?.status, "stopped");
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("monitor hashing detects changes beyond visible text and reports incomplete source coverage", () => {
  const text = "a".repeat(100_001);
  const first = observationContent({
    text: `${text}A`,
    sourceLength: text.length + 1,
    structured: [],
  });
  const second = observationContent({
    text: `${text}B`,
    sourceLength: text.length + 1,
    structured: [],
  });
  assert.equal(first.text, second.text);
  assert.notEqual(first.contentHash, second.contentHash);
  const observed = assessMonitor(
    { ...initial, lastHash: first.contentHash, lastValue: first.text.slice(0, 1000) },
    { ...page(""), ...second },
  );
  assert.equal(observed.matched, true);
  assert.match(observed.diff, /além da prévia/);
  const bounded = observationContent({
    text: "a".repeat(2_000_000),
    sourceLength: 2_000_001,
    structured: [],
  });
  assert.equal(bounded.contentHash, undefined);
  assert.match(assessMonitor(initial, { ...page(""), ...bounded }).uncertain, /parcial/);
});
test("price monitoring requires the exact product and currency and never treats shipping as its offer", () => {
  const content = observationContent({
    text: "Shipping $1; was $9; now €80",
    sourceLength: 33,
    structured: [
      JSON.stringify([
        { "@type": "ShippingDetails", price: 1, priceCurrency: "USD" },
        {
          "@type": "Product",
          name: "Notebook",
          offers: { "@type": "Offer", price: "80.00", priceCurrency: "EUR" },
        },
      ]),
    ],
  });
  const monitor: Monitor = {
    ...initial,
    condition: "price_below",
    value: "90",
    priceTarget: "Notebook",
    currency: "EUR",
  };
  assert.equal(assessMonitor(monitor, { ...page(""), ...content }).matched, true);
  assert.equal(
    assessMonitor({ ...monitor, currency: "USD" }, { ...page(""), ...content }).matched,
    false,
  );
  assert.match(assessMonitor(monitor, page("Shipping €1; old €20")).uncertain, /oferta/);
  assert.equal(
    assessMonitor(monitor, { ...page(""), products: [...content.products, ...content.products] })
      .matched,
    false,
  );
});
