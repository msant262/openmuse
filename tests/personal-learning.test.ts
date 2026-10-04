import assert from "node:assert/strict";
import { test } from "node:test";
import { messageContentHash } from "../apps/server/src/conversation-inbox.ts";
import { createStore } from "../apps/server/src/db.ts";
import { MemoryService } from "../apps/server/src/memory.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

async function source(server: Awaited<ReturnType<typeof taskRuntime>>, id: string, text: string) {
  const value = {
    threadId: "personal-chat",
    clientMessageId: id,
    text,
    attachmentIds: [],
    annotations: [],
  };
  await server.db.put("owner", "conversation-inbox", {
    ...value,
    id: `personal-chat:${id}`,
    messageId: id,
    runId: `run-${id}`,
    createdAt: new Date().toISOString(),
    contentHash: messageContentHash(value),
    status: "finished",
  });
}

test("saved personal context survives a differently worded question in a new conversation", async () => {
  const db = await createStore();
  try {
    const memory = new MemoryService(db);
    await memory.save("owner", "Sou vegetariana e moro em Berlim.", "User");
    assert.match(await memory.context("owner", "Suggest somewhere for dinner"), /vegetariana/);
    assert.doesNotMatch(await memory.context("another-owner", "dinner"), /vegetariana/);
  } finally {
    await db.close();
  }
});

test("post-conversation review saves a sourced preference without a remember command and coalesces retries", async (t) => {
  const fixture = await modelFixture(t, (i) =>
    i === 0
      ? {
          name: "learn_memory",
          arguments: {
            text: "A usuária prefere hotéis tranquilos.",
            category: "preference",
            evidence: [{ messageId: "taste", quote: "Prefiro hotéis tranquilos" }],
          },
        }
      : undefined,
  );
  const server = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    memoryLearningEnabled: true,
  });
  await source(server, "taste", "Prefiro hotéis tranquilos, longe de festas.");
  assert.ok(server.agent.learning, "automatic learning is connected to the real service");
  const jobs = await Promise.all([
    server.agent.learning.scheduleDue("owner"),
    server.agent.learning.scheduleDue("owner"),
  ]);
  assert.equal(jobs[0], jobs[1]);
  assert.ok(jobs[0]);
  await server.agent.worker.tick();
  const memories = await server.agent.memory.recall("owner");
  assert.equal(memories.length, 1);
  assert.equal(memories[0].category, "preference");
  assert.equal(memories[0].evidence?.[0].messageId, "taste");
  assert.match(
    await server.agent.memory.context("owner", "Where should we stay?"),
    /hotéis tranquilos/,
  );
  assert.equal(await server.agent.learning.scheduleDue("owner"), undefined);
  assert.ok(fixture.requests.length > 0);
  assert.ok(
    fixture.requests.every(
      (r) => !JSON.parse(r.body).tools?.some((t: { name: string }) => t.name === "send_email"),
    ),
  );
});

test("a quiet learning review retains its reason without creating memory", async (t) => {
  const summary = "Only an acknowledgement; no durable fact or reusable method.";
  await modelFixture(t, () => ({ name: "finish_learning", arguments: { summary } }));
  const server = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    memoryLearningEnabled: true,
  });
  await source(server, "thanks", "Obrigado, está tudo certo.");
  const id = await server.agent.learning.scheduleDue("owner");
  assert.ok(id);
  await server.agent.worker.tick();
  const task = await server.agent.getTask("owner", id);
  assert.equal(task.status, "succeeded");
  assert.equal(task.state.learningSummary, summary);
  assert.equal((await server.agent.memory.recall("owner")).length, 0);
});

