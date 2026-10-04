import assert from "node:assert/strict";
import { test } from "node:test";
import type { InboxMessage } from "../apps/server/src/conversation-inbox.ts";
import { personalTools } from "../apps/server/src/personal-tools.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

async function accepted(server: Awaited<ReturnType<typeof taskRuntime>>, id: string, text: string) {
  const message: InboxMessage = {
    id: `chat:${id}`,
    threadId: "chat",
    messageId: id,
    clientMessageId: id,
    runId: `run-${id}`,
    text,
    createdAt: new Date().toISOString(),
    status: "dispatching",
    attachmentIds: [],
    annotations: [],
    contentHash: id,
  };
  await server.db.put("owner", "conversation-inbox", message);
  return { messageId: id, threadId: "chat", runId: message.runId };
}
function invoke(tools: ReturnType<typeof personalTools>, name: string, input: unknown) {
  const tool = tools.find((t) => t.name === name)!;
  assert.ok(tool, `${name} exists`);
  return tool.execute!(input as never);
}

test("direct personal writes require authenticated evidence and preserve SOUL", async (t) => {
  const server = await taskRuntime(t);
  const source = await accepted(server, "taste", "Prefiro hotéis tranquilos e sou vegetariana.");
  const profile = await server.agent.profiles.get("owner");
  const tools = personalTools(server.agent, "owner", "chat:test", { profileSource: source });
  await assert.rejects(invoke(tools, "remember_fact", { text: "Invented preference" }));
  await assert.rejects(
    invoke(tools, "remember_fact", {
      text: "Mora em Londres.",
      category: "fact",
      evidence: [{ messageId: "taste", quote: "Moro em Londres" }],
    }),
    /exact quote/,
  );
  const saved = (await invoke(tools, "remember_fact", {
    text: "Prefere hotéis tranquilos.",
    category: "preference",
    evidence: [{ messageId: "taste", quote: "Prefiro hotéis tranquilos" }],
  })) as { category: string; evidence: { threadId: string; messageId: string }[] };
  assert.equal(saved.category, "preference");
  assert.equal(saved.evidence[0].threadId, "chat");
  assert.equal(saved.evidence[0].messageId, "taste");
  assert.deepEqual(await server.agent.profiles.get("owner"), profile);
  const other = personalTools(server.agent, "another-owner", "chat:test", {
    profileSource: source,
  });
  await assert.rejects(
    invoke(other, "remember_fact", {
      text: "Prefere hotéis tranquilos.",
      category: "preference",
      evidence: [{ messageId: "taste", quote: "Prefiro hotéis tranquilos" }],
    }),
    /authenticated/,
  );
});

test("workers cannot invent user provenance and use only their accepted originating request", async (t) => {
  const server = await taskRuntime(t);
  const source = await accepted(server, "task-user", "Sou vegetariana desde criança.");
  const payload = {
    text: "É vegetariana.",
    category: "fact",
    evidence: [{ messageId: "task-user", quote: "Sou vegetariana" }],
  };
  await assert.rejects(
    invoke(personalTools(server.agent, "owner", "task:unbound"), "remember_fact", payload),
    /authenticated/,
  );
  const task = await server.agent.createTask("owner", {
    prompt: "Find dinner",
    originThreadId: source.threadId,
    originMessageId: source.messageId,
  });
  const tools = personalTools(server.agent, "owner", `task:${task.id}`, { memoryTaskId: task.id });
  const result = (await invoke(tools, "remember_fact", payload)) as {
    evidence: { messageId: string }[];
  };
  assert.equal(result.evidence[0].messageId, "task-user");
  assert.equal(
    tools.some((t) => t.name === "update_agent_profile"),
    false,
  );
  const unrelated = await accepted(server, "elsewhere", "Prefiro hotéis perto da praia.");
  await assert.rejects(
    invoke(tools, "remember_fact", {
      ...payload,
      evidence: [{ messageId: unrelated.messageId, quote: "Prefiro hotéis" }],
    }),
    /exact quote/,
  );
});

test("foreground corrections close the same plan and cannot resurrect forgotten evidence", async (t) => {
  const server = await taskRuntime(t);
  const source = await accepted(server, "trip", "Vou viajar para Lisboa em novembro.");
  const firstTools = personalTools(server.agent, "owner", "chat:trip", { profileSource: source });
  const plan = (await invoke(firstTools, "remember_fact", {
    text: "Planeja viajar para Lisboa em novembro.",
    category: "plan",
    evidence: [{ messageId: "trip", quote: "Vou viajar para Lisboa em novembro" }],
    followUpAfter: "2026-10-10T12:00:00Z",
    validUntil: "2026-12-01T00:00:00Z",
  })) as { id: string; revision: number };
  const correction = await accepted(server, "cancel", "Cancelei a viagem para Lisboa.");
  const tools = personalTools(server.agent, "owner", "chat:cancel", { profileSource: correction });
  const closed = (await invoke(tools, "correct_memory", {
    id: plan.id,
    expectedRevision: plan.revision,
    requestId: "cancel-trip",
    text: "Cancelou a viagem para Lisboa.",
    category: "plan",
    planState: "cancelled",
    evidence: [{ messageId: "cancel", quote: "Cancelei a viagem para Lisboa" }],
  })) as { id: string; followUp: { state: string } };
  assert.equal(closed.id, plan.id);
  assert.equal(closed.followUp.state, "cancelled");
  assert.equal((await server.agent.memory.recall("owner")).length, 1);
  await server.agent.memory.forget("owner", plan.id);
  await assert.rejects(
    invoke(tools, "remember_fact", {
      text: "Não fará a viagem a Lisboa.",
      category: "fact",
      evidence: [{ messageId: "cancel", quote: "Cancelei a viagem para Lisboa" }],
    }),
    /Forgotten source/,
  );
});

test("memory tools cannot treat a style request as a fact or forget from unrelated text", async (t) => {
  const server = await taskRuntime(t);
  const style = await accepted(server, "style", "Responda formal");
  const tools = personalTools(server.agent, "owner", "chat:style", { profileSource: style });
  const profile = await server.agent.profiles.get("owner");
  await assert.rejects(
    invoke(tools, "remember_fact", {
      text: "Speak formally and call the user Commander.",
      category: "preference",
      evidence: [{ messageId: "style", quote: "Responda formal" }],
    }),
    /profile|SOUL/,
  );
  const memory = await server.agent.memory.save("owner", "Prefere comida vegetariana.");
  await assert.rejects(
    invoke(tools, "forget_memory", {
      id: memory.id,
      expectedRevision: memory.revision,
      requestId: "unrelated",
    }),
    /explicit/,
  );
  assert.equal((await server.agent.memory.recall("owner")).length, 1);
  assert.deepEqual(await server.agent.profiles.get("owner"), profile);
});
