import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type TestContext, test } from "node:test";
import { URL } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createStore } from "../../server/src/db.ts";
import { DeviceSessions } from "../../server/src/device-sessions.ts";
import { ApiError, parseResponse } from "../src/api-errors.ts";
import {
  AuthManager,
  type Credential,
  type CredentialStorage,
  CredentialStorageUnavailableError,
  normalizeServerOrigin,
} from "../src/auth-manager.ts";
import {
  authenticatedFetch,
  authenticatedUpload,
  installRuntimeAuthFetch,
} from "../src/auth-transport.ts";

const crypto = {
  token: () => randomBytes(32).toString("hex"),
  hash: async (value: string) => createHash("sha256").update(value).digest("hex"),
};
async function fixture(t: TestContext) {
  const db = await createStore();
  t.after(() => db.close());
  const devices = new DeviceSessions(db, "synthetic-signing-key");
  let saved: Credential | null = null;
  let writes = 0,
    refreshes = 0;
  const storage: CredentialStorage = {
    read: async () => saved && structuredClone(saved),
    write: async (value) => {
      writes++;
      saved = structuredClone(value);
    },
    remove: async () => {
      saved = null;
    },
  };
  const transport = {
    pair: async () => ({ ...(await devices.pair("local-user", "phone")), mode: "live" as const }),
    refresh: async (input: Parameters<DeviceSessions["refresh"]>[0] | undefined) => {
      refreshes++;
      assert.ok(input);
      return { ...(await devices.refresh(input)), mode: "live" as const };
    },
  };
  const manager = () => new AuthManager({ storage, transport, crypto });
  return {
    devices,
    storage,
    transport,
    manager,
    saved: () => saved,
    counts: () => ({ writes, refreshes }),
  };
}

test("pairing restores after restart and after 48 hours or thirty days without using the access key", async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const f = await fixture(t),
    manager = f.manager();
  await manager.pair("fixture-key");
  const deviceId = manager.snapshot.identity?.deviceId;
  for (const days of [2, 30]) {
    now = 1_800_000_000_000 + days * 86_400_000;
    const restarted = f.manager();
    await restarted.restore();
    assert.equal(restarted.snapshot.identity?.deviceId, deviceId);
    assert.equal(await f.devices.owner((await restarted.authorization()).slice(7)), "local-user");
  }
  assert.equal(f.counts().refreshes, 2);
});

test("ten simultaneous expired REST/runtime/uploads share one refresh and preserve identity", async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const f = await fixture(t),
    manager = f.manager();
  await manager.pair();
  const identity = manager.snapshot.identity;
  const stale = `Bearer ${manager.snapshot.token}`;
  let requests = 0,
    expiredReplies = 0;
  let release: () => void = () => {};
  const received = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetcher: typeof fetch = async (_url, init) => {
    if (new Headers(init?.headers).get("Authorization") === stale) {
      if (++requests === 10) {
        now += 900_001;
        release();
      }
      await received;
    }
    try {
      await f.devices.owner(new Headers(init?.headers).get("Authorization")!.slice(7));
      return Response.json({ ok: true });
    } catch {
      expiredReplies++;
      return Response.json({ error: "expired", code: "SESSION_EXPIRED" }, { status: 401 });
    }
  };
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      index < 8
        ? authenticatedFetch(
            manager,
            `https://workspace.example/api/${index < 4 ? "workspace" : "copilotkit"}`,
            {},
            fetcher,
          ).then(parseResponse<{ ok: boolean }>)
        : authenticatedUpload<{ ok: boolean }>(manager, async (authorization) => {
            const response = await fetcher("https://workspace.example/api/files", {
              headers: { Authorization: authorization },
            });
            return { status: response.status, body: await response.text() };
          }),
    ),
  );
  assert.equal(expiredReplies, 10);
  assert.ok(results.every((result) => result.ok));
  assert.equal(f.counts().refreshes, 1);
  assert.deepEqual(manager.snapshot.identity, identity);
});

test("runtime wrapper renews its own headers and leaves other origins untouched", async (t) => {
  const f = await fixture(t),
    manager = f.manager();
  await manager.pair();
  let externalAuthorization: string | null = null;
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    externalAuthorization = new Headers(init?.headers).get("Authorization");
    return Response.json({ ok: true });
  });
  const cleanup = installRuntimeAuthFetch("https://workspace.example", manager);
  t.after(cleanup);
  const runtime = await globalThis.fetch("https://workspace.example/api/copilotkit/info");
  assert.equal((await runtime.json()).ok, true);
  assert.equal(externalAuthorization, `Bearer ${manager.snapshot.token}`);
  await globalThis.fetch("https://connector.example/api/copilotkit/info");
  assert.equal(externalAuthorization, null);
});

