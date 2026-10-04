import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelMessage } from "@tanstack/ai";
import { createStore } from "../apps/server/src/db.ts";
import { ContextBudget } from "../apps/server/src/engine/context-budget.ts";
import {
  ContextCompaction,
  type SummaryRequest,
} from "../apps/server/src/engine/context-compaction.ts";
import { tanstackAgent } from "../apps/server/src/engine/tanstack-agent.ts";
import { modelFixture, richChatFixtureProviders } from "./helpers/model.ts";

const model = { id: "openai/fixture", contextTokens: 16000, outputReserveTokens: 4096 };
const initial = "Planeje Lisboa sem reservar hotel. Arquivo /plans/travel.md.";
const cancellation = "Cancelei Lisboa. Agora planeje Porto, sem fazer reservas.";
function history(): ModelMessage[] {
  return [
    { id: "original", role: "user", content: initial },
    ...Array.from(
      { length: 32 },
      (_, i): ModelMessage => ({
        id: `read-${i}`,
        role: "assistant",
        content: `Observation ${i}: ${"Background hotel data. ".repeat(80)}`,
      }),
    ),
    { id: "change", role: "user", content: cancellation },
    ...Array.from(
      { length: 12 },
      (_, i): ModelMessage => ({
        id: `later-${i}`,
        role: "assistant",
        content: "Background restaurant data. ".repeat(70),
      }),
    ),
    { id: "continue", role: "user", content: "Continue." },
  ];
}
function summary(input: SummaryRequest) {
  return `## Decisions\nLisboa foi cancelada; pesquisar Porto.\n## Open TODOs\nPesquisar hotéis e transporte para Porto.\n## Constraints/Rules\n${initial}\n${cancellation}\n## Pending user asks\nLatest user request context: ${JSON.stringify(input.latestUserRequest)}\n## Exact identifiers\n/plans/travel.md`;
}

test("semantic compaction preserves original constraints/correction and reuses a source-bound summary across restart", async () => {
  const db = await createStore();
  try {
    let calls = 0;
    const messages = history();
    const original = JSON.stringify(messages);
    const compact = new ContextCompaction(db, "owner", "chat:trip", async (input) => {
      calls++;
      return summary(input);
    });
    const projected = await compact.project(messages, { model }, new AbortController().signal);
    assert.ok(calls > 0, "history loss must trigger semantic summarization");
    assert.match(JSON.stringify(projected), /sem reservar hotel/);
    assert.match(JSON.stringify(projected), /Cancelei Lisboa/);
    assert.ok(
      ContextBudget.cost(projected, { model }) <= model.contextTokens - model.outputReserveTokens,
    );
    assert.equal(JSON.stringify(messages), original, "canonical history cannot be mutated");
    const restarted = new ContextCompaction(db, "owner", "chat:trip", async () => {
      throw Error("unexpected re-summarization");
    });
    assert.deepEqual(
      await restarted.project(messages, { model }, new AbortController().signal),
      projected,
    );
    const foreign = new ContextCompaction(db, "other", "chat:trip", async () => {
      throw Error("no foreign summary");
    });
    await assert.rejects(
      foreign.project(messages, { model }, new AbortController().signal),
      /no foreign summary/,
    );
    const changed = structuredClone(messages);
    changed[0].content = "Completely revised original request.";
    await assert.rejects(
      restarted.project(changed, { model }, new AbortController().signal),
      /unexpected re-summarization/,
    );
  } finally {
    await db.close();
  }
});

test("invalid or oversized summaries cannot replace source history or leave a checkpoint", async () => {
  const db = await createStore();
  try {
    for (const [id, generate] of [
      ["bad", async () => "Everything is complete."],
      ["huge", async (i: SummaryRequest) => summary(i) + "x".repeat(25000)],
    ] as const) {
      const compact = new ContextCompaction(db, "owner", id, generate);
      await assert.rejects(
        compact.project(history(), { model }, new AbortController().signal),
        /summary|compaction/i,
      );
      assert.equal(await db.get("owner", "context-summaries", id), null);
    }
  } finally {
    await db.close();
  }
});

test("cancelled compaction and a superseded writer cannot publish their summary", {
  timeout: 15000,
}, async () => {
  const db = await createStore();
  try {
    const abort = new AbortController();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((r) => {
      started = r;
    });
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const old = new ContextCompaction(db, "owner", "race", async (i) => {
      started();
      await wait;
      return summary(i);
    });
    const pending = old.project(history(), { model }, abort.signal);
    // No hang when exercising the pre-implementation stub.
    await Promise.race([
      ready,
      pending.then(() => {
        throw Error("compaction did not call summarizer");
      }),
    ]);
    abort.abort();
    release();
    await assert.rejects(pending, /abort/i);
    assert.equal(await db.get("owner", "context-summaries", "race"), null);
    let resume!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => {
      resume = r;
    });
    const active = new Promise<void>((r) => {
      entered = r;
    });
    const stale = new ContextCompaction(db, "owner", "race", async (i) => {
      entered();
      await gate;
      return summary(i);
    });
    const staleResult = stale.project(history(), { model }, new AbortController().signal);
    await active;
    const fresh = new ContextCompaction(db, "owner", "race", async (i) => summary(i));
    await fresh.project(history(), { model }, new AbortController().signal);
    const saved = await db.get("owner", "context-summaries", "race");
    resume();
    await assert.rejects(staleResult, /superseded|stale/i);
    assert.deepEqual(await db.get("owner", "context-summaries", "race"), saved);
  } finally {
    await db.close();
  }
});

