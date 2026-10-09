import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BrowserExecutorGate } from "../apps/worker/src/executor-gate.ts";
import { createWorkerServer } from "../apps/worker/src/server.ts";
import {
  type BrowserExecutorAuthorization,
  browserBodyHash,
  signBrowserExecutor,
} from "../packages/domain/src/browser-executor.ts";

test("VPS worker rejects old lifecycle, profile fences and changed arguments before browser dispatch", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "browser-executor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const token = "private-fixture-worker-token-32-characters",
    gate = new BrowserExecutorGate({
      token,
      dataDir: directory,
      executorId: "openmuse-server",
      instanceId: "boot-new",
    });
  let dispatches = 0;
  const authorization: BrowserExecutorAuthorization = {
    executorId: "openmuse-server",
    epoch: 2,
    instanceId: "boot-new",
    sessionId: "profile",
    profileId: "profile",
    sessionGeneration: "boot-new:profile",
    fence: 2,
    bindingFence: 2,
    taskId: "task",
    revision: 2,
    operationId: "act-1",
    expiresAt: Date.now() + 60000,
    operationClass: "mutable",
    method: "POST",
    path: "/sessions/profile/act",
    bodyHash: browserBodyHash("{}"),
  };
  const invoke = (value = authorization, body = "{}") =>
    gate.run(
      signBrowserExecutor(token, value),
      { sessionId: "profile", method: "POST", path: authorization.path, body },
      async () => {
        dispatches++;
        return { status: 200, data: { done: true } };
      },
    );
  assert.deepEqual(await invoke(), { status: 200, data: { done: true } });
  assert.deepEqual(await invoke(), { status: 200, data: { done: true } });
  assert.equal(dispatches, 1); // persisted receipt, no repeated external action
  await assert.rejects(
    invoke({ ...authorization, operationId: "old-epoch", instanceId: "boot-old" }),
    { code: "STALE_BROWSER_BINDING" },
  );
  await assert.rejects(invoke({ ...authorization, operationId: "old-fence", fence: 1 }), {
    code: "STALE_BROWSER_BINDING",
  });
  await assert.rejects(invoke(authorization, '{"value":"changed"}'), {
    code: "INVALID_BROWSER_AUTHORITY",
  });
  await assert.rejects(invoke({ ...authorization, operationId: "old-revision", revision: 1 }), {
    code: "STALE_BROWSER_BINDING",
  });
  assert.equal(dispatches, 1);
});
test("lost mutable receipt persists unknown and is not dispatched on retry or gate restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "browser-executor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    token: "private-worker-token-at-least-32-characters",
    dataDir: directory,
    executorId: "openmuse-server",
    instanceId: "boot",
  };
  const authorization: BrowserExecutorAuthorization = {
    executorId: options.executorId,
    epoch: 1,
    instanceId: "boot",
    sessionId: "profile",
    profileId: "profile",
    sessionGeneration: "boot:profile",
    fence: 1,
    bindingFence: 1,
    taskId: "task",
    revision: 0,
    operationId: "write",
    expiresAt: Date.now() + 60000,
    operationClass: "mutable",
    method: "POST",
    path: "/sessions/profile/act",
    bodyHash: browserBodyHash("{}"),
  };
  const request = { sessionId: "profile", method: "POST", path: authorization.path, body: "{}" },
    signed = signBrowserExecutor(options.token, authorization);
  let dispatched = 0;
  await assert.rejects(
    new BrowserExecutorGate(options).run(signed, request, async () => {
      dispatched++;
      throw new Error("connection lost after effect");
    }),
  );
  await assert.rejects(
    new BrowserExecutorGate(options).run(signed, request, async () => {
      dispatched++;
      return { status: 200, data: {} };
    }),
    { code: "OUTCOME_UNKNOWN" },
  );
  assert.equal(dispatched, 1);
});

