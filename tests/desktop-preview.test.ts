import assert from "node:assert/strict";
import test from "node:test";
import { desktopPollDelay, inlinePreviewVisible } from "../apps/mobile/src/preview-policy.ts";

test("desktop preview stops while hidden, backs off unchanged pixels and renews before human permit expiry", () => {
  assert.equal(desktopPollDelay(false, 0), undefined);
  assert.equal(desktopPollDelay(false, 100), undefined);
  assert.equal(desktopPollDelay(true, 0), 1500);
  assert.equal(desktopPollDelay(true, 3), 6000);
  assert.ok(desktopPollDelay(true, 100)! < 30_000);
  assert.equal(inlinePreviewVisible(true, true, false), true);
  assert.equal(inlinePreviewVisible(false, true, false), false);
  assert.equal(inlinePreviewVisible(true, false, false), false);
  assert.equal(inlinePreviewVisible(true, true, true), false);
});

test("idle pixels cannot make a human-controlled desktop wait seconds for the next update", () => {
  const active = desktopPollDelay(true, 0, true);
  const idle = desktopPollDelay(true, 100, true);
  assert.ok(active !== undefined && active < 1000);
  assert.ok(idle !== undefined && idle < 1000);
  assert.equal(desktopPollDelay(false, 100, true), undefined);
});
