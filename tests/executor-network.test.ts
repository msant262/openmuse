import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Hono } from "hono";
import { createStore } from "../apps/server/src/db.ts";
import { executorHelloSchema } from "../apps/server/src/executors/protocol.ts";
import { ExecutorRegistry } from "../apps/server/src/executors/registry.ts";
import { executorRoutes } from "../apps/server/src/executors/routes.ts";
import {
  authority,
  context,
  hello,
  nodeToken,
  registration,
  request,
} from "./helpers/executors.ts";

test("node credential accesses only registered executor protocol, never another node or owner APIs", async () => {
  const db = await createStore();
  try {
    const other = {
      ...registration,
      executorId: "other",
      osAccountId: "1004",
      tokenHash: createHash("sha256")
        .update("other-token-which-is-at-least-thirty-two")
        .digest("hex"),
    };
    const registry = new ExecutorRegistry(db, {
      registrations: [registration, other],
      authority: authority(db),
    });
    const app = new Hono().route("/executor", executorRoutes(registry));
    const headers = { Authorization: `Bearer ${nodeToken}`, "Content-Type": "application/json" };
    assert.equal(
      (
        await app.request("/executor/lenovo-okami/register", {
          method: "POST",
          body: JSON.stringify(hello),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await app.request("/executor/other/register", {
          method: "POST",
          headers,
          body: JSON.stringify(hello),
        })
      ).status,
      401,
    );
    assert.equal(
      (await app.request("/executor/lenovo-okami/admin", { method: "POST", headers, body: "{}" }))
        .status,
      404,
    );
    const registered = await app.request("/executor/lenovo-okami/register", {
      method: "POST",
      headers,
      body: JSON.stringify(hello),
    });
    assert.equal(registered.status, 200);
    const { epoch } = await registered.json();
    assert.equal(
      (
        await app.request("/executor/lenovo-okami/reconcile", {
          method: "POST",
          headers,
          body: JSON.stringify({ epoch, bootId: "boot-a", operations: [], contained: true }),
        })
      ).status,
      200,
    );
    await registry.enqueue("owner", request(), context);
    const response = await app.request("/executor/lenovo-okami/claim", {
      method: "POST",
      headers,
      body: JSON.stringify({ epoch, waitMs: 0 }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).operations[0].id, request().id);
    assert.equal(
      (
        await app.request("/executor/lenovo-okami/receipt", {
          method: "POST",
          headers,
          body: JSON.stringify({
            epoch,
            operationId: request().id,
            sequence: -1,
            receipt: { status: "succeeded" },
          }),
        })
      ).status,
      422,
    );
  } finally {
    await db.close();
  }
});

test("wire fixtures negotiate old compatible protocol, defaults and capability semantic versions", async () => {
  const db = await createStore();
  try {
    const wire = JSON.parse(
      await readFile(new URL("./fixtures/executor-protocol-v1.json", import.meta.url), "utf8"),
    );
    const old = executorHelloSchema.parse(wire.hello);
    assert.equal(old.instanceId, undefined);
    const registry = new ExecutorRegistry(db, {
      registrations: [registration],
      authority: authority(db),
    });
    assert.equal((await registry.register(old)).protocolVersion, 1);
    await assert.rejects(
      registry.register({ ...hello, minProtocolVersion: 2, maxProtocolVersion: 3 }),
      /protocol.*update|update.*protocol/i,
    );
    await registry.register({ ...hello, capabilities: [{ name: "command", version: 2 }] });
    await assert.rejects(
      registry.enqueue("owner", request(), context),
      /capability.*version|semantic/i,
    );
  } finally {
    await db.close();
  }
});

test("long poll wakes for publication and expired watchdog never yields effects", async () => {
  const db = await createStore();
  let now = Date.now();
  try {
    const registry = new ExecutorRegistry(db, {
      registrations: [registration],
      authority: authority(db),
      now: () => now,
    });
    const { epoch } = await registry.register(hello);
    await registry.reconcile("lenovo-okami", {
      epoch,
      bootId: "boot-a",
      operations: [],
      contained: true,
    });
    const waiting = registry.claimOperations("lenovo-okami", epoch, { waitMs: 1000 });
    await registry.enqueue("owner", request(), context);
    assert.equal((await waiting).operations.length, 1);
    now += 41000;
    await registry.enqueue("owner", request("d".repeat(64)), context);
    assert.deepEqual((await registry.claimOperations("lenovo-okami", epoch)).operations, []);
    assert.equal((await registry.node("lenovo-okami"))?.connected, false);
  } finally {
    await db.close();
  }
});
