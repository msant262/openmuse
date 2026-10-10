import assert from "node:assert/strict";
import test from "node:test";
import { calendarListReference } from "../apps/server/src/calendar-request-context.ts";

test("relative scheduling dates stay separate from dates embedded in literal event names", () => {
  const reference = calendarListReference(
    "Crie dois compromissos na agenda da conta test@example.com para amanhã: Revisão 20261010 às 11h e Entrega 20260901 às 12h, ambos com 15 minutos de duração, no fuso Europe/Berlin.",
    "2026-10-10T22:06:21.569Z",
  );
  assert.ok(reference);
  assert.equal(reference.schedulingDate, "2026-10-12");
  assert.equal(reference.timeZone, "Europe/Berlin");
  assert.equal(reference.account, "test@example.com");
  assert.equal(reference.durationMinutes, 15);
  assert.deepEqual(reference.events, [
    { title: "Revisão 20261010", localTime: "11:00" },
    { title: "Entrega 20260901", localTime: "12:00" },
  ]);
});

test("the supplied admission time anchors tomorrow across a later midnight or retry", () => {
  const prompt = "Crie na agenda para amanhã: Revisão às 11h no fuso Europe/Berlin.";
  assert.equal(calendarListReference(prompt, "2026-10-10T21:59:59Z")?.schedulingDate, "2026-10-11");
  assert.equal(calendarListReference(prompt, "2026-10-10T22:00:00Z")?.schedulingDate, "2026-10-12");
});

test("civil-day arithmetic respects DST and quoted names that contain relative words", () => {
  const reference = calendarListReference(
    'Agende para depois de amanhã: "Hoje 20260328" às 10h30 e "Amanhã" às 15:45, no fuso Europe/Berlin.',
    "2026-03-28T22:30:00Z",
  );
  assert.ok(reference);
  assert.equal(reference.schedulingDate, "2026-03-30");
  assert.deepEqual(reference.events, [
    { title: "Hoje 20260328", localTime: "10:30" },
    { title: "Amanhã", localTime: "15:45" },
  ]);
});

test("English Calendar lists keep local yesterday instead of the UTC date", () => {
  const reference = calendarListReference(
    "Schedule on yesterday: Review 20261010 at 11:00 and Delivery at 12:15, timezone America/Los_Angeles.",
    "2026-10-11T00:30:00Z",
  );
  assert.ok(reference);
  assert.equal(reference.schedulingDate, "2026-10-09");
  assert.equal(reference.events[1].localTime, "12:15");
});

test("unresolved or contradictory scheduling information stays unparsed", () => {
  for (const prompt of [
    "Agende para amanhã: Revisão às 11h.",
    "Agende para amanhã: Revisão às 11h, no fuso Imaginary/City.",
    "Agende para amanhã: Revisão às 25h, no fuso Europe/Berlin.",
    "Agende para 15/10 e amanhã: Revisão às 11h, no fuso Europe/Berlin.",
    "Agende para hoje e amanhã: Revisão às 11h, no fuso Europe/Berlin.",
    "Agende para amanhã: Revisão às 11h, mas no dia 15/10, no fuso Europe/Berlin.",
    "Não crie na agenda para amanhã: Revisão às 11h, no fuso Europe/Berlin.",
    'Escreva uma história chamada "Amanhã: Revisão às 11h", no fuso Europe/Berlin.',
  ])
    assert.equal(calendarListReference(prompt, "2026-10-10T22:06:21Z"), undefined, prompt);
});

test("timezone-like instructions inside a literal event title remain name data", () => {
  const reference = calendarListReference(
    'Agende para amanhã: "fuso UTC 20261010" às 11h, no fuso "Europe/Berlin".',
    "2026-10-10T22:06:21Z",
  );
  assert.ok(reference);
  assert.equal(reference.timeZone, "Europe/Berlin");
  assert.equal(reference.schedulingDate, "2026-10-12");
  assert.equal(reference.events[0].title, "fuso UTC 20261010");
});