test("learning refuses unsupported quotes, credentials, wrong owners and forgotten provenance", async (t) => {
  const server = await taskRuntime(t);
  const message = {
    id: "chat:fact",
    messageId: "fact",
    threadId: "chat",
    runId: "run",
    text: "Sou vegetariana desde criança.",
    createdAt: new Date().toISOString(),
    status: "finished",
  } as import("../apps/server/src/conversation-inbox.ts").InboxMessage;
  const input = {
    text: "A usuária é vegetariana.",
    category: "fact",
    evidence: [{ messageId: "fact", quote: "Sou vegetariana" }],
  };
  const fact = await server.agent.learning.learn("owner", input, [message], "review");
  await assert.rejects(
    server.agent.learning.learn(
      "owner",
      { ...input, evidence: [{ messageId: "fact", quote: "Moro em Londres" }] },
      [message],
      "review",
    ),
    /exact quote/,
  );
  await assert.rejects(
    server.agent.learning.learn(
      "other",
      { ...input, memoryId: fact.id, expectedRevision: 1 },
      [message],
      "review",
    ),
    /not found/,
  );
  await assert.rejects(
    server.agent.learning.learn(
      "owner",
      { ...input, text: "password: private-example" },
      [message],
      "review",
    ),
    /credential/,
  );
  await server.agent.memory.forget("owner", fact.id);
  await assert.rejects(
    server.agent.learning.learn(
      "owner",
      { ...input, text: "A usuária segue alimentação vegetariana." },
      [message],
      "another-review",
    ),
    /Forgotten source/,
  );
});

test("a newer correction closes the existing travel plan instead of creating another fact", async (t) => {
  const server = await taskRuntime(t);
  const at = Date.now();
  const first = {
    id: "chat:trip",
    messageId: "trip",
    threadId: "chat",
    text: "Vou viajar para Lisboa em novembro.",
    createdAt: new Date(at - 1000).toISOString(),
  } as import("../apps/server/src/conversation-inbox.ts").InboxMessage;
  const plan = await server.agent.learning.learn(
    "owner",
    {
      text: "Planeja viajar para Lisboa em novembro.",
      category: "plan",
      evidence: [{ messageId: "trip", quote: first.text }],
    },
    [first],
    "review-trip",
  );
  const second = {
    ...first,
    id: "chat:cancel",
    messageId: "cancel",
    text: "Desisti daquela viagem para Lisboa.",
    createdAt: new Date(at + 1000).toISOString(),
  };
  await server.agent.learning.learn(
    "owner",
    {
      text: "Desistiu da viagem para Lisboa.",
      category: "plan",
      memoryId: plan.id,
      expectedRevision: 1,
      planState: "cancelled",
      evidence: [{ messageId: "cancel", quote: second.text }],
    },
    [second],
    "review-cancel",
  );
  const facts = await server.agent.memory.recall("owner");
  assert.equal(facts.length, 1);
  assert.equal(facts[0].followUp?.state, "cancelled");
  assert.equal(facts[0].revision, 2);
  assert.equal((await server.agent.memory.history("owner", plan.id)).entries.length, 2);
});

test("automatic learning is paused with the runtime and resumes with the same unreviewed source", async (t) => {
  const server = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    memoryLearningEnabled: true,
  });
  await source(server, "habit", "Todos os domingos faço caminhada no parque.");
  // Use the real pause authority, not an arbitrary settings record.
  await server.agent.runtimePause.set("owner", { paused: true, expectedRevision: 0 });
  assert.equal(await server.agent.learning.scheduleDue("owner"), undefined);
  await server.agent.runtimePause.set("owner", { paused: false, expectedRevision: 1 });
  assert.ok(await server.agent.learning.scheduleDue("owner"));
});

