import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { encryptSecret } from "../packages/integrations/src/vault.ts";

export function message(id: string, body: string, sent = false, draft = false) {
  return {
    id,
    threadId: "thread-one",
    internalDate: String(
      Date.parse(sent || draft ? "2026-10-02T09:00:00Z" : "2026-10-01T09:00:00Z"),
    ),
    labelIds: draft ? ["DRAFT"] : sent ? ["SENT"] : ["INBOX"],
    payload: {
      mimeType: "text/plain",
      headers: [
        {
          name: "From",
          value: sent || draft ? "Me <me@example.com>" : "Jamie <jamie@example.com>",
        },
        { name: "To", value: sent || draft ? "jamie@example.com" : "me@example.com" },
        { name: "Subject", value: "Coffee this week?" },
        { name: "Message-ID", value: `<${id}@fixture.example>` },
      ],
      body: { data: Buffer.from(body).toString("base64url") },
    },
  };
}

export async function fixture(t: TestContext, overrides: Partial<Config> = {}) {
  let now = Date.now();
  const directory = await mkdtemp(join(tmpdir(), "okami-proactivity-"));
  const config: Config = {
    mode: "live",
    agentBackend: "model",
    model: "openai/fixture",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    allowedOrigins: [],
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    encryptionKey: randomBytes(32).toString("base64"),
    googleClientId: "fixture",
    googleClientSecret: "fixture",
    routineTimezone: "Europe/Berlin",
    ...overrides,
  };
  let db = await createStore({ dataDir: join(directory, "db") });
  await db.put("local-user", "credentials", {
    id: "google",
    connectionId: "fixture-google",
    generation: "fixture",
    secret: encryptSecret(
      JSON.stringify({
        connectionId: "fixture-google",
        account: "me@example.com",
        accessToken: "fixture",
        refreshToken: "fixture",
        expiresAt: Date.now() + 365 * 86400000,
        scopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.send",
          "https://www.googleapis.com/auth/calendar.events.readonly",
          "https://www.googleapis.com/auth/calendar.events",
        ],
      }),
      config.encryptionKey!,
    ),
  });
  const source = {
    messages: [message("incoming", "Could you confirm coffee on Thursday? Please reply.")],
    unavailable: false,
    truncated: false,
    writes: 0,
    events: [] as Record<string, unknown>[],
  };
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "127.0.0.1") return realFetch(input, init);
    assert.ok(url.hostname.endsWith("googleapis.com"), `Unexpected remote request ${url.hostname}`);
    if (init?.method && init.method !== "GET") {
      source.writes++;
      return Response.json({ id: "fixture-sent-receipt", threadId: "thread-one" });
    }
    if (source.unavailable) return new Response("Disconnected fixture", { status: 403 });
    if (url.pathname.includes("/threads/"))
      return Response.json({ id: "thread-one", messages: source.messages });
    if (url.pathname.endsWith("/messages"))
      return Response.json({
        messages: [{ id: "incoming" }],
        ...(source.truncated ? { nextPageToken: "more" } : {}),
      });
    if (url.pathname.includes("/messages/")) return Response.json(source.messages[0]);
    if (url.pathname.endsWith("/profile"))
      return Response.json({
        emailAddress: "me@example.com",
        historyId: JSON.stringify(source.messages.map((m) => [m.id, m.labelIds])),
      });
    if (url.pathname.endsWith("/events"))
      return Response.json({ items: source.events, timeZone: "Europe/Berlin" });
    throw new Error(`Unexpected fixture path ${url.pathname}`);
  });
  let server = await createApp(db, config);
  t.mock.method(server.agent.proactivity as unknown as { now: () => number }, "now", () => now);
  await server.agent.ensure("local-user");
  await db.put("local-user", "conversation-settings", {
    id: "main",
    threadId: "chat",
    existing: false,
  });
  const restart = async () => {
    await server.agent.stop();
    if ("close" in server.threads) await server.threads.close();
    await db.close();
    db = await createStore({ dataDir: join(directory, "db") });
    server = await createApp(db, config);
    t.mock.method(server.agent.proactivity as unknown as { now: () => number }, "now", () => now);
    return server;
  };
  t.after(async () => {
    await server.agent.stop();
    if ("close" in server.threads) await server.threads.close();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get server() {
      return server;
    },
    get db() {
      return db;
    },
    source,
    restart,
    set now(value: number) {
      now = value;
    },
    get now() {
      return now;
    },
  };
}

export async function review(f: Awaited<ReturnType<typeof fixture>>, now = Date.now()) {
  assert.ok(f.server.agent.proactivity, "live suggestions need the persistent proactivity service");
  const id = await f.server.agent.proactivity.scheduleDue("local-user", now);
  assert.ok(id);
  await f.server.agent.worker.tick();
  return f.server.agent.proactivity.list("local-user");
}
