import assert from "node:assert/strict";
import { test } from "node:test";
import { modelFixture, richChatFixtureProviders } from "./helpers/model.ts";
import { fixture, message } from "./proactivity-fixture.ts";

async function reviewed(f: Awaited<ReturnType<typeof fixture>>) {
  await f.db.put("local-user", "proactivity-state", {
    id: "heartbeat",
    generation: 0,
    activeCycleId: null,
    lastReviewedAt: new Date(f.now).toISOString(),
  });
}
test("a sourced plan deadline wakes the heartbeat before its four-hour cadence", async (t) => {
  const f = await fixture(t);
  await reviewed(f);
  const due = f.now + 5 * 60000;
  await f.server.agent.memory.save("local-user", "Viagem para Porto amanhã.", "User", {
    category: "plan",
    evidence: [
      {
        messageId: "trip",
        threadId: "chat",
        quote: "Viagem para Porto amanhã.",
        observedAt: new Date(f.now).toISOString(),
      },
    ],
    followUp: { state: "open", after: new Date(due).toISOString() },
    validUntil: new Date(due + 86400000).toISOString(),
  });
  assert.equal(await f.server.agent.proactivity.scheduleDue("local-user", f.now), undefined);
  f.now = due + 1000;
  assert.ok(
    await f.server.agent.proactivity.scheduleDue("local-user", f.now),
    "a due plan cannot wait another four hours",
  );
});
test("duplicate events coalesce and survive pause and disk restart", async (t) => {
  const f = await fixture(t);
  await reviewed(f);
  const events = f.server.agent.proactivity.events;
  assert.ok(events, "durable event intake must be wired to the service");
  const event = { source: "task" as const, key: "pending-work", revision: "1" };
  await events.enqueue("local-user", event);
  await events.enqueue("local-user", event);
  await f.server.agent.runtimePause.set("local-user", { paused: true, expectedRevision: 0 });
  f.now += 1000;
  assert.equal(await f.server.agent.proactivity.scheduleDue("local-user", f.now), undefined);
  await f.restart();
  const paused = await f.server.agent.runtimePause.get("local-user");
  await f.server.agent.runtimePause.set("local-user", {
    paused: false,
    expectedRevision: paused.revision,
  });
  const cycle = await f.server.agent.proactivity.scheduleDue("local-user", f.now);
  assert.ok(cycle);
  assert.equal(await f.server.agent.proactivity.scheduleDue("local-user", f.now), cycle);
  assert.equal((await f.db.list("local-user", "proactivity-cycles")).length, 1);
  await f.db.put("other", "proactivity-state", {
    id: "heartbeat",
    generation: 0,
    activeCycleId: null,
    lastReviewedAt: new Date(f.now).toISOString(),
  });
  assert.equal(
    await f.server.agent.proactivity.scheduleDue("other", f.now),
    undefined,
    "an owner without an initialized account must not claim another owner event",
  );
});
test("native source polling detects mail changes, keeps source coverage and schedules a review promptly", async (t) => {
  const f = await fixture(t);
  await f.server.agent.proactivity.pollSources("local-user", f.now);
  await f.server.agent.proactivity.scheduleDue("local-user", f.now);
  await f.server.agent.worker.tick();
  const before = (await f.db.list("local-user", "proactivity-cycles")).length;
  f.source.messages = [
    message("new-deadline", "O check-in termina em 30 minutos. Confira os documentos."),
  ];
  f.now += 6 * 60000;
  await f.server.agent.proactivity.pollSources("local-user", f.now);
  f.now += 1000;
  assert.ok(await f.server.agent.proactivity.scheduleDue("local-user", f.now));
  assert.equal((await f.db.list("local-user", "proactivity-cycles")).length, before + 1);
  const source = await f.db.get<{ coverage: { status: string }; version: string }>(
    "local-user",
    "proactivity-source-state",
    "mail",
  );
  assert.equal(source?.coverage.status, "fresh");
  assert.ok(source?.version);
  f.source.unavailable = true;
  f.now += 6 * 60000;
  await f.server.agent.proactivity.pollSources("local-user", f.now);
  const unavailable = await f.db.get<{ coverage: { status: string; complete: boolean } }>(
    "local-user",
    "proactivity-source-state",
    "mail",
  );
  assert.equal(unavailable?.coverage.status, "unavailable");
  assert.equal(unavailable?.coverage.complete, false);
});
test("quiet hours defer ordinary wakes without consuming them, and changing/cancelling a plan retires its deadline", async (t) => {
  const f = await fixture(t);
  f.now = Date.parse("2026-10-04T02:00:00Z");
  await reviewed(f);
  await f.server.agent.proactivity.settings.update("local-user", {
    expectedRevision: 0,
    activeHours: { start: "08:00", end: "22:00", timezone: "UTC" },
  });
  const events = f.server.agent.proactivity.events;
  await events.enqueue("local-user", { source: "goal", key: "trip", revision: "1" });
  f.now += 1000;
  assert.equal(await f.server.agent.proactivity.scheduleDue("local-user", f.now), undefined);
  f.now = Date.parse("2026-10-04T08:01:00Z");
  assert.ok(await f.server.agent.proactivity.scheduleDue("local-user", f.now));
  const memory = await f.server.agent.memory.save("local-user", "Viagem cancelada", "User", {
    category: "plan",
    evidence: [
      {
        messageId: "cancel",
        threadId: "chat",
        quote: "Viagem cancelada",
        observedAt: new Date(f.now).toISOString(),
      },
    ],
    followUp: { state: "cancelled", after: new Date(f.now).toISOString() },
  });
  await events.enqueue("local-user", {
    source: "memory",
    key: memory.id,
    revision: "1",
    dueAt: new Date(f.now).toISOString(),
  });
  await f.server.agent.proactivity.reconcileMemorySuggestions("local-user");
  assert.ok(!(await events.due("local-user", f.now)).some((e) => e.key === memory.id));
});