test("real worker HTTP protocol authenticates handshake and fences stale snapshots before browser use", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "browser-worker-protocol-"));
  const token = "private-http-worker-token-32-characters",
    worker = await createWorkerServer({ token, dataDir: directory, requireBinding: true });
  worker.server.listen(0, "127.0.0.1");
  await once(worker.server, "listening");
  t.after(async () => {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  });
  const address = worker.server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/executor`)).status, 401);
  const handshake = (await (
    await fetch(`${base}/executor`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as {
    executorId: string;
    instanceId: string;
    capabilities: { name: string; version: number }[];
  };
  assert.equal(handshake.executorId, "openmuse-server");
  assert(
    handshake.capabilities.some((value) => value.name === "browser.dom" && value.version === 1),
  );
  assert(
    !handshake.capabilities.some((value) =>
      ["desktop", "command", "browser.pointer"].includes(value.name),
    ),
  );
  const sessionId = randomUUID(),
    path = `/sessions/${sessionId}/snapshot`;
  const authority: BrowserExecutorAuthorization = {
    executorId: handshake.executorId,
    epoch: 1,
    instanceId: "old-worker",
    sessionId,
    profileId: sessionId,
    sessionGeneration: `old-worker:${sessionId}`,
    fence: 1,
    bindingFence: 1,
    taskId: "task",
    revision: 0,
    operationId: "read",
    expiresAt: Date.now() + 60000,
    operationClass: "public_read",
    method: "GET",
    path,
    bodyHash: browserBodyHash(""),
  };
  const request = async (value: BrowserExecutorAuthorization) =>
    fetch(`${base}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-OpenMuse-Browser-Authority": signBrowserExecutor(token, value),
      },
    });
  const stale = await request(authority);
  assert.equal(stale.status, 409);
  assert.equal(
    ((await stale.json()) as { error: { code: string } }).error.code,
    "STALE_BROWSER_BINDING",
  );
  const fresh = await request({
    ...authority,
    instanceId: handshake.instanceId,
    sessionGeneration: `${handshake.instanceId}:${sessionId}`,
  });
  assert.equal(((await fresh.json()) as { error: { code: string } }).error.code, "SESSION_CLOSED"); // reached the real BrowserManager, no Chromium launch required
  const bytes = Buffer.alloc(90_000, "a");
  for (const [endpoint, payload, operationClass] of [
    ["back", {}, "mutable"],
    ["search", { query: "source", limit: 3 }, "public_read"],
    ["challenge", { action: { action: "check" } }, "mutable"],
    [
      "upload",
      {
        artifactId: "attachment",
        snapshotId: randomUUID(),
        element: 1,
        name: "file.txt",
        mimeType: "text/plain",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        base64: bytes.toString("base64"),
      },
      "mutable",
    ],
  ] as const) {
    const body = JSON.stringify(payload),
      endpointPath = `/sessions/${sessionId}/${endpoint}`;
    const signed = (classification: BrowserExecutorAuthorization["operationClass"]) =>
      signBrowserExecutor(token, {
        ...authority,
        instanceId: handshake.instanceId,
        sessionGeneration: `${handshake.instanceId}:${sessionId}`,
        method: "POST",
        path: endpointPath,
        bodyHash: browserBodyHash(body),
        operationId: randomUUID(),
        operationClass: classification,
      });
    const post = (classification: BrowserExecutorAuthorization["operationClass"]) =>
      fetch(`${base}${endpointPath}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-OpenMuse-Browser-Authority": signed(classification),
        },
        body,
      });
    // An unopened session reaches the correct handler, including upload bodies
    // above the normal JSON limit. The actual browser must reject the session.
    const result = await post(operationClass);
    assert.equal(
      ((await result.json()) as { error: { code: string } }).error.code,
      "SESSION_CLOSED",
      endpoint,
    );
    if (operationClass === "mutable") {
      const denied = await post("public_read");
      assert.equal(
        ((await denied.json()) as { error: { code: string } }).error.code,
        "INVALID_BROWSER_AUTHORITY",
      );
    }
  }
});