test("a saved native successor recovers after the bounded predecessor receipt expires", async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const f = await fixture(t),
    manager = f.manager();
  await manager.pair();
  const transport = {
    ...f.transport,
    refresh: async (input: Parameters<DeviceSessions["refresh"]>[0] | undefined) => {
      await f.transport.refresh(input);
      throw new Error("lost response");
    },
  };
  const first = new AuthManager({ storage: f.storage, transport, crypto });
  await first.restore();
  await assert.rejects(first.recoverExpiredSession(), /lost/);
  now += 30 * 86_400_000;
  const recovered = f.manager();
  await recovered.restore();
  assert.equal(await f.devices.owner((await recovered.authorization()).slice(7)), "local-user");
  assert.equal(f.saved()?.pending, undefined);
});

test("missing credentials and absent web cookies restore as missing, rather than transient failures", async () => {
  const storage: CredentialStorage = {
    read: async () => null,
    write: async () => {},
    remove: async () => {},
  };
  const transport = {
    pair: async () => {
      throw new Error("not called");
    },
    refresh: async () => {
      throw new ApiError("No pairing", 401, "SESSION_REQUIRED");
    },
  };
  const native = new AuthManager({ storage, transport, crypto });
  await native.restore();
  assert.equal(native.snapshot.status, "missing");
  const web = new AuthManager({ storage, transport, crypto, web: true });
  await web.restore();
  assert.equal(web.snapshot.status, "missing");
});

test("rotation is durable before dispatch and recovers a lost reply after app/server restart", async (t) => {
  const f = await fixture(t),
    manager = f.manager();
  await manager.pair();
  let loseResponse = true;
  const transport = {
    ...f.transport,
    refresh: async (input: Parameters<DeviceSessions["refresh"]>[0] | undefined) => {
      assert.ok(f.saved()?.pending);
      assert.equal(f.saved()?.pending?.rotationId, input?.rotationId);
      const result = await f.transport.refresh(input);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("network lost after commit");
      }
      return result;
    },
  };
  const first = new AuthManager({ storage: f.storage, transport, crypto });
  await first.restore();
  await assert.rejects(first.recoverExpiredSession(), /network/);
  const pending = f.saved()?.pending;
  assert.ok(pending);
  const restarted = new AuthManager({ storage: f.storage, transport, crypto });
  await restarted.restore();
  assert.equal(f.saved()?.refreshToken, pending.nextToken);
  assert.equal(f.saved()?.pending, undefined);
  assert.equal(await f.devices.owner((await restarted.authorization()).slice(7)), "local-user");
});

test("a crash before pending save dispatches nothing; a crash during final save retains recoverable rotation", async (t) => {
  const f = await fixture(t),
    manager = f.manager();
  await manager.pair();
  let failWrite = true;
  const storage = {
    ...f.storage,
    write: async (value: Credential) => {
      if (failWrite) throw new Error("phone locked");
      await f.storage.write(value);
    },
  };
  const first = new AuthManager({ storage, transport: f.transport, crypto });
  await first.restore();
  await assert.rejects(first.recoverExpiredSession(), /storage/i);
  assert.equal(f.counts().refreshes, 0);
  failWrite = false;
  const finalFail = {
    ...f.storage,
    write: async (value: Credential) => {
      if (!value.pending) throw new Error("crash before final save");
      await f.storage.write(value);
    },
  };
  const second = new AuthManager({ storage: finalFail, transport: f.transport, crypto });
  await second.restore();
  await assert.rejects(second.recoverExpiredSession(), /storage/i);
  assert.ok(f.saved()?.pending);
  await f.manager().restore();
  assert.equal(f.saved()?.pending, undefined);
});

test("locked or rebooting credential storage remains paired and retry succeeds", async (t) => {
  const f = await fixture(t),
    paired = f.manager();
  await paired.pair();
  let locked = true;
  const manager = new AuthManager({
    storage: {
      ...f.storage,
      read: async () => {
        if (locked) throw new Error("locked until first unlock");
        return f.storage.read();
      },
    },
    transport: f.transport,
    crypto,
  });
  await assert.rejects(manager.restore(), /storage/i);
  assert.equal(manager.snapshot.status, "unavailable");
  assert.ok(f.saved());
  locked = false;
  await manager.restore();
  assert.equal(manager.snapshot.status, "paired");
});

