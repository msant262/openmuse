import assert from "node:assert/strict";
import test from "node:test";
import { CalendarTimeZoneUnknownError, GoogleClient } from "../packages/integrations/src/google.ts";

const json = (value: unknown) => Response.json(value);
const base64url = (value: string | Uint8Array) => Buffer.from(value).toString("base64url");

function clientWith(handler: (request: Request) => Response | Promise<Response>) {
  return new GoogleClient({
    getAccessToken: async () => "fixture",
    fetch: async (input, init) => handler(new Request(input, init)),
  });
}

function mailClient(payload: unknown, snippet = "") {
  let call = 0;
  return clientWith(() => {
    call++;
    return call === 1
      ? json({ messages: [{ id: "message-1" }] })
      : json({
          id: "message-1",
          threadId: "thread-1",
          snippet,
          payload,
        });
  });
}

test("unknown MIME charsets fall back safely and folded MIME headers are unfolded", async () => {
  const client = mailClient({
    headers: [
      { name: "From", value: '"billing@example.net"\r\n  <actual@example.net>' },
      { name: "To", value: '"recipient@example.org" <to@example.org>' },
      { name: "Subject", value: "=?UTF-8?Q?Caf=C3=A9?=\r\n\tcontinued" },
      { name: "Content-Type", value: "text/plain;\r\n charset=x-unknown-charset" },
    ],
    mimeType: "text/plain",
    body: { data: base64url("Bonjour from a legacy message.") },
    parts: [],
  });

  const [mail] = await client.listMail();
  assert.equal(mail.id, "message-1");
  assert.equal(mail.threadId, "thread-1");
  assert.equal(mail.from, "actual@example.net");
  assert.equal(mail.sender, "billing@example.net");
  assert.deepEqual(mail.to, ["to@example.org"]);
  assert.equal(mail.subject, "Café continued");
  assert.equal(mail.body, "Bonjour from a legacy message.");
});

test("mail adapters parse complete quoted mailboxes and ignore email-like comments", async () => {
  const cases = [
    {
      header: 'Alice <"alias@example.org"@real.example>',
      mailbox: '"alias@example.org"@real.example',
    },
    { header: 'Alice <"quoted local"@example.net>', mailbox: '"quoted local"@example.net' },
    { header: 'Alice <"A > B"@example.net>', mailbox: '"A > B"@example.net' },
    { header: "(billing@example.net) actual@example.net", mailbox: "actual@example.net" },
    {
      header: '"billing@example.net" <actual@example.net>',
      mailbox: "actual@example.net",
    },
  ];

  for (const { header, mailbox } of cases) {
    const client = mailClient({
      headers: [
        { name: "From", value: header },
        { name: "To", value: header },
      ],
    });
    const [mail] = await client.listMail();
    assert.equal(mail.from, mailbox, `From: ${header}`);
    assert.deepEqual(mail.to, [mailbox], `To: ${header}`);
    assert.equal(mail.id, "message-1");
    assert.equal(mail.threadId, "thread-1");
  }
});

test("an attached message/rfc822 stays an attachment and does not replace the outer body", async () => {
  const client = mailClient({
    mimeType: "multipart/mixed",
    headers: [{ name: "From", value: "sender@example.net" }],
    parts: [
      { mimeType: "text/plain", body: { data: base64url("Outer message body") } },
      {
        mimeType: "message/rfc822",
        body: { attachmentId: "attached-message", size: 80 },
        parts: [{ mimeType: "text/plain", body: { attachmentId: "nested-body", size: 20 } }],
      },
    ],
  });

  const [mail] = await client.listMail();
  assert.equal(mail.body, "Outer message body");
  assert.deepEqual(mail.attachments, ["message-1:attached-message:Attached%20message.eml"]);
});

test("truncated UTF-8 emoji and invalid Unicode surrogates are sanitized per message", async () => {
  const incompleteUtf8 = Buffer.concat([Buffer.from("mail "), Buffer.from([0xf0, 0x9f, 0x8c])]);
  const client = mailClient(
    {
      headers: [
        { name: "From", value: "Sender\ud800 <sender@example.net>" },
        { name: "Subject", value: "Bad\ud800 subject" },
      ],
      mimeType: "text/plain",
      body: { data: base64url(incompleteUtf8) },
    },
    "detail &#xD800; emoji &#128512;",
  );

  const [mail] = await client.listMail();
  assert.equal(mail.sender, "Sender�");
  assert.equal(mail.subject, "Bad� subject");
  assert.equal(mail.body, "mail �");
  assert.ok(mail.body.includes("�"));

  const snippetClient = mailClient({}, "detail &#xD800; emoji &#128512;");
  const [snippetMail] = await snippetClient.listMail();
  assert.equal(snippetMail.body, "detail � emoji 😀");
});

test("all-day calendar events require a trusted timezone when Google omits timezone metadata", async () => {
  const client = clientWith(() =>
    json({
      items: [
        {
          id: "all-day",
          summary: "Civil day",
          start: { date: "2026-10-25" },
          end: { date: "2026-10-26" },
        },
      ],
    }),
  );

  await assert.rejects(client.listEvents(), (error: unknown) => {
    assert.ok(error instanceof CalendarTimeZoneUnknownError);
    assert.equal(error.code, "GOOGLE_TIMEZONE_UNKNOWN");
    return true;
  });
});

