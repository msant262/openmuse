import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { readDesktop } from "../src/desktop-requests.ts";

const require = createRequire(import.meta.url);
const NativeAbortController = createRequire(require.resolve("react-native/package.json"))(
  "abort-controller",
).AbortController;

test("React Native cancellation supports successful reads, takeover and timeout without modern AbortSignal methods", async (t) => {
  const original = globalThis.AbortController;
  globalThis.AbortController = NativeAbortController;
  t.after(() => {
    globalThis.AbortController = original;
  });
  const controller = new AbortController();
  assert.equal(typeof controller.signal.throwIfAborted, "undefined");
  assert.equal(await readDesktop(async () => "frame", 50, controller.signal), "frame");
  let transportSignal: AbortSignal | undefined;
  const pending = readDesktop(
    (signal) => {
      transportSignal = signal;
      return new Promise<never>(() => {});
    },
    1000,
    controller.signal,
  );
  controller.abort();
  await assert.rejects(pending, /Desktop preview interrupted/);
  assert.equal(transportSignal?.aborted, true);
  await assert.rejects(
    readDesktop(() => new Promise<never>(() => {}), 5),
    /Desktop preview timed out/,
  );
  let calls = 0;
  await assert.rejects(
    readDesktop(
      async () => {
        calls++;
      },
      50,
      controller.signal,
    ),
    /Desktop preview interrupted/,
  );
  assert.equal(calls, 0);
});

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

test("a timed out desktop read cancels its transport instead of leaving a live capture", async () => {
  let cancelled = false;
  await assert.rejects(
    readDesktop(
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            cancelled = true;
            reject(signal.reason);
          });
        }),
      5,
    ),
    /Desktop preview timed out/,
  );
  assert.equal(cancelled, true);
});

test("superseding a preview releases the read immediately without waiting for its deadline", async () => {
  const controller = new AbortController();
  const reason = new Error("A fresh control grant superseded this observation");
  let transportSignal: AbortSignal | undefined;
  const read = readDesktop(
    (signal) => {
      transportSignal = signal;
      return new Promise<never>(() => {});
    },
    12_000,
    controller.signal,
  );
  controller.abort(reason);
  await assert.rejects(read, (error) => error === reason);
  assert.equal(transportSignal?.aborted, true);
});

test("a preview already superseded at dispatch never calls the transport", async () => {
  const controller = new AbortController();
  const reason = new Error("Viewer closed");
  controller.abort(reason);
  let calls = 0;
  await assert.rejects(
    readDesktop(
      async () => {
        calls++;
        return "stale";
      },
      50,
      controller.signal,
    ),
    (error) => error === reason,
  );
  assert.equal(calls, 0);
});