test("learned procedures require verified work and never overwrite a user-owned procedure", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.taskRecord(
    "owner",
    { prompt: "Compare train fares", title: "Compare fares" },
    "verified-work",
  );
  await server.db.put("owner", "tasks", {
    ...task,
    status: "succeeded",
    completion: { status: "verified", checks: [], remaining: [] },
  });
  await server.db.put("owner", "task-operations", {
    id: "op-read",
    taskId: task.id,
    toolName: "web_fetch",
    status: "succeeded",
    receipt: { url: "https://rail.example", text: "Observed fares" },
  });
  const input = {
    sourceTaskId: task.id,
    title: "Compare current rail fares",
    steps: ["Read current operator fares and compare the requested dates."],
    verification: ["Cite the current fare and its date."],
    requiredTools: ["web_fetch"],
    inputs: [],
    expectedVersion: 0,
    requestId: "save-rail",
  };
  assert.ok(server.agent.playbooks.saveLearned, "verified work has a procedural learning path");
  const learned = await server.agent.playbooks.saveLearned("owner", input, [task.id]);
  assert.equal(learned.learned, true);
  await assert.rejects(
    server.agent.playbooks.saveLearned("owner", { ...input, requestId: "wrong-scope" }, []),
    /review source/,
  );
  const manual = await server.agent.playbooks.save("owner", { ...input, requestId: "manual-rail" });
  await assert.rejects(
    server.agent.playbooks.saveLearned(
      "owner",
      { ...input, id: manual.id, expectedVersion: 1, requestId: "overwrite-manual" },
      [task.id],
    ),
    /user-owned/,
  );
});

test("historical consolidation applies a later cancellation even when both messages predate the review", async (t) => {
  const server = await taskRuntime(t);
  const a = {
    id: "chat:old-plan",
    messageId: "old-plan",
    threadId: "chat",
    text: "Vou para Roma em dezembro.",
    createdAt: "2026-01-01T10:00:00Z",
  } as import("../apps/server/src/conversation-inbox.ts").InboxMessage;
  const b = {
    ...a,
    id: "chat:cancel-plan",
    messageId: "cancel-plan",
    text: "Cancelei a viagem para Roma.",
    createdAt: "2026-01-02T10:00:00Z",
  };
  const saved = await server.agent.learning.learn(
    "owner",
    { text: a.text, category: "plan", evidence: [{ messageId: a.messageId, quote: a.text }] },
    [a],
    "review-old",
  );
  const change = {
    ...a,
    messageId: "new-date",
    text: "A viagem para Roma será em janeiro.",
    createdAt: "2026-01-01T12:00:00Z",
  };
  await server.agent.learning.learn(
    "owner",
    {
      text: change.text,
      category: "plan",
      memoryId: saved.id,
      expectedRevision: 1,
      evidence: [{ messageId: change.messageId, quote: change.text }],
    },
    [change],
    "review-date",
  );
  const corrected = await server.agent.learning.learn(
    "owner",
    {
      text: b.text,
      category: "plan",
      planState: "cancelled",
      memoryId: saved.id,
      expectedRevision: 2,
      evidence: [{ messageId: b.messageId, quote: b.text }],
    },
    [b],
    "review-later",
  );
  assert.equal(corrected.followUp?.state, "cancelled");
  await assert.rejects(
    server.agent.learning.learn(
      "owner",
      {
        text: a.text,
        category: "plan",
        memoryId: saved.id,
        expectedRevision: 3,
        evidence: [{ messageId: a.messageId, quote: a.text }],
      },
      [a],
      "stale-review",
    ),
    /Older evidence/,
  );
});

test("a failed memory correction cannot be reported as a completed no-change review", async (t) => {
  await modelFixture(t, (i) =>
    i === 0
      ? {
          name: "learn_memory",
          arguments: {
            text: "Cancelei a viagem.",
            category: "plan",
            memoryId: "wrong-id",
            expectedRevision: 1,
            planState: "cancelled",
            evidence: [{ messageId: "cancel", quote: "Cancelei a viagem" }],
          },
        }
      : i === 1
        ? { name: "finish_learning", arguments: { summary: "Concluído" } }
        : undefined,
  );
  const server = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    memoryLearningEnabled: true,
  });
  await source(server, "cancel", "Cancelei a viagem.");
  const id = await server.agent.learning.scheduleDue("owner");
  assert.ok(id);
  await server.agent.worker.tick();
  const task = await server.agent.getTask("owner", id);
  assert.notEqual(
    task.status,
    "succeeded",
    "failed persistence cannot acknowledge the source as consolidated",
  );
  assert.equal(await server.agent.learning.settled("owner"), false);
  assert.equal(
    await server.agent.learning.scheduleDue("owner"),
    id,
    "retry the same pending review instead of losing its source",
  );
});