test("explicit query timezone preserves all-day civil dates when provider timezone is absent", async () => {
  const client = clientWith(() =>
    json({
      items: [
        {
          id: "all-day",
          summary: "Civil day",
          start: { date: "2026-10-25" },
          end: { date: "2026-10-26" },
        },
      ],
    }),
  );

  const result = await client.listEventsWithMetadata({
    timeMin: "2026-10-25",
    timeMax: "2026-10-26",
    timeZone: "Europe/Berlin",
  });
  const [event] = result.events;
  assert.equal(event.start, "2026-10-25");
  assert.equal(event.end, "2026-10-26");
  assert.equal(event.allDay, true);
  assert.equal(event.timeZone, "Europe/Berlin");
  assert.equal(result.metadata.timeZoneSource, "explicit");
  assert.equal(result.metadata.timeMaxExclusive, true);
  assert.equal(result.metadata.truncated, false);
});

test("calendar response dates reject impossible civil days and mixed all-day boundaries", async () => {
  for (const item of [
    {
      id: "impossible",
      start: { date: "2026-02-30" },
      end: { date: "2026-03-01" },
    },
    {
      id: "mixed",
      start: { date: "2026-02-28" },
      end: { dateTime: "2026-03-01T00:00:00Z" },
    },
    {
      id: "impossible-time",
      start: { dateTime: "2026-02-30T10:00:00Z" },
      end: { dateTime: "2026-03-01T10:00:00Z" },
    },
  ]) {
    const client = clientWith(() => json({ items: [item] }));
    await assert.rejects(client.listEvents(), /valid|matching/i);
  }
});

test("explicit query timezone takes precedence over unknown Google timezone labels", async () => {
  const client = clientWith(() =>
    json({
      timeZone: "Mars/Olympus",
      items: [
        {
          id: "timed",
          start: { dateTime: "2026-10-10T10:00:00-07:00", timeZone: "No/SuchZone" },
          end: { dateTime: "2026-10-10T11:00:00-07:00" },
        },
      ],
    }),
  );

  const result = await client.listEventsWithMetadata({ timeZone: "Europe/Berlin" });
  const [event] = result.events;
  assert.equal(event.timeZone, "Europe/Berlin");
  assert.deepEqual(result.metadata.unknownTimeZoneEventIds, []);
});

test("timed events with RFC 3339 offsets remain readable when timezone metadata is absent", async () => {
  const client = clientWith(() =>
    json({
      items: [
        {
          id: "timed",
          start: { dateTime: "2026-10-10T10:00:00-07:00" },
          end: { dateTime: "2026-10-10T11:00:00-07:00" },
        },
      ],
    }),
  );

  const result = await client.listEventsWithMetadata();
  const [event] = result.events;
  assert.equal(event.start, "2026-10-10T10:00:00-07:00");
  assert.equal(event.timeZone, "UTC");
  assert.deepEqual(result.metadata.unknownTimeZoneEventIds, ["timed"]);
  assert.equal(result.metadata.timeZoneSource, "host-default");
});

test("calendar read metadata reports provider pagination without implying a complete agenda", async () => {
  const client = clientWith(() => json({ items: [], nextPageToken: "next-page" }));

  const result = await client.listEventsWithMetadata({ timeZone: "Europe/Berlin" });
  assert.equal(result.metadata.maxResults, 100);
  assert.equal(result.metadata.returnedCount, 0);
  assert.equal(result.metadata.truncated, true);
});

test("civil-date query bounds reject a missing timezone before calling Google", async () => {
  let calls = 0;
  const client = clientWith(() => {
    calls++;
    return json({ items: [] });
  });

  await assert.rejects(
    client.listEvents({ timeMin: "2026-10-25", timeMax: "2026-10-26" }),
    /explicit IANA timeZone/i,
  );
  assert.equal(calls, 0);
});

test("explicit empty calendar query bounds are rejected before calling Google", async () => {
  for (const options of [
    { timeMin: "", timeMax: "2026-10-26T00:00:00Z" },
    { timeMin: "2026-10-25T00:00:00Z", timeMax: "" },
  ]) {
    let calls = 0;
    const client = clientWith(() => {
      calls++;
      return json({ items: [] });
    });

    await assert.rejects(
      client.listEventsWithMetadata({ ...options, timeZone: "Europe/Berlin" }),
      /invalid calendar time(min|max)/i,
    );
    assert.equal(calls, 0);
  }
});

test("date-only calendar query boundaries use the first valid local time after a midnight DST gap", async () => {
  let query: URL | undefined;
  const client = clientWith((request) => {
    query = new URL(request.url);
    return json({ items: [] });
  });

  await client.listEvents({
    timeMin: "2018-11-04",
    timeMax: "2018-11-05",
    timeZone: "America/Sao_Paulo",
  });
  assert.equal(query?.searchParams.get("timeMin"), "2018-11-04T03:00:00.000Z");
  assert.equal(query?.searchParams.get("timeMax"), "2018-11-05T02:00:00.000Z");
});

test("upstream RFC2231 language-tagged headers preserve their non-UTF8 charset", async () => {
  const client = mailClient({
    headers: [{ name: "Subject", value: "=?ISO-8859-1*pt?Q?Promo=E7=F5es?=" }],
  });
  assert.equal((await client.listMail())[0].subject, "Promoções");
});

test("nested text in named MIME attachments never contaminates the parent message", async () => {
  const client = mailClient({
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/plain", body: { data: base64url("Outer body") } },
      {
        mimeType: "multipart/alternative",
        filename: "attachment.mime",
        body: { attachmentId: "attachment" },
        parts: [{ mimeType: "text/plain", body: { data: base64url("Attached body") } }],
      },
    ],
  });
  assert.equal((await client.listMail())[0].body, "Outer body");
});