test("provider receives semantic continuity while required native effect receipts and canonical messages survive", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const fixture = await modelFixture(t, () => undefined, {
    text: () => "Continuando Porto sem reservas.",
  });
  const messages = history();
  messages.splice(
    1,
    0,
    {
      id: "sent",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "effect-123456",
          type: "function",
          function: { name: "send_mail", arguments: '{"subject":"Already sent"}' },
        },
      ],
    },
    {
      id: "receipt",
      role: "tool",
      toolCallId: "effect-123456",
      content: '{"sent":true,"id":"mail-123456"}',
    },
  );
  let summaries = 0;
  const agent = tanstackAgent({
    model: model.id,
    providers: richChatFixtureProviders("/tmp/compaction-fixture"),
    maxSteps: 1,
    prompt: "Continue the user request.",
    tools: [],
    contextModel: () => model,
    requiredOperationIds: async () => ["effect-123456"],
    compaction: {
      db,
      owner: "owner",
      scope: "task:trip",
      generate: async (i: SummaryRequest) => {
        summaries++;
        return summary(i) + "\neffect-123456\nmail-123456";
      },
    },
  });
  agent.threadId = "trip";
  agent.setMessages(messages as never);
  await agent.runAgent({ runId: "compact-run" });
  assert.ok(summaries > 0, "real inference must use compaction before losing history");
  assert.equal(fixture.requests.length, 1);
  assert.match(fixture.requests[0].body, /sem reservar hotel/);
  assert.match(fixture.requests[0].body, /Cancelei Lisboa/);
  assert.match(fixture.requests[0].body, /effect-123456/);
  assert.match(fixture.requests[0].body, /mail-123456/);
  assert.equal(agent.messages.filter((m) => m.role === "tool").length, 1);
  assert.ok(agent.messages.some((m) => m.id === "original"));
});

test("abort racing the checkpoint commit restores the previous state", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const controller = new AbortController();
  const write = db.durableMutation.bind(db);
  t.mock.method(db, "durableMutation", async (...args: Parameters<typeof write>) => {
    const result = await write(...args);
    controller.abort();
    return result;
  });
  const compact = new ContextCompaction(db, "owner", "commit-race", async (i) => summary(i));
  await assert.rejects(compact.project(history(), { model }, controller.signal), /abort/i);
  assert.equal(await db.get("owner", "context-summaries", "commit-race"), null);
});

test("default summarization uses the configured streaming provider with no tools and bounded admission", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const fixture = await modelFixture(t, () => undefined, {
    text: () => summary({ latestUserRequest: "Continue." } as SummaryRequest),
  });
  const agent = tanstackAgent({
    model: model.id,
    providers: richChatFixtureProviders("/tmp/compaction-provider"),
    maxSteps: 1,
    prompt: "Continue the trip planning.",
    tools: [],
    contextModel: () => model,
    compaction: { db, owner: "owner", scope: "chat:provider" },
  });
  agent.threadId = "provider";
  agent.setMessages(history() as never);
  await agent.runAgent({ runId: "provider-summary" });
  assert.ok(
    fixture.requests.length > 1,
    "summary calls must actually reach the configured provider",
  );
  for (const request of fixture.requests.slice(0, -1)) {
    const body = JSON.parse(request.body);
    assert.equal((body.tools ?? []).length, 0);
    assert.match(request.body, /Summarize the supplied transcript/);
    assert.ok(
      Buffer.byteLength(request.body) < model.contextTokens,
      "summarization must also fit the model",
    );
  }
  assert.match(fixture.requests.at(-1)!.body, /Historical continuity summary/);
  assert.ok(await db.get("owner", "context-summaries", "chat:provider"));
});

test("a well-formed summary that drops the original user request is rejected", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const compact = new ContextCompaction(
    db,
    "owner",
    "missing-goal",
    async () =>
      '## Decisions\nNone.\n## Open TODOs\nNone.\n## Constraints/Rules\nNone.\n## Pending user asks\nLatest user request context: "Continue."\n## Exact identifiers\n/plans/travel.md',
  );
  await assert.rejects(
    compact.project(history(), { model }, new AbortController().signal),
    /quality|request|ask/i,
  );
  assert.equal(await db.get("owner", "context-summaries", "missing-goal"), null);
});