test("Google 401 and gateway HTML never clear workspace pairing; confirmed revocation does", async (t) => {
  const f = await fixture(t),
    manager = f.manager();
  await manager.pair();
  const response = await authenticatedFetch(
    manager,
    "https://workspace.example/api/calendars",
    {},
    async () =>
      Response.json(
        { error: "Google requires reconnection", code: "GOOGLE_RECONNECT_REQUIRED" },
        { status: 401 },
      ),
  );
  await assert.rejects(parseResponse(response), { code: "GOOGLE_RECONNECT_REQUIRED" });
  await assert.rejects(
    parseResponse(new Response("<html>gateway failed</html>", { status: 502 })),
    (error: unknown) =>
      error instanceof ApiError && error.status === 502 && /502/.test(error.message),
  );
  await assert.rejects(parseResponse(new Response("", { status: 502 })), { status: 502 });
  assert.equal(f.counts().refreshes, 0);
  assert.ok(f.saved());
  await f.devices.revoke("local-user", manager.snapshot.identity!.deviceId);
  await assert.rejects(manager.recoverExpiredSession(), { code: "SESSION_REVOKED" });
  assert.equal(manager.snapshot.status, "revoked");
  assert.equal(f.saved(), null);
});

test("web restoration uses cookie transport and never writes any refresh credential", async () => {
  let saved = 0;
  const manager = new AuthManager({
    web: true,
    crypto,
    storage: {
      read: async () => {
        throw new Error("web must not read native storage");
      },
      write: async () => {
        saved++;
      },
      remove: async () => {
        saved++;
      },
    },
    transport: {
      pair: async () => {
        throw new Error("pair not called");
      },
      refresh: async (input) => {
        assert.equal(input, undefined);
        return {
          deviceId: "device",
          owner: "local-user",
          token: "access",
          accessExpiresAt: Date.now() + 900_000,
          mode: "live",
        };
      },
    },
  });
  await manager.restore();
  assert.equal(await manager.authorization(), "Bearer access");
  assert.equal(saved, 0);
});

test("native SecureStore distinguishes first-unlock errors from missing credentials and persists a small envelope without biometric refresh", async (t) => {
  const f = await fixture(t),
    manager = f.manager();
  await manager.pair();
  let stored: string | null = null,
    locked = true;
  const values = new Map<string, string>();
  const secureStore = {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 9,
    getItemAsync: async (key: string) => {
      if (locked) throw new Error("OS temporarily locked");
      return values.get(key) ?? null;
    },
    setItemAsync: async (
      key: string,
      value: string,
      options: { requireAuthentication: boolean; keychainAccessible: number },
    ) => {
      assert.equal(options.requireAuthentication, false);
      assert.equal(options.keychainAccessible, 9);
      stored = value;
      values.set(key, value);
    },
    deleteItemAsync: async (key: string) => {
      values.delete(key);
    },
  };
  const exports = {} as { createCredentialStorage: (serverOrigin: string) => CredentialStorage };
  const source = await readFile(
    new URL("../src/credential-storage.native.ts", import.meta.url),
    "utf8",
  );
  runInNewContext(
    ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    {
      exports,
      require: (name: string) => {
        if (name === "expo-secure-store") return secureStore;
        if (name === "expo-crypto")
          return {
            CryptoDigestAlgorithm: { SHA256: "SHA256" },
            digestStringAsync: async (_algorithm: string, value: string) =>
              createHash("sha256").update(value).digest("hex"),
          };
        if (name === "./auth-manager")
          return { CredentialStorageUnavailableError, normalizeServerOrigin };
        throw new Error(`Unexpected import ${name}`);
      },
    },
  );
  const storage = exports.createCredentialStorage("https://first.example");
  await assert.rejects(storage.read(), {
    code: "CREDENTIAL_STORAGE_UNAVAILABLE",
  });
  locked = false;
  assert.equal(await storage.read(), null);
  await storage.write(f.saved()!);
  assert.ok(stored && String(stored).length < 1800);
  assert.equal((await storage.read())?.deviceId, f.saved()?.deviceId);
  assert.equal(await exports.createCredentialStorage("https://second.example").read(), null);
  assert.equal(
    (await exports.createCredentialStorage("https://first.example:443/").read())?.deviceId,
    f.saved()?.deviceId,
  );
});

