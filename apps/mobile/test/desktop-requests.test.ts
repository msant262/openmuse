import assert from "node:assert/strict";
import test from "node:test";
import { readDesktop } from "../src/desktop-requests.ts";

test("a stalled desktop observation has a finite deadline and is never replayed", async () => {
  let calls = 0;
  let finish!: (value: string) => void;
  const response = new Promise<string>((resolve) => {
    finish = resolve;
  });
  await assert.rejects(
    readDesktop(() => {
      calls++;
      return response;
    }, 5),
    /Desktop preview timed out/,
  );
  finish("late frame");
  assert.equal(calls, 1);
});

test("desktop reads preserve successful data and authentication errors", async () => {
  assert.deepEqual(await readDesktop(async () => ({ frameId: "fresh" }), 20), {
    frameId: "fresh",
  });
  const denied = new Error("This device was revoked");
  await assert.rejects(
    readDesktop(async () => Promise.reject(denied), 20),
    (error) => error === denied,
  );
});