test("a new event arriving during an active review remains pending for the next review", async (t) => {
  const f = await fixture(t);
  await reviewed(f);
  const events = f.server.agent.proactivity.events;
  await events.enqueue("local-user", { source: "task", key: "pending-work", revision: "1" });
  f.now += 1000;
  const first = await f.server.agent.proactivity.scheduleDue("local-user", f.now);
  assert.ok(first);
  const next = await events.enqueue("local-user", {
    source: "task",
    key: "pending-work",
    revision: "2",
  });
  await f.server.agent.worker.tick();
  f.now += 1000;
  assert.ok(
    (await events.due("local-user", f.now)).some((e) => e.id === next.id && e.revision === "2"),
  );
  const second = await f.server.agent.proactivity.scheduleDue("local-user", f.now);
  assert.ok(second);
  assert.notEqual(second, first);
});

test("a source failure retains its wake and retries after backoff instead of consuming it as reviewed", async (t) => {
  const f = await fixture(t);
  await reviewed(f);
  await f.server.agent.proactivity.events.enqueue("local-user", {
    source: "mail",
    key: "fixture-google",
    revision: "new-message",
  });
  f.now += 1000;
  await f.server.agent.proactivity.scheduleDue("local-user", f.now);
  f.source.unavailable = true;
  await f.server.agent.worker.tick();
  assert.equal(
    await f.server.agent.proactivity.scheduleDue("local-user", f.now + 60000),
    undefined,
  );
  f.now += 6 * 60000;
  f.source.unavailable = false;
  assert.ok(await f.server.agent.proactivity.scheduleDue("local-user", f.now));
  assert.equal(f.source.writes, 0, "background attention must not send mail");
});

test("a due plan outside the normal memory page reaches reasoning and publishes one current alert", async (t) => {
  let candidateId = "";
  const model = await modelFixture(t, () => ({
    name: "heartbeat_respond",
    arguments: {
      suggestions: [
        {
          candidateId,
          title: "Preparar Porto",
          reason: "A viagem está próxima. Quer conferir hotéis e passagens?",
        },
      ],
    },
  }));
  const f = await fixture(t, {
    semanticProactivityEnabled: true,
    modelProviders: richChatFixtureProviders("/tmp/event-target"),
  });
  await reviewed(f);
  const due = f.now + 5 * 60000;
  const plan = await f.server.agent.memory.save(
    "local-user",
    "Viajar para Porto; conferir hotel e passagem.",
    "User",
    {
      category: "plan",
      evidence: [
        {
          messageId: "trip-deadline",
          threadId: "chat",
          quote: "Viajar para Porto",
          observedAt: new Date(f.now).toISOString(),
        },
      ],
      followUp: { state: "open", after: new Date(due).toISOString() },
      validUntil: new Date(due + 86400000).toISOString(),
    },
  );
  candidateId = `memory:${plan.id}`;
  for (let i = 0; i < 35; i++)
    await f.server.agent.memory.save("local-user", `Other personal fact ${i}`);
  f.now = due + 1000;
  assert.ok(await f.server.agent.proactivity.scheduleDue("local-user", f.now));
  await f.server.agent.worker.tick();
  const cards = await f.server.agent.proactivity.list("local-user");
  assert.equal(
    cards.filter((card) => card.target.kind === "memory" && card.target.memoryId === plan.id)
      .length,
    1,
  );
  assert.ok(model.requests.some((request) => request.body.includes(candidateId)));
  assert.equal(
    (
      await f.db.recordPage("local-user", "proactivity-events", {
        field: "status",
        value: "pending",
      })
    ).entries.length,
    0,
    "a reviewed target must not keep retrying because the unrelated memory catalog is paginated",
  );
  assert.equal(f.source.writes, 0);
});
