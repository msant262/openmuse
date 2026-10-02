import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import type { CalendarEvent, Mail, ProposalInput } from "../packages/domain/src/index.ts";
import { encryptSecret } from "../packages/integrations/src/vault.ts";
import { modelFixture } from "./helpers/model.ts";

const cachedEvent: CalendarEvent = {
  id: "cached-event",
  calendarId: "primary",
  title: "Keep this appointment",
  start: "2026-10-10T10:00:00Z",
  end: "2026-10-10T11:00:00Z",
  allDay: false,
  timeZone: "UTC",
  location: "",
  description: "",
  attendees: [],
};
const cachedMail: Mail = {
  id: "cached-mail",
  threadId: "cached-thread",
  from: "reader@example.com",
  sender: "Reader",
  to: ["me@example.com"],
  subject: "Keep this message",
  body: "Cached only",
  date: "2026-10-01T10:00:00Z",
  unread: true,
  label: "Inbox",
  attachments: [],
};

async function fixture(t: TestContext) {
  const db = await createStore();
  const directory = await mkdtemp(join(tmpdir(), "openmuse-freshness-"));
  const encryptionKey = randomBytes(32).toString("base64");
  const config: Config = {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    model: "openai/fixture",
    allowedOrigins: [],
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    googleClientId: "fixture-client",
    googleClientSecret: "fixture-secret",
    encryptionKey,
  };
  await db.put("owner", "credentials", {
    id: "google",
    generation: "current",
    connectionId: "current-connection",
    secret: encryptSecret(
      JSON.stringify({
        connectionId: "current-connection",
        accessToken: "fixture-access",
        refreshToken: "fixture-refresh",
        expiresAt: Date.now() + 3_600_000,
        scopes: ["https://www.googleapis.com/auth/calendar.events"],
        account: "me@example.com",
      }),
      encryptionKey,
    ),
  });
  const server = await createApp(db, config);
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { ...server, db };
}

function googleEvent(title = cachedEvent.title, etag = '"version-one"') {
  return {
    id: cachedEvent.id,
    etag,
    summary: title,
    start: { dateTime: cachedEvent.start, timeZone: "UTC" },
    end: { dateTime: cachedEvent.end, timeZone: "UTC" },
  };
}

test("live Calendar create and update retain account provenance through the next outage", async (t) => {
  for (const kind of ["calendar.create", "calendar.update"] as const) {
    await t.test(kind, async (t) => {
      const { db, workspace } = await fixture(t);
      if (kind === "calendar.update")
        await db.put("owner", "events", { ...cachedEvent, connectionId: "current-connection" });
      let writes = 0;
      t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST" || init?.method === "PATCH") {
          writes++;
          return Response.json(googleEvent("Written appointment", '"version-two"'));
        }
        if (String(input).endsWith(`/events/${cachedEvent.id}`))
          return Response.json(googleEvent());
        return new Response("Google unavailable", { status: 503 });
      });
      const data = { ...cachedEvent, title: "Written appointment" };
      const input: ProposalInput =
        kind === "calendar.create"
          ? { kind, data }
          : { kind, data: { ...data, eventId: cachedEvent.id } };
      await workspace.execute("owner", input, "current-connection", '"version-one"');
      const stored = await db.get<CalendarEvent & { connectionId?: string; cachedAt?: string }>(
        "owner",
        "events",
        cachedEvent.id,
      );
      assert.equal(writes, 1);
      assert.equal(stored?.connectionId, "current-connection");
      assert.ok(stored?.cachedAt);
      const snapshot = await workspace.snapshot("owner", undefined, "calendar");
      assert.equal(snapshot.events[0]?.title, "Written appointment");
      assert.equal(snapshot.events[0]?.cache?.provenance, "verified");
      assert.equal(snapshot.events[0]?.cache?.freshness, "stale");
      assert.equal(snapshot.sources?.calendar.status, "unavailable");
      assert.equal(snapshot.sources?.calendar.requiresFreshRead, true);
    });
  }
});

test("legacy Calendar cache remains explicitly unknown without attribution to another account", async (t) => {
  const { db, workspace } = await fixture(t);
  const legacy = { ...cachedEvent, id: "legacy-event" };
  await db.put("owner", "events", legacy);
  await db.put("owner", "events", {
    ...cachedEvent,
    id: "other-account-event",
    connectionId: "old-connection",
  });
  let calls = 0,
    unavailable = true;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return unavailable
      ? new Response("Google unavailable", { status: 503 })
      : Response.json({ items: [] });
  });
  const essential = await workspace.snapshot("owner", undefined, "essential");
  assert.equal(calls, 0);
  assert.deepEqual(
    essential.events.map((event) => event.id),
    [legacy.id],
  );
  assert.deepEqual(essential.events[0].cache, { provenance: "unknown", freshness: "unknown" });
  assert.deepEqual(essential.sources?.calendar.unknownProvenanceIds, [legacy.id]);
  const outage = await workspace.snapshot("owner", undefined, "calendar");
  assert.equal(outage.events[0]?.cache?.freshness, "unknown");
  assert.equal(outage.sources?.calendar.freshness, "unknown");
  assert.equal(outage.sources?.calendar.requiresFreshRead, true);
  assert.deepEqual(await db.get("owner", "events", legacy.id), legacy);
  unavailable = false;
  const fresh = await workspace.snapshot("owner", undefined, "calendar");
  assert.deepEqual(fresh.events, []);
  assert.equal(fresh.sources?.calendar.freshness, "fresh");
  assert.equal(fresh.sources?.calendar.requiresFreshRead, false);
  assert.deepEqual(
    await db.get("owner", "events", legacy.id),
    legacy,
    "a fresh empty list must not rewrite or delete unknown legacy rows",
  );
});

