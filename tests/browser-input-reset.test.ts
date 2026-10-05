import assert from "node:assert/strict";
import test from "node:test";
import { resetBrowserInput } from "../apps/worker/src/browser.ts";

test("a human-closed browser does not block releasing desktop input", async () => {
  let called = false;
  const up = async () => {
    called = true;
    throw new Error("Target closed");
  };
  await resetBrowserInput({ isClosed: () => true, keyboard: { up }, mouse: { up } } as never);
  assert.equal(called, false);
});

test("closing a tab during control transfer is distinct from a failed release on a live tab", async () => {
  let closed = false;
  const error = new Error("Input unavailable");
  const up = async () => {
    closed = true;
    throw error;
  };
  await resetBrowserInput({ isClosed: () => closed, keyboard: { up }, mouse: { up } } as never);
  await assert.rejects(
    resetBrowserInput({ isClosed: () => false, keyboard: { up }, mouse: { up } } as never),
    error,
  );
});
