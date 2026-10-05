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
async function fixture(platform = "ios") {
  let stored = { id: "installation", enabled: true },
    registered = false;
  let rotation: (value: { data: string }) => void = () => {};
  const token = deferred<{ data: string }>();
  const posts: ReturnType<typeof deferred<void>>[] = [];
  const calls: string[] = [];
  const registrationTokens: string[] = [];
  let holdPosts = false;
  let registrationError = false;
  let resume: (state: string) => void = () => {};
  const api = {
    request: async (path: string, body?: { token: string }) => {
      calls.push(path);
      if (path.endsWith("/delete")) registered = false;
      else {
        if (registrationError) throw new Error("offline");
        if (holdPosts) {
          const post = deferred<void>();
          posts.push(post);
          await post.promise;
        }
        registered = true;
        registrationTokens.push(body?.token ?? "");
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
        if (name === "react-native")
          return {
            Platform: { OS: platform },
            AppState: {
              addEventListener: (_event: string, callback: typeof resume) => {
                resume = callback;
                return {
                  remove() {
                    resume = () => {};
                  },
                };
              },
            },
          };
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
            AndroidImportance: { DEFAULT: 3, HIGH: 4 },
            setNotificationChannelAsync: async () => {},
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
    registrationTokens,
    rotation: (data: string) => rotation({ data }),
    resume: () => resume("active"),
    offline: (value: boolean) => {
      registrationError = value;
    },
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

test("the first Android token event does not cancel an explicit notification enable", async () => {
  const f = await fixture("android");
  f.exports.startNativePush(f.api, () => {});
  const enabling = f.exports.enableNativePush(f.api, true);
  await flush();
  // Firebase emits onNewToken before resolving getDevicePushTokenAsync.
  f.rotation("fresh-fcm-token");
  f.token.resolve({ data: "fresh-fcm-token" });
  const status = await enabling;
  await flush();
  assert.equal(status, "Phone notifications enabled.");
  assert.equal(f.state().stored.enabled, true);
  assert.equal(f.state().registered, true);
});

test("a delayed startup token cannot replace a newer Firebase token", async () => {
  const f = await fixture("android");
  f.exports.startNativePush(f.api, () => {});
  await flush();
  f.rotation("new-fcm-token");
  await flush();
  f.token.resolve({ data: "obsolete-fcm-token" });
  await flush();
  assert.equal(f.registrationTokens.at(-1), "new-fcm-token");
  assert.equal(f.state().registered, true);
});

test("resuming Android recovers notification registration after a temporary startup outage", async () => {
  const f = await fixture("android");
  f.offline(true);
  const cleanup = f.exports.startNativePush(f.api, () => {});
  f.token.resolve({ data: "fcm-token" });
  await flush();
  assert.equal(f.state().registered, false);
  f.offline(false);
  f.resume();
  await flush();
  assert.equal(f.state().registered, true);
  cleanup();
  await flush();
  f.resume();
  await flush();
  assert.equal(f.state().registered, false, "a stopped session cannot resume registration");
});
