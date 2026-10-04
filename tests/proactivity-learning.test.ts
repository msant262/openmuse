import assert from "node:assert/strict";
import { test } from "node:test";
import { modelFixture, richChatFixtureProviders } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";
import { fixture, message, review } from "./proactivity-fixture.ts";

test("heartbeat revisits a conversational trip and closing it prevents reminders in the next cycle", async (t) => {
  let candidateId = "";
  await modelFixture(t, () => ({
    name: "heartbeat_respond",
    arguments: {
      suggestions: [
        {
          candidateId,
          title: "Ainda vai a Lisboa?",
          reason: "Você comentou essa viagem. Quer retomar os planos e pesquisar hotéis?",
        },
      ],
    },
  }));
  const server = await taskRuntime(t, {
    mode: "live",
    agentBackend: "model",
    model: "openai/fixture",
    semanticProactivityEnabled: true,
  });
  await server.agent.ensure("owner");
  const memory = await server.agent.memory.save(
    "owner",
    "Planeja viajar para Lisboa em novembro.",
    "User",
    {
      category: "plan",
      evidence: [
        {
          messageId: "trip",
          threadId: "chat",
          quote: "Vou viajar para Lisboa",
          observedAt: new Date().toISOString(),
        },
      ],
      followUp: { state: "open", after: "2020-01-01T00:00:00Z" },
    },
  );
  candidateId = `memory:${memory.id}`;
  assert.ok(await server.agent.proactivity.scheduleDue("owner"));
  await server.agent.worker.tick();
  const suggestions = await server.agent.proactivity.list("owner");
  assert.equal(
    suggestions.length,
    1,
    "a conversational plan reaches the normal chat suggestion journal",
  );
  const s = suggestions[0];
  assert.equal(s.target.kind, "memory");
  await server.agent.proactivity.respond("owner", s.id, {
    requestId: s.requestId,
    clientResponseId: "trip-done",
    expectedRevision: s.revision,
    action: "resolved",
  });
  const current = (await server.db.get("owner", "memories", memory.id)) as typeof memory;
  assert.equal(current.followUp?.state, "resolved");
  assert.equal(current.revision, 2);
  assert.equal((await server.agent.memory.history("owner", memory.id)).entries.length, 2);
  assert.ok(await server.agent.proactivity.scheduleDue("owner", Date.now() + 86400000));
  await server.agent.worker.tick();
  assert.equal((await server.agent.proactivity.list("owner")).length, 1);
});

test("upcoming calendar preparation uses current event evidence and cancellation retires the card", async (t) => {
  await modelFixture(t, () => ({
    name: "heartbeat_respond",
    arguments: {
      suggestions: [
        {
          candidateId: "calendar:fixture-google:appointment",
          title: "Preparar documentos",
          reason: "Sua consulta é amanhã. Quer conferir os documentos necessários?",
        },
      ],
    },
  }));
  const f = await fixture(t, {
    semanticProactivityEnabled: true,
    modelProviders: richChatFixtureProviders("/tmp/proactivity-calendar-fixture"),
  });
  f.source.messages = [];
  f.source.events = [
    {
      id: "appointment",
      summary: "Consulta",
      description: "Levar os documentos originais",
      start: { dateTime: new Date(Date.now() + 86400000).toISOString(), timeZone: "Europe/Berlin" },
      end: { dateTime: new Date(Date.now() + 90000000).toISOString(), timeZone: "Europe/Berlin" },
    },
  ];
  const cards = await review(f);
  const s = cards.find((s) => s.target.kind === "calendar");
  assert.ok(s);
  f.source.events = [];
  const result = await f.server.agent.proactivity.respond("local-user", s.id, {
    requestId: s.requestId,
    clientResponseId: "cancelled-appointment",
    expectedRevision: s.revision,
    action: "start",
  });
  assert.equal(result.suggestion.status, "obsolete");
  assert.equal(f.source.writes, 0);
});

test("pending conversational corrections block old-plan reminders and semantic quiet stays silent", async (t) => {
  const model = await modelFixture(t, () => ({
    name: "heartbeat_respond",
    arguments: { suggestions: [] },
  }));
  const server = await taskRuntime(t, {
    mode: "live",
    agentBackend: "model",
    model: "openai/fixture",
    memoryLearningEnabled: true,
    semanticProactivityEnabled: true,
  });
  await server.agent.memory.save("owner", "Vou viajar para Lisboa.", "User", {
    category: "plan",
    evidence: [
      {
        messageId: "trip",
        threadId: "chat",
        quote: "Vou viajar para Lisboa",
        observedAt: new Date().toISOString(),
      },
    ],
    followUp: { state: "open", after: "2020-01-01T00:00:00Z" },
  });
  await server.db.put("owner", "conversation-inbox", {
    id: "chat:cancel",
    messageId: "cancel",
    threadId: "chat",
    createdAt: new Date().toISOString(),
    text: "Não vou mais viajar.",
    status: "finished",
  });
  await server.agent.proactivity.scheduleDue("owner");
  await server.agent.worker.tick();
  assert.equal((await server.agent.proactivity.list("owner")).length, 0);
  assert.equal(
    model.requests.length,
    0,
    "do not ask the model about plans with unprocessed corrections",
  );
  const cycle = (await server.agent.proactivity.status("owner")).latestCycle;
  assert.equal(cycle?.coverage.memories?.complete, false);
});

