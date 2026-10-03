import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ApiQuotas, apiQuotaClass } from "../apps/server/src/api-quotas.ts";
import { browserFallbackFixture } from "./helpers/browser-fallback.ts";

test("owner/device/route quotas reserve control and bound memory without trusting forwarding headers", () => {
  let now = 0;
  const quotas = new ApiQuotas({
    now: () => now,
    maxOwners: 4,
    maxDevices: 8,
    limits: { observe: { owner: 4, device: 2 } },
  });
  for (const device of ["viewer-one", "viewer-two"])
    for (let i = 0; i < 2; i++) assert.equal(quotas.take("owner", device, "observe"), 0);
  assert(quotas.take("owner", "viewer-three", "observe") > 0);
  assert.equal(quotas.take("owner", "viewer-one", "control"), 0);
  assert.equal(quotas.take("owner", "viewer-one", "chat"), 0);
  now = 60_001;
  assert.equal(quotas.take("owner", "viewer-one", "observe"), 0);
  for (let i = 0; i < 100; i++) quotas.take(`owner-${i}`, `device-${i}`, "observe");
  assert(quotas.size <= (4 + 8) * 6);
  assert.equal(apiQuotaClass("POST", "/api/desktop/viewers/abc/observe"), "observe");
  assert.equal(apiQuotaClass("POST", "/api/desktop/viewers/abc/take-control"), "control");
  assert.equal(apiQuotaClass("POST", "/api/computer/stop"), "control");
});

test("actual app keeps two devices, four task requests, uploads and Take control/Stop independent of exhausted polls", async (t) => {
  const quotas = new ApiQuotas({
    limits: { observe: { owner: 6, device: 3 }, upload: { owner: 2, device: 2 } },
  });
  const server = await browserFallbackFixture(t, { apiQuotas: quotas });
  const devices = await Promise.all([
    server.auth.session(undefined, "one"),
    server.auth.session(undefined, "two"),
  ]);
  const request = (device: number, path: string, body?: unknown, forwarded = "203.0.113.1") =>
    server.app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${devices[device].token}`,
        "Content-Type": "application/json",
        "X-Forwarded-For": forwarded,
        Forwarded: `for=${forwarded}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  for (const device of [0, 1]) {
    for (let i = 0; i < 3; i++) assert.equal((await request(device, "/api/desktop")).status, 200);
    const limited = await request(device, "/api/desktop", undefined, `198.51.100.${device + 4}`);
    assert.equal(limited.status, 429);
    assert(limited.headers.get("Retry-After"));
  }
  for (let i = 0; i < 4; i++)
    assert.equal(
      (await request(0, "/api/agent/tasks", { prompt: `Independent task ${i}` })).status,
      201,
    );
  for (let i = 0; i < 2; i++) assert.equal((await request(0, "/api/files", {})).status, 400);
  assert.equal((await request(0, "/api/files", {}, "192.0.2.99")).status, 429);
  const viewer = await request(0, "/api/desktop/viewers", { sessionId: server.session.id });
  assert.equal(viewer.status, 201);
  const opened = (await viewer.json()) as { viewerId: string };
  const secondViewer = await request(1, "/api/desktop/viewers", { sessionId: server.session.id });
  assert.equal(secondViewer.status, 201);
  const second = (await secondViewer.json()) as { viewerId: string };
  assert.notEqual(second.viewerId, opened.viewerId);
  const takeover = await request(0, `/api/desktop/viewers/${opened.viewerId}/take-control`, {
    sessionId: server.session.id,
    operationId: randomUUID(),
  });
  assert.equal(takeover.status, 200, await takeover.clone().text());
  const pause = await request(0, "/api/agent/runtime-pause", { paused: true, expectedRevision: 0 });
  assert.equal(pause.status, 200);
  const stop = await request(0, "/api/computer/stop", {});
  assert.notEqual(stop.status, 429);
});