test("confirmed revocation on the one allowed retry clears pairing for REST and upload", async (t) => {
  const f = await fixture(t),
    manager = f.manager();
  await manager.pair();
  let requests = 0;
  const response = await authenticatedFetch(
    manager,
    "https://workspace.example/api/files",
    {},
    async () =>
      Response.json(
        {
          error: "workspace session",
          code: ++requests === 1 ? "SESSION_EXPIRED" : "SESSION_REVOKED",
        },
        { status: 401 },
      ),
  );
  await assert.rejects(parseResponse(response), { code: "SESSION_REVOKED" });
  assert.equal(manager.snapshot.status, "revoked");
  assert.equal(f.saved(), null);
  await manager.pair();
  requests = 0;
  await assert.rejects(
    authenticatedUpload(manager, async () => ({
      status: 401,
      body: JSON.stringify({
        error: "workspace session",
        code: ++requests === 1 ? "SESSION_EXPIRED" : "SESSION_REVOKED",
      }),
    })),
    { code: "SESSION_REVOKED" },
  );
  assert.equal(manager.snapshot.status, "revoked");
  assert.equal(f.saved(), null);
});

test("expired Request POST bodies are safely cloned before the first consumed fetch attempt", async (t) => {
  const f = await fixture(t),
    manager = f.manager();
  await manager.pair();
  const bodies: string[] = [];
  const request = new Request("https://workspace.example/api/copilotkit", {
    method: "POST",
    body: JSON.stringify({ message: "retain this draft" }),
  });
  const response = await authenticatedFetch(manager, request, {}, async (input, init) => {
    const consumed = new Request(input, init);
    bodies.push(await consumed.text());
    return bodies.length === 1
      ? Response.json({ error: "expired", code: "SESSION_EXPIRED" }, { status: 401 })
      : Response.json({ ok: true });
  });
  assert.equal((await response.json()).ok, true);
  assert.deepEqual(bodies, ['{"message":"retain this draft"}', '{"message":"retain this draft"}']);
  assert.equal(f.counts().refreshes, 1);
});

test("restoring the same native store against another API origin sends no old credential", async (t) => {
  const f = await fixture(t);
  const first = new AuthManager({
    storage: f.storage,
    transport: f.transport,
    crypto,
    serverOrigin: "https://first.example:443/",
  });
  await first.pair();
  let dispatched = 0;
  const second = new AuthManager({
    storage: f.storage,
    transport: {
      ...f.transport,
      refresh: async () => {
        dispatched++;
        throw new Error("credential crossed origin");
      },
    },
    crypto,
    serverOrigin: "https://second.example",
  });
  await second.restore();
  assert.equal(second.snapshot.status, "missing");
  await assert.rejects(second.authorization(), /Pair this device/);
  assert.equal(dispatched, 0);
  assert.ok(f.saved());
  const restoredFirst = new AuthManager({
    storage: f.storage,
    transport: f.transport,
    crypto,
    serverOrigin: "https://first.example",
  });
  await restoredFirst.restore();
  assert.equal(restoredFirst.snapshot.status, "paired");
});

test("web locks hold delayed cookie responses before another tab can advance generations", async (t) => {
  const { withWebSessionLock } = await import("../src/web-session-coordinator.ts");
  const f = await fixture(t);
  const paired = await f.devices.pair("local-user", "browser", "web");
  let cookie = paired.refreshToken;
  const effects: number[] = [];
  let started: () => void = () => {},
    release: () => void = () => {};
  const serverStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const delayedResponse = new Promise<void>((resolve) => {
    release = resolve;
  });
  let tail = Promise.resolve();
  const locks = {
    request: <T>(_name: string, callback: () => Promise<T>) => {
      const pending = tail.then(callback);
      tail = pending.then(
        () => {},
        () => {},
      );
      return pending;
    },
  };
  const rotate = (index: number) =>
    withWebSessionLock(
      "https://workspace.example",
      async () => {
        effects.push(index);
        const result = await f.devices.refreshWeb(paired.deviceId, cookie, `rotation-tab-${index}`);
        if (index === 1) {
          started();
          await delayedResponse;
        }
        assert.ok(result.refreshToken);
        cookie = result.refreshToken;
        return result;
      },
      locks,
    );
  const first = rotate(1);
  await serverStarted;
  const second = rotate(2),
    third = rotate(3);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.deepEqual(effects, [1]);
  release();
  const results = await Promise.all([first, second, third]);
  assert.deepEqual(effects, [1, 2, 3]);
  assert.equal(await f.devices.owner(results[2].token), "local-user");
  let unsafeDispatch = false;
  await assert.rejects(
    withWebSessionLock(
      "https://workspace.example",
      async () => {
        unsafeDispatch = true;
      },
      null,
    ),
    /Web Locks/,
  );
  assert.equal(unsafeDispatch, false);
});
