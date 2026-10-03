import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { desktopPoint, renderDesktopFrame } from "../apps/mobile/src/desktop-state.ts";

test("trusted desktop viewer renders only matching newest generation and never invents unchanged pixels", () => {
  const session = {
    id: randomUUID(),
    browserSessionId: randomUUID(),
    sessionGeneration: randomUUID(),
    profileId: "personal",
    width: 1280,
    height: 720,
  };
  const frame = {
    sessionGeneration: session.sessionGeneration,
    frameId: randomUUID(),
    sequence: 1,
    observedAt: new Date().toISOString(),
    width: 1280,
    height: 720,
    imageHash: "a".repeat(64),
    imageUnchanged: false,
    mimeType: "image/png" as const,
    image: "cG5n",
  };
  const first = renderDesktopFrame(session, undefined, frame)!;
  assert.equal(first.uri, "data:image/png;base64,cG5n");
  const fresh = {
    ...frame,
    imageUnchanged: true,
    image: undefined,
    sequence: 2,
    frameId: randomUUID(),
  };
  assert.equal(renderDesktopFrame(session, first, fresh)?.frame.frameId, fresh.frameId);
  assert.equal(renderDesktopFrame(session, undefined, fresh), undefined);
  assert.equal(
    renderDesktopFrame(session, first, { ...frame, sessionGeneration: randomUUID() }),
    undefined,
  );
  assert.equal(renderDesktopFrame(session, first, { ...frame, width: 1279 }), undefined);
  assert.equal(renderDesktopFrame(session, first, { ...frame, sequence: 1 }), first);
  const paused = renderDesktopFrame(session, first, { ...frame, paused: true });
  assert.equal(paused?.uri, first.uri);
  assert.equal(paused?.frame.paused, true);
  assert.equal(desktopPoint(paused!.frame, 10, 10, { width: 640, height: 360 }), undefined);
});

test("desktop input maps the zoomed rendered image and rejects coordinates outside it", () => {
  const frame = {
    sessionGeneration: randomUUID(),
    frameId: randomUUID(),
    sequence: 1,
    observedAt: new Date().toISOString(),
    width: 1280,
    height: 720,
    imageHash: "b".repeat(64),
    imageUnchanged: true,
  };
  assert.deepEqual(desktopPoint(frame, 320, 180, { width: 640, height: 360 }), { x: 640, y: 360 });
  assert.deepEqual(desktopPoint(frame, 640, 360, { width: 1280, height: 720 }), { x: 640, y: 360 });
  assert.equal(desktopPoint(frame, 640, 360, { width: 640, height: 360 }), undefined);
  assert.equal(desktopPoint(frame, -1, 30, { width: 640, height: 360 }), undefined);
});
