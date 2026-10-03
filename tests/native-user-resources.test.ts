import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { createStore } from "../apps/server/src/db.ts";
import { HostResources } from "../apps/server/src/executors/host-resources.ts";
import { ExecutorRegistry } from "../apps/server/src/executors/registry.ts";
import { authority, hello, readiness, registration } from "./helpers/executors.ts";

test("native aggregate budget leaves physical host reserve without per-user eight GiB caps", () => {
  const budget = HostResources.aggregateBudget(16 * 1024 ** 3, 3 * 1024 ** 3);
  assert.equal(budget.memoryMaxBytes, 13 * 1024 ** 3);
  assert.ok(budget.memoryMaxBytes > 9 * 1024 ** 3);
  assert.throws(() => HostResources.aggregateBudget(16 * 1024 ** 3, 1 * 1024 ** 3), /reserve/);
});

test("native Python contracts exercise local journals/transfers/resources with injected services", {
  timeout: 20000,
}, async () => {
  const result = await promisify(execFile)(
    "python3",
    ["-m", "unittest", "apps.computer.executor.test_contracts"],
    {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
      timeout: 18000,
    },
  );
  assert.match(result.stderr, /OK/);
  assert.doesNotMatch(result.stderr, /skipped=/);
});

test("heartbeat does not imply display/input/browser readiness and full trust defeats containment claim", async () => {
  const db = await createStore();
  try {
    const registry = new ExecutorRegistry(db, {
      registrations: [registration],
      authority: authority(db),
    });
    const { epoch } = await registry.register(hello);
    const resources = {
      hostId: "lenovo",
      memoryTotalBytes: 16 * 1024 ** 3,
      memoryAvailableBytes: 10 * 1024 ** 3,
      botsCurrentBytes: 9 * 1024 ** 3,
      botsHighBytes: 11 * 1024 ** 3,
      botsMaxBytes: 12 * 1024 ** 3,
      pressure: "some avg10=0.10 avg60=0.20",
      heavyOwner: "job-a",
    };
    await registry.heartbeat(
      "lenovo-okami",
      epoch,
      { ...readiness, resources, containmentGuaranteed: true },
      { epoch, revision: 0, contained: true, guaranteed: true },
    );
    const node = await registry.node("lenovo-okami");
    assert.ok(node);
    assert.equal(node.connected, true);
    assert.equal(node.hello.readiness.display.state, "unavailable");
    assert.equal(node.hello.readiness.input.state, "unavailable");
    assert.equal(node.hello.readiness.browser.state, "starting");
    assert.equal(node.hello.readiness.containmentGuaranteed, false);
    assert.equal(node.pauseAck?.guaranteed, false);
    const snapshot = await new HostResources(db).snapshot("lenovo");
    assert.equal(snapshot.botsCurrentBytes, 9 * 1024 ** 3);
    assert.equal(snapshot.heavyOwner, "job-a");
    await assert.rejects(new HostResources(db).snapshot("unknown"), /unavailable/);
  } finally {
    await db.close();
  }
});