test("learning a cancellation retires an already published plan reminder immediately", async (t) => {
  let candidateId = "";
  await modelFixture(t, () => ({
    name: "heartbeat_respond",
    arguments: {
      suggestions: [{ candidateId, title: "Viagem", reason: "Quer retomar os preparativos?" }],
    },
  }));
  const server = await taskRuntime(t, {
    mode: "live",
    agentBackend: "model",
    model: "openai/fixture",
    semanticProactivityEnabled: true,
  });
  const old = {
    id: "chat:trip",
    messageId: "trip",
    threadId: "chat",
    text: "Quero viajar para Lisboa.",
    createdAt: "2026-01-01T00:00:00Z",
  } as import("../apps/server/src/conversation-inbox.ts").InboxMessage;
  const m = await server.agent.learning.learn(
    "owner",
    {
      text: old.text,
      category: "plan",
      followUpAfter: "2020-01-01T00:00:00Z",
      evidence: [{ messageId: old.messageId, quote: old.text }],
    },
    [old],
    "review-trip",
  );
  candidateId = `memory:${m.id}`;
  await server.agent.proactivity.scheduleDue("owner");
  await server.agent.worker.tick();
  assert.equal((await server.agent.proactivity.list("owner"))[0].status, "pending");
  const cancel = {
    ...old,
    messageId: "cancel",
    text: "Desisti da viagem para Lisboa.",
    createdAt: "2026-01-02T00:00:00Z",
  };
  await server.agent.learning.learn(
    "owner",
    {
      text: cancel.text,
      category: "plan",
      planState: "cancelled",
      memoryId: m.id,
      expectedRevision: 1,
      evidence: [{ messageId: cancel.messageId, quote: cancel.text }],
    },
    [cancel],
    "review-cancel",
  );
  assert.equal((await server.agent.proactivity.list("owner"))[0].status, "obsolete");
});

test("important notification mail without reply cues is considered and its changed source blocks acceptance", async (t) => {
  await modelFixture(t, () => ({
    name: "heartbeat_respond",
    arguments: {
      suggestions: [
        {
          candidateId: "mail:fixture-google:thread-one",
          title: "Check-in termina amanhã",
          reason: "O prazo informado é amanhã. Quer ajuda com o check-in?",
        },
      ],
    },
  }));
  const f = await fixture(t, {
    semanticProactivityEnabled: true,
    modelProviders: richChatFixtureProviders("/tmp/proactivity-model-fixture"),
  });
  f.source.messages = [
    message("incoming", "Your flight check-in closes tomorrow at 10:00. No reply needed."),
  ];
  const suggestions = await review(f);
  assert.equal(
    suggestions.length,
    1,
    "attention-worthy notification does not require a reply keyword",
  );
  const s = suggestions[0];
  assert.equal(s.target.kind, "mail");
  assert.equal(f.source.writes, 0);
  f.source.messages = [message("incoming", "Your flight was cancelled. No reply needed.")];
  const answer = await f.server.agent.proactivity.respond("local-user", s.id, {
    requestId: s.requestId,
    clientResponseId: "stale-flight",
    expectedRevision: s.revision,
    action: "start",
  });
  assert.equal(answer.suggestion.status, "obsolete");
  assert.equal(f.source.writes, 0);
});

test("a cancelled or forgotten plan cannot authorize follow-up work, including after acceptance", async (t) => {
  let candidateId = "";
  await modelFixture(t, () => ({
    name: "heartbeat_respond",
    arguments: {
      suggestions: [
        { candidateId, title: "Retomar viagem", reason: "Quer ajuda para retomar a viagem?" },
      ],
    },
  }));
  const server = await taskRuntime(t, {
    mode: "live",
    agentBackend: "model",
    model: "openai/fixture",
    semanticProactivityEnabled: true,
  });
  const memory = await server.agent.memory.save("owner", "Viagem a Lisboa.", "User", {
    category: "plan",
    evidence: [
      {
        messageId: "trip",
        threadId: "chat",
        quote: "Viagem a Lisboa",
        observedAt: new Date().toISOString(),
      },
    ],
    followUp: { state: "open", after: "2020-01-01T00:00:00Z" },
  });
  candidateId = `memory:${memory.id}`;
  await server.agent.proactivity.scheduleDue("owner");
  await server.agent.worker.tick();
  const s = (await server.agent.proactivity.list("owner"))[0];
  assert.ok(s);
  const accepted = await server.agent.proactivity.respond("owner", s.id, {
    requestId: s.requestId,
    clientResponseId: "help-trip",
    expectedRevision: s.revision,
    action: "start",
  });
  assert.ok(accepted.task);
  await server.agent.memory.forget("owner", memory.id);
  await assert.rejects(
    server.agent.proactivity.revalidateTask("owner", accepted.task),
    /plan.*changed|forgotten/i,
  );
});