test("read_workspace exposes unavailable and revoked source evidence with cached and empty rows", async (t) => {
  const calls: { name: string; arguments: object }[] = [];
  const { requests } = await modelFixture(t, (index) => calls[index]);
  const { db, agent } = await fixture(t);
  const originalFetch = globalThis.fetch;
  let failureStatus = 503,
    googleCalls = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("googleapis.com")) {
      googleCalls++;
      return Response.json(
        { error: { message: "Google rejected this read" } },
        { status: failureStatus },
      );
    }
    return originalFetch(input, init);
  });
  const read = async (section: "mail" | "calendar" | "files") => {
    requests.length = 0;
    calls.splice(
      0,
      calls.length,
      { name: "read_workspace", arguments: { section } },
      {
        name: "ask_user",
        arguments: { question: "The source needs a fresh read before using it for an effect." },
      },
    );
    const task = await agent.createTask("owner", {
      prompt: `Read only ${section} and inspect source availability.`,
    });
    await agent.worker.tick();
    assert.equal((await agent.getTask("owner", task.id)).status, "waiting_input");
    const body = JSON.parse(requests[1].body);
    const result = body.input.find(
      (item: { type: string; call_id?: string }) =>
        item.type === "function_call_output" && item.call_id === "call-0",
    );
    assert.ok(result, "the real model provider receives the tool result");
    return JSON.parse(result.output);
  };
  for (const section of ["mail", "calendar"] as const) {
    for (const status of [401, 503]) {
      for (const withCache of [false, true]) {
        failureStatus = status;
        await db.remove("owner", "mail", cachedMail.id);
        await db.remove("owner", "events", cachedEvent.id);
        await db.remove("owner", "events", "legacy-event");
        if (withCache) {
          const row = section === "mail" ? cachedMail : cachedEvent;
          await db.put("owner", section === "mail" ? "mail" : "events", {
            ...row,
            connectionId: "current-connection",
          });
          if (section === "calendar")
            await db.put("owner", "events", { ...cachedEvent, id: "legacy-event" });
        }
        const output = await read(section);
        assert.ok(
          output.sources?.[section],
          `${section}/${status}/${withCache}: failure diagnostics must reach the model`,
        );
        assert.equal(
          output.sources[section].status,
          status === 401 ? "disconnected" : "unavailable",
        );
        assert.equal(
          output.sources[section].errorCode,
          status === 401 ? "GOOGLE_RECONNECT_REQUIRED" : "GOOGLE_UNAVAILABLE",
        );
        assert.equal(
          output.sources[section].freshness,
          withCache && section === "mail" ? "stale" : "unknown",
        );
        assert.equal(output.sources[section].requiresFreshRead, true);
        assert.equal(
          Object.keys(output.sources).length,
          1,
          "only requested-source diagnostics are returned",
        );
        const rows = section === "mail" ? output.mail : output.events;
        assert.equal(rows.length, withCache ? (section === "calendar" ? 2 : 1) : 0);
        if (section === "calendar" && withCache) {
          assert.deepEqual(output.sources.calendar.unknownProvenanceIds, ["legacy-event"]);
          assert.equal(
            rows.find((row: CalendarEvent) => row.id === "legacy-event").cache.provenance,
            "unknown",
          );
        }
      }
    }
  }
  const beforeFiles = googleCalls;
  const files = await read("files");
  assert.equal(googleCalls, beforeFiles, "files tool must not probe Google");
  assert.equal(files.sources.files.status, "available");
  assert.equal(files.sources.files.freshness, "fresh");
  assert.equal(files.sources.files.requiresFreshRead, false);
  assert.equal(files.mail, undefined);
  assert.equal(files.events, undefined);
});

test("a failed mail read does not hide a fresh successful Calendar read", async (t) => {
  const { workspace } = await fixture(t);
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) =>
    String(input).includes("gmail.googleapis.com")
      ? new Response("Unavailable", { status: 503 })
      : Response.json({ items: [] }),
  );
  const snapshot = await workspace.snapshot("owner", undefined, "all");
  assert.equal(snapshot.sources?.mail.status, "unavailable");
  assert.equal(snapshot.sources?.mail.freshness, "unknown");
  assert.equal(snapshot.sources?.calendar.status, "available");
  assert.equal(snapshot.sources?.calendar.freshness, "fresh");
  assert.equal(snapshot.sources?.calendar.requiresFreshRead, false);
});
