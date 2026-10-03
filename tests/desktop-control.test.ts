import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { currentComputerResourceScope } from "../apps/server/src/computer-resource-scope.ts";
import { createStore } from "../apps/server/src/db.ts";
import { DesktopService, type DesktopTransport } from "../apps/server/src/desktop-service.ts";
import { ResourceLeases } from "../apps/server/src/engine/resource-leases.ts";

const binding = {
  id: randomUUID(),
  sessionGeneration: randomUUID(),
  browserSessionId: randomUUID(),
  profileId: "personal",
  executorId: "lenovo-bot",
  hostId: "lenovo",
  osAccountId: "1003",
  executorEpoch: 3,
  width: 640,
  height: 360,
};
async function fixture(t: TestContext) {
  const db = await createStore();
  const dataDir = await mkdtemp(join(tmpdir(), "okami-desktop-control-"));
  const deviceId = randomUUID();
  await db.put("system", "device-sessions", { id: deviceId, owner: "owner", revokedAt: null });
  const calls: { kind: string; args: Record<string, unknown>; keys: string[] }[] = [];
  let frameId = randomUUID();
  const transport: DesktopTransport = {
    async session(owner) {
      assert.equal(owner, "owner");
      return binding;
    },
    async request(owner, session, kind, args) {
      assert.equal(session.id, binding.id);
      const handles = await Promise.all(
        (currentComputerResourceScope(owner)?.leases ?? []).map((lease) =>
          db.get<{ request: { key: string } }>("__runtime__", "resource-leases", lease.id),
        ),
      );
      calls.push({ kind, args, keys: handles.map((lease) => lease?.request.key ?? "") });
      if (args.operation === "observe") {
        frameId = randomUUID();
        return {
          sessionGeneration: binding.sessionGeneration,
          frameId,
          width: 640,
          height: 360,
          sequence: calls.length,
          observedAt: new Date().toISOString(),
          imageHash: "a".repeat(64),
          imageUnchanged: false,
          mimeType: "image/png",
          image: Buffer.from("fixture png").toString("base64"),
        };
      }
      if (args.operation === "act") {
        assert.equal((args.binding as { frameId: string }).frameId, frameId);
        return {
          inputDelivered: true,
          sessionGeneration: binding.sessionGeneration,
          observedFrameId: frameId,
          action: "click",
          cleanupConfirmed: true,
        };
      }
      return { reset: true, cleanupConfirmed: true };
    },
  };
  const service = new DesktopService(db, dataDir, transport);
  t.after(async () => {
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { db, service, calls, deviceId };
}

test("desktop observation does not reserve GUI; human reservation excludes both GUI and DOM", async (t) => {
  const { db, service, calls, deviceId } = await fixture(t);
  const frame = await service.observe("owner", binding.id);
  assert.equal(frame.sessionGeneration, binding.sessionGeneration);
  const control = await service.takeControl("owner", binding.id, deviceId);
  assert.equal(control.control, "human");
  assert.equal(
    calls[0].keys.some((key) => key.startsWith("desktop:")),
    false,
  );
  const requests = service.inputResources(binding);
  assert.equal(await new ResourceLeases(db).acquire("owner", "competing-dom", requests), null);
  await assert.rejects(
    service.act("owner", binding.id, {
      sessionGeneration: frame.sessionGeneration,
      frameId: frame.frameId,
      width: frame.width,
      height: frame.height,
      action: { action: "click", x: 10, y: 10 },
    }),
    /under human control/,
  );
  await service.releaseControl("owner", binding.id, deviceId, control.grantId!);
  assert.ok(await new ResourceLeases(db).acquire("owner", "resumed-dom", requests));
});

test("human input is bound to device, grant, generation, dimensions and rendered frame", async (t) => {
  const { db, service, calls, deviceId } = await fixture(t);
  const control = await service.takeControl("owner", binding.id, deviceId);
  const frame = await service.observe("owner", binding.id);
  const input = {
    sessionGeneration: frame.sessionGeneration,
    frameId: frame.frameId,
    width: frame.width,
    height: frame.height,
    action: { action: "click", x: 20, y: 30 },
  };
  await assert.rejects(
    service.humanAct("owner", binding.id, randomUUID(), control.grantId!, input),
    /device|grant/,
  );
  await assert.rejects(
    service.humanAct("owner", binding.id, deviceId, control.grantId!, { ...input, width: 641 }),
    /dimensions|frame/,
  );
  await service.humanAct("owner", binding.id, deviceId, control.grantId!, input);
  assert.equal(calls.at(-1)?.args.actor, "human");
  await db.compareAndSwap("system", "device-sessions", deviceId, {}, { revokedAt: Date.now() });
  await assert.rejects(
    service.humanAct("owner", binding.id, deviceId, control.grantId!, input),
    /revoked/,
  );
});

test("handback wakes only the matching durable task and reconnect rejects an old grant", async (t) => {
  const { service, deviceId } = await fixture(t);
  const resumed: string[] = [];
  service.configureWake(async (_owner, sessionId) => {
    resumed.push(sessionId);
  });
  const first = await service.takeControl("owner", binding.id, deviceId);
  await service.releaseControl("owner", binding.id, deviceId, first.grantId!);
  const second = await service.takeControl("owner", binding.id, deviceId);
  await assert.rejects(
    service.releaseControl("owner", binding.id, deviceId, first.grantId!),
    /grant/,
  );
  assert.deepEqual(resumed, [binding.browserSessionId]);
  assert.notEqual(first.grantId, second.grantId);
});
