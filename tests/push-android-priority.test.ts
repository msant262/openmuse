import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JWT } from "google-auth-library";
import { nativePushAdapters } from "../apps/server/src/push.ts";

test("visible Android task notifications use high transport priority and the app channel", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "okami-fcm-priority-"));
  const credentials = join(directory, "account.json");
  await writeFile(
    credentials,
    JSON.stringify({ client_email: "fixture@example.test", private_key: "fixture" }),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.mock.method(JWT.prototype, "getAccessToken", async () => ({ token: "fixture-access-token" }));
  const signal = new AbortController().signal;
  let sends = 0;
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    sends++;
    assert.equal(url, "https://fcm.googleapis.com/v1/projects/fixture/messages:send");
    assert.equal(options.signal, signal);
    assert.deepEqual(JSON.parse(String(options.body)), {
      message: {
        token: "fixture-device-token",
        notification: { title: "Task needs attention" },
        data: { notificationId: "notification", taskId: "task" },
        android: {
          priority: "HIGH",
          notification: { channel_id: "openmuse", tag: "notification" },
        },
      },
    });
    return new Response("{}", { status: 200 });
  });
  const adapter = nativePushAdapters({
    fcmCredentialsFile: credentials,
    fcmProjectId: "fixture",
  }).android;
  assert.ok(adapter);
  assert.equal(
    await adapter(
      {
        id: "phone",
        installationId: "phone",
        platform: "android",
        token: "fixture-device-token",
        updatedAt: "now",
      },
      { id: "notification", title: "Task needs attention", taskId: "task" },
      signal,
    ),
    "accepted",
  );
  assert.equal(sends, 1);
});
