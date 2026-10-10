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
import { modelFixture, richChatFixtureProviders } from "./helpers/model.ts";

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

test("opening the chat uses a bounded mail preview without transferring old message bodies", async (t) => {
  const { db, workspace } = await fixture(t);
  const sql = (
    db as unknown as {
      db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
    }
  ).db;
  await sql.query(`INSERT INTO records(owner,kind,id,data)
    SELECT 'owner','mail','mail-' || n,jsonb_build_object(
      'id','mail-' || n,'providerMessageId','provider-' || n,'threadId','thread-' || n,
      'from','reader@example.com','sender','Reader','to','[]'::jsonb,'subject','Message ' || n,
      'body',repeat('Long body ',1000) || CASE WHEN n=1 THEN 'old body search target' ELSE '' END,
      'date',to_char(timestamp '2026-10-01' + n * interval '1 second','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'unread',true,'label','Inbox','attachments','["attachment-reference"]'::jsonb,
      'connectionId','current-connection','cachedAt','2026-10-10T00:00:00Z')
    FROM generate_series(1,1000) n`);
  await db.put("owner", "mail", {
    ...cachedMail,
    id: "other-account",
    connectionId: "other-connection",
    date: "2099-01-01T00:00:00Z",
  });
  await db.put("other", "mail", {
    ...cachedMail,
    id: "other-owner",
    connectionId: "current-connection",
    date: "2099-01-01T00:00:00Z",
  });
  let providerReads = 0,
    rows = 0;
  t.mock.method(globalThis, "fetch", async () => {
    providerReads++;
    throw new Error("opening the chat must use cache");
  });
  const query = sql.query.bind(sql);
  t.mock.method(sql, "query", async (...args: Parameters<typeof query>) => {
    const result = await query(...args);
    rows += result.rows.length;
    return result;
  });
  const snapshot = await workspace.snapshot("owner", undefined, "essential");
  assert.equal(providerReads, 0);
  assert.equal(snapshot.mail.length, 100);
  assert.equal(snapshot.mail[0].id, "provider-1000");
  assert.equal(snapshot.mail.at(-1)?.id, "provider-901");
  assert.ok(rows < 140, `initial cache rows must be bounded in SQL, read ${rows}`);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.mail)) < 100_000);
  assert.equal((snapshot.mail[0] as Mail & { bodyComplete?: boolean }).bodyComplete, false);
  assert.equal(snapshot.mail[0].body.length, 240);
  assert.deepEqual(snapshot.mail[0].attachments, ["attachment-reference"]);
  assert.equal(snapshot.mail[0].cache?.provenance, "verified");
  const stored = await db.get<Mail>("owner", "mail", "mail-1000");
  assert.ok(stored && stored.body.length > 240, "full bodies must remain stored");
  const old = await workspace.cachedMail("owner", "old body search target");
  assert.deepEqual(
    old.map((mail) => mail.id),
    ["provider-1"],
    "search must include messages outside the initial window",
  );
});

test("workspace mail search finds content beyond the preview and outside the initial history window", async (t) => {
  const { db, workspace } = await fixture(t);
  await db.put("owner", "mail", {
    ...cachedMail,
    body: "x".repeat(5000) + "hidden search target",
    connectionId: "current-connection",
  });
  await db.put("owner", "mail", {
    ...cachedMail,
    id: "wrong-account",
    body: "hidden search target",
    connectionId: "other-connection",
  });
  await db.put("other", "mail", {
    ...cachedMail,
    body: "hidden search target",
    connectionId: "current-connection",
  });
  const results = await workspace.cachedMail("owner", "hidden search target");
  assert.deepEqual(
    results.map((mail) => mail.id),
    [cachedMail.id],
  );
  assert.equal(results[0].body.length, 240);
  assert.equal(results[0].cache?.provenance, "verified");
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      id: cachedMail.threadId,
      messages: [
        {
          id: cachedMail.id,
          threadId: cachedMail.threadId,
          internalDate: String(Date.parse(cachedMail.date)),
          labelIds: ["INBOX"],
          payload: {
            mimeType: "text/plain",
            body: { data: Buffer.from("Complete message from Google").toString("base64url") },
            headers: [
              { name: "Subject", value: cachedMail.subject },
              { name: "From", value: cachedMail.from },
            ],
          },
        },
      ],
    }),
  );
  const full = await workspace.thread("owner", cachedMail.threadId);
  assert.equal(full[0].body, "Complete message from Google");
  assert.notEqual((full[0] as Mail & { bodyComplete?: boolean }).bodyComplete, false);
});

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
    modelProviders: richChatFixtureProviders(directory),
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
    const call = body.input.find(
      (item: { type: string; name: string }) =>
        item.type === "function_call" && item.name === "read_workspace",
    );
    assert.ok(call, JSON.stringify(body.input));
    const result = body.input.find(
      (item: { type: string; call_id?: string }) =>
        item.type === "function_call_output" && item.call_id === call.call_id,
    );
    assert.ok(result, "the actual call and result must remain paired through the copied harness");
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
