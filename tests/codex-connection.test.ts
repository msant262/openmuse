import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../apps/server/src/errors.ts";
import { CodexConnection } from "../apps/server/src/providers/codex-connection.ts";
import { modelProviderConfig } from "../apps/server/src/providers/config.ts";

function fixture() {
  let connected = false,
    logins = 0;
  let finish: () => void = () => {};
  const connection = new CodexConnection(modelProviderConfig("/tmp/codex-connection-test", {}), {
    status: async () => ({ connected }),
    disconnect: async () => {
      connected = false;
    },
    login: async (_file, onCode, signal) => {
      logins++;
      onCode({
        url: "https://auth.openai.com/codex/device",
        code: "ABCD-1234",
        expiresAt: Date.now() + 60000,
        intervalSeconds: 1,
      });
      await new Promise<void>((resolve, reject) => {
        finish = () => {
          connected = true;
          resolve();
        };
        signal.addEventListener(
          "abort",
          () => reject(new Error("SECRET-auth-error-must-not-leak")),
          { once: true },
        );
      });
    },
  });
  return {
    connection,
    finish: () => finish(),
    get logins() {
      return logins;
    },
  };
}

test("Codex device flow is single-flight and owner-scoped; successful authorization removes code", async (t) => {
  const f = fixture();
  t.after(() => f.connection.close());
  const [a, b] = await Promise.all([f.connection.start("owner"), f.connection.start("owner")]);
  assert.equal(f.logins, 1);
  assert.equal(a.flow?.id, b.flow?.id);
  assert.equal(a.flow?.status, "waiting");
  assert.equal(a.flow?.url, "https://auth.openai.com/codex/device");
  assert.equal((await f.connection.status("other")).flow, undefined);
  await assert.rejects(
    f.connection.start("other"),
    (e: unknown) => e instanceof AppError && e.status === 409,
  );
  f.finish();
  await new Promise((resolve) => setImmediate(resolve));
  const connected = await f.connection.status("owner");
  assert.equal(connected.connected, true);
  assert.equal(connected.flow?.status, "connected");
  assert.equal(connected.flow?.code, undefined);
});

test("Codex cancel discards device code and disconnect waits for token exchange before deleting credentials", async (t) => {
  const f = fixture();
  t.after(() => f.connection.close());
  const started = await f.connection.start("owner");
  assert.ok(started.flow);
  await assert.rejects(f.connection.cancel("other", started.flow.id));
  const cancelled = await f.connection.cancel("owner", started.flow.id);
  assert.equal(cancelled.flow?.status, "cancelled");
  assert.equal(cancelled.flow?.code, undefined);
  assert.equal(JSON.stringify(cancelled).includes("SECRET"), false);
  let connected = false,
    settle: () => void = () => {};
  const fence: string[] = [];
  const connection = new CodexConnection(modelProviderConfig("/tmp/codex-fence-test", {}), {
    status: async () => ({ connected }),
    disconnect: async () => {
      fence.push("delete");
      connected = false;
    },
    login: async (_file, onCode, signal) => {
      onCode({
        url: "https://auth.openai.com/codex/device",
        code: "ABCD-1234",
        expiresAt: Date.now() + 60000,
        intervalSeconds: 1,
      });
      await new Promise<void>((resolve) => {
        settle = resolve;
        signal.addEventListener(
          "abort",
          () => {
            fence.push("cancel");
          },
          { once: true },
        );
      });
      fence.push("exchange-settled");
      connected = true;
    },
  });
  t.after(() => connection.close());
  await connection.start("owner");
  const disconnect = connection.disconnect("owner");
  await assert.rejects(connection.start("owner"));
  assert.deepEqual(fence, ["cancel"]);
  settle();
  assert.equal((await disconnect).connected, false);
  assert.deepEqual(fence, ["cancel", "exchange-settled", "delete"]);
});

test("Codex auth failures expose no exchange details or arbitrary verification links", async () => {
  const connection = new CodexConnection(modelProviderConfig("/tmp/codex-invalid-test", {}), {
    status: async () => ({ connected: false }),
    disconnect: async () => {},
    login: async (_file, onCode) => {
      onCode({
        url: "https://evil.test/?token=SECRET",
        code: "123",
        expiresAt: Date.now() + 60000,
        intervalSeconds: 1,
      });
    },
  });
  await assert.rejects(
    connection.start("owner"),
    (e: unknown) => e instanceof AppError && !e.message.includes("SECRET"),
  );
  const status = await connection.status("owner");
  assert.equal(status.flow?.status, "error");
  assert.equal(JSON.stringify(status).includes("evil.test"), false);
  assert.equal(JSON.stringify(status).includes("SECRET"), false);
  await connection.close();
});

test("a damaged saved credential does not hide the replacement device code or expose file details", async (t) => {
  const connection = new CodexConnection(modelProviderConfig("/tmp/codex-corrupt-test", {}), {
    status: async () => {
      throw new Error("SECRET-credential-content private/path");
    },
    disconnect: async () => {},
    login: async (_file, onCode, signal) => {
      onCode({
        url: "https://auth.openai.com/codex/device",
        code: "REPAIR-1234",
        expiresAt: Date.now() + 60000,
        intervalSeconds: 1,
      });
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    },
  });
  t.after(() => connection.close());
  const initial = await connection.status("owner");
  assert.equal(initial.connected, false);
  assert.ok("message" in initial);
  assert.equal(JSON.stringify(initial).includes("SECRET"), false);
  const repair = await connection.start("owner");
  assert.equal(repair.connected, false);
  assert.equal(repair.flow?.code, "REPAIR-1234");
  assert.equal(repair.flow?.url, "https://auth.openai.com/codex/device");
  assert.equal(repair.flow?.status, "waiting");
  assert.equal(JSON.stringify(repair).includes("private/path"), false);
});
