import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { URL } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
async function fixture() {
  let stored = { id: "installation", enabled: true },
    registered = false;
  let rotation: (value: { data: string }) => void = () => {};
  const token = deferred<{ data: string }>();
  const posts: ReturnType<typeof deferred<void>>[] = [];
  const calls: string[] = [];
  let holdPosts = false;
  const api = {
    request: async (path: string) => {
      calls.push(path);
      if (path.endsWith("/delete")) registered = false;
      else {
        if (holdPosts) {
          const post = deferred<void>();
          posts.push(post);
          await post.promise;
        }
        registered = true;
      }
      return { configured: true };
    },
  };
  const exports = {} as {
    startNativePush: (_api: typeof api, tap: () => void) => () => void;
    enableNativePush: (_api: typeof api, enabled: boolean) => Promise<string>;
  };
  const source = await readFile(new URL("../src/native-push.native.ts", import.meta.url), "utf8");
  runInNewContext(
    ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    {
      exports,
      crypto: globalThis.crypto,
      require: (name: string) => {
        if (name === "react-native") return { Platform: { OS: "ios" } };
        if (name === "expo-file-system")
          return {
            Paths: { document: "doc" },
            File: class {
              exists = true;
              textSync() {
                return JSON.stringify(stored);
              }
              write(value: string) {
                stored = JSON.parse(value);
              }
            },
          };
        if (name === "expo-notifications")
          return {
            setNotificationHandler() {},
            getPermissionsAsync: async () => ({ granted: true }),
            requestPermissionsAsync: async () => ({ granted: true }),
            getDevicePushTokenAsync: () => token.promise,
            addPushTokenListener: (callback: typeof rotation) => {
              rotation = callback;
              return { remove() {} };
            },
            addNotificationResponseReceivedListener: () => ({ remove() {} }),
            getLastNotificationResponseAsync: async () => null,
          };
        throw new Error(name);
      },
    },
  );
  return {
    api,
    exports,
    token,
    posts,
    calls,
    rotation: (data: string) => rotation({ data }),
    hold: () => {
      holdPosts = true;
    },
    state: () => ({ stored, registered }),
  };
}

test("native Disable invalidates startup token acquisition", async () => {
  const f = await fixture();
  f.exports.startNativePush(f.api, () => {});
  await flush();
  await f.exports.enableNativePush(f.api, false);
  f.token.resolve({ data: "old-token" });
  await flush();
  assert.equal(f.state().stored.enabled, false);
  assert.equal(f.state().registered, false);
});

test("native Disable waits for old POST then revokes; new enable survives stale cleanup", async () => {
  const f = await fixture();
  f.hold();
  const oldCleanup = f.exports.startNativePush(f.api, () => {});
  f.token.resolve({ data: "token" });
  await flush();
  assert.equal(f.posts.length, 1);
  let disabled = false;
  const disable = f.exports.enableNativePush(f.api, false).then(() => {
    disabled = true;
  });
  await flush();
  assert.equal(disabled, false, "Disable must join an already dispatched registration");
  f.posts[0].resolve();
  await disable;
  assert.equal(f.state().registered, false);
  f.exports.startNativePush(f.api, () => {});
  const enable = f.exports.enableNativePush(f.api, true);
  await flush();
  f.posts[1].resolve();
  await enable;
  oldCleanup();
  await flush();
  assert.equal(f.state().registered, true);
});

test("logout orders revocation after rotation and invalidates late startup", async () => {
  const f = await fixture();
  const cleanup = f.exports.startNativePush(f.api, () => {});
  f.hold();
  f.rotation("rotated-token");
  await flush();
  cleanup();
  await flush();
  f.posts[0].resolve();
  f.token.resolve({ data: "older-token" });
  await flush();
  assert.equal(f.state().registered, false);
  assert.equal(f.calls.at(-1), "/api/agent/push/devices/installation/delete");
});

test("native explicit Enable cannot reinstate consent after a later Disable", async () => {
  const f = await fixture();
  const enable = f.exports.enableNativePush(f.api, true);
  await flush();
  await f.exports.enableNativePush(f.api, false);
  f.token.resolve({ data: "late-enable-token" });
  await enable;
  assert.equal(f.state().stored.enabled, false);
  assert.equal(f.state().registered, false);
});
