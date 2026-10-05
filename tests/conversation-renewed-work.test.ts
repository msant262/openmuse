import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { EventType } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { LocalThreads } from "../apps/server/src/threads.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

function turn(threadId: string, content: string) {
  return {
    threadId,
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: "user" as const, content }],
    tools: [],
    context: [],
    state: {},
  };
}

test("acknowledgment retains tool errors after a correction was already admitted", async (t) => {
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const threadId = randomUUID();
  const task = await server.agent.createTask("owner", {
    prompt: "Prepare o relatório",
    originThreadId: threadId,
  });
  const fixture = await modelFixture(t, (index) =>
    index === 0
      ? { name: "continue_task", arguments: { taskId: task.id } }
      : index === 1
        ? {
            name: "tool_call",
            arguments: {
              id: "okami_continue_task",
              args: { taskId: task.id, message: "Already recorded correction" },
            },
          }
        : undefined,
  );
  const events = await lastValueFrom(
    new ConversationAgent(server.agent.config, server.agent, "owner")
      .run(turn(threadId, "Inclua também as fontes"))
      .pipe(toArray()),
  );
  assert.equal(fixture.requests.length, 3);
  assert.match(
    fixture.requests[2].body,
    /must not have additional properties/,
    "discarding this error makes the acknowledgment repeat the same invalid tool call",
  );
  assert.equal((await server.agent.mailbox.list("owner", task.id)).length, 1);
  assert.equal((await server.agent.snapshot("owner")).tasks.length, 1);
  assert.ok(events.some((event) => event.type === EventType.TEXT_MESSAGE_CONTENT));
  assert.ok(!events.some((event) => event.type === EventType.RUN_ERROR));
});

test("asking for a saved result after completion does not start another job", async (t) => {
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const threadId = randomUUID();
  const old = await server.agent.createTask("owner", {
    prompt: "Pesquise os dados",
    originThreadId: threadId,
  });
  await server.db.put("owner", "tasks", {
    ...old,
    status: "succeeded",
    result: "O relatório salvo tem três fontes.",
  });
  await modelFixture(
    t,
    (index) => (index === 0 ? { name: "agent_status", arguments: {} } : undefined),
    {
      text: () => "O relatório salvo tem três fontes.",
    },
  );
  const events = await lastValueFrom(
    new ConversationAgent(server.agent.config, server.agent, "owner")
      .run(turn(threadId, "Qual foi o resultado daquela pesquisa? Não pesquise de novo."))
      .pipe(toArray()),
  );
  const receipt = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(receipt);
  assert.match(String(receipt.content), /O relatório salvo tem três fontes/);
  assert.equal((await server.agent.snapshot("owner")).tasks.length, 1);
  assert.equal((await server.agent.mailbox.list("owner", old.id)).length, 0);
  assert.ok(
    events.some(
      (event) =>
        event.type === EventType.TEXT_MESSAGE_CONTENT &&
        String(event.delta).includes("três fontes"),
    ),
  );
});

for (const status of ["succeeded", "failed", "cancelled"] as const) {
  test(`a task becoming ${status} during continuation admission cannot acknowledge unapplied work`, async (t) => {
    const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
    const threadId = randomUUID();
    const old = await server.agent.createTask("owner", {
      prompt: "Pesquise os dados atuais",
      originThreadId: threadId,
    });
    const enqueue = server.agent.mailbox.enqueue.bind(server.agent.mailbox);
    t.mock.method(server.agent.mailbox, "enqueue", async (...args: Parameters<typeof enqueue>) => {
      // Finish at the actual boundary between the tool's precheck and durable admission.
      await server.db.put("owner", "tasks", { ...old, status, result: "Resultado anterior" });
      return enqueue(...args);
    });
    await modelFixture(t, (index) =>
      index === 0
        ? { name: "continue_task", arguments: { taskId: old.id } }
        : index === 1
          ? {
              name: "delegate_task",
              arguments: {
                kind: "agent",
                prompt: "Confira também outras fontes",
                acknowledgment: "Vou conferir outras fontes.",
                reaction: null,
              },
            }
          : undefined,
    );
    const events = await lastValueFrom(
      new ConversationAgent(server.agent.config, server.agent, "owner")
        .run(turn(threadId, "Confira também outras fontes"))
        .pipe(toArray()),
    );
    const receipt = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
    assert.ok(receipt);
    const result = JSON.parse(String(receipt.content));
    assert.equal(result.continued, undefined, "an unapplied direction is not accepted work");
    assert.match(result.error ?? "", /delegate_task/);
    assert.equal(
      (await server.agent.mailbox.list("owner", old.id))[0].status,
      "completed_before_apply",
    );
    const tasks = (await server.agent.snapshot("owner")).tasks;
    assert.equal(tasks.length, 2);
    assert.equal(tasks.find((task) => task.id !== old.id)?.prompt, "Confira também outras fontes");
    assert.equal((await server.agent.getTask("owner", old.id)).status, status);
  });
}

for (const status of ["queued", "running", "paused", "waiting_input"] as const) {
  test(`a correction to ${status} work stays on its existing task`, async (t) => {
    const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
    const threadId = randomUUID();
    const task = await server.agent.createTask("owner", {
      prompt: "Prepare o relatório",
      originThreadId: threadId,
    });
    await server.db.put("owner", "tasks", { ...task, status });
    await modelFixture(t, (index) =>
      index === 0 ? { name: "continue_task", arguments: { taskId: task.id } } : undefined,
    );
    const events = await lastValueFrom(
      new ConversationAgent(server.agent.config, server.agent, "owner")
        .run(turn(threadId, "Inclua as fontes e não altere o título"))
        .pipe(toArray()),
    );
    const receipt = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
    assert.ok(receipt);
    assert.equal(JSON.parse(String(receipt.content)).continued, true);
    assert.equal((await server.agent.snapshot("owner")).tasks.length, 1);
    const directions = await server.agent.mailbox.list("owner", task.id);
    assert.equal(directions.length, 1);
    assert.equal(directions[0].text, "Inclua as fontes e não altere o título");
    assert.equal(directions[0].status, "received");
    assert.equal(
      (await server.agent.getTask("owner", task.id)).status,
      status === "waiting_input" ? "queued" : status,
    );
  });
}

for (const status of ["failed", "succeeded", "cancelled"] as const) {
  test(`continuing ${status} work reports an error instead of presenting its old result as a new answer`, async (t) => {
    const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
    const threadId = randomUUID();
    const old = await server.agent.createTask("owner", {
      prompt: "Confira o resultado atual",
      originThreadId: threadId,
    });
    const stale = "Consulta de ontem: fonte indisponível, resultado antigo.";
    await server.db.put("owner", "tasks", { ...old, status, result: stale });
    await modelFixture(t, (index) =>
      index === 0
        ? { name: "continue_task", arguments: { taskId: old.id } }
        : index === 1
          ? {
              name: "delegate_task",
              arguments: {
                kind: "agent",
                prompt: "Confira novamente o resultado de agora",
                acknowledgment: "Vou consultar as fontes de novo.",
                reaction: null,
              },
            }
          : undefined,
    );
    const events = await lastValueFrom(
      new ConversationAgent(server.agent.config, server.agent, "owner")
        .run({
          threadId,
          runId: randomUUID(),
          messages: [
            { id: "old-question", role: "user", content: "Confira o resultado atual" },
            { id: "old-answer", role: "assistant", content: stale },
            {
              id: "new-question",
              role: "user",
              content: "Confira novamente o resultado de agora",
            },
          ],
          tools: [],
          context: [],
          state: {},
        })
        .pipe(toArray()),
    );
    const start = events.find(
      (event) => event.type === EventType.TOOL_CALL_START && event.toolCallName === "continue_task",
    );
    assert.ok(start);
    const receipt = events.find(
      (event) => event.type === EventType.TOOL_CALL_RESULT && event.toolCallId === start.toolCallId,
    );
    assert.ok(receipt);
    const result = JSON.parse(String(receipt.content));
    assert.equal(result.result, undefined, "a failed continuation must not return stale evidence");
    assert.match(result.error ?? "", /delegate_task/);
    const tasks = (await server.agent.snapshot("owner")).tasks;
    const fresh = tasks.find((task) => task.id !== old.id);
    assert.ok(fresh);
    assert.equal(fresh.status, "queued");
    assert.equal(fresh.prompt, "Confira novamente o resultado de agora");
    assert.equal(fresh.originMessageId, "new-question");
    assert.equal((await server.agent.getTask("owner", old.id)).status, status);
    assert.equal((await server.agent.mailbox.list("owner", old.id)).length, 0);
    const text = events
      .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((event) => event.delta)
      .join("");
    assert.equal(text, "Vou consultar as fontes de novo.");
  });
}

test("a malformed correction is repaired and its accepted message remains verbatim across an acknowledgment-loss retry", async (t) => {
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const threadId = randomUUID();
  const task = await server.agent.createTask("owner", {
    prompt: "Prepare o relatório com as fontes",
    originThreadId: threadId,
  });
  await modelFixture(t, (index) =>
    index === 0
      ? {
          name: "tool_call",
          arguments: {
            id: "okami_continue_task",
            args: { taskId: task.id, message: "Invented replacement for the user's words" },
          },
        }
      : index === 1 || index === 3
        ? { name: "continue_task", arguments: { taskId: task.id } }
        : undefined,
  );
  const input = {
    threadId,
    runId: randomUUID(),
    messages: [{ id: "correction", role: "user" as const, content: "Use outras fontes também" }],
    tools: [],
    context: [],
    state: {},
  };
  for (let attempt = 0; attempt < 2; attempt++)
    await lastValueFrom(
      new ConversationAgent(server.agent.config, server.agent, "owner")
        .run({ ...input, runId: randomUUID() })
        .pipe(toArray()),
    );
  assert.equal((await server.agent.snapshot("owner")).tasks.length, 1);
  const directions = await server.agent.mailbox.list("owner", task.id);
  assert.equal(directions.length, 1);
  assert.equal(directions[0].text, "Use outras fontes também");
});

for (const boundary of ["another conversation", "another owner"] as const) {
  test(`a stale task reference from ${boundary} cannot steer work or reveal its result`, async (t) => {
    const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
    const threadId = randomUUID();
    const task = await server.agent.createTask(boundary === "another owner" ? "other" : "owner", {
      prompt: "An unrelated request",
      originThreadId: boundary === "another owner" ? threadId : "other-thread",
    });
    await server.db.put(boundary === "another owner" ? "other" : "owner", "tasks", {
      ...task,
      status: "failed",
      result: "PRIVATE_RESULT_OUTSIDE_THIS_CONVERSATION",
    });
    await modelFixture(t, (index) =>
      index === 0 ? { name: "continue_task", arguments: { taskId: task.id } } : undefined,
    );
    const events = await lastValueFrom(
      new ConversationAgent(server.agent.config, server.agent, "owner")
        .run({
          threadId,
          runId: randomUUID(),
          messages: [{ id: "message", role: "user", content: "Qual o andamento?" }],
          tools: [],
          context: [],
          state: {},
        })
        .pipe(toArray()),
    );
    const receipt = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
    assert.ok(receipt);
    assert.ok(JSON.parse(String(receipt.content)).error);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_RESULT_OUTSIDE_THIS_CONVERSATION/);
    assert.equal((await server.agent.mailbox.list("owner", task.id)).length, 0);
    assert.equal(
      (await server.agent.snapshot("owner")).tasks.length,
      boundary === "another owner" ? 0 : 1,
    );
  });
}

test("an identical new user message admits fresh work after a partial delivery, while transport replay admits it only once", async (t) => {
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  assert.ok(server.threads instanceof LocalThreads);
  const threads = server.threads;
  const threadId = randomUUID();
  const old = await server.agent.createTask("owner", {
    prompt: "Confira os dados de agora",
    originThreadId: threadId,
  });
  await server.db.put("owner", "tasks", {
    ...old,
    status: "failed",
    result: "A última fonte consultada não estava disponível.",
  });
  await threads.ensure("owner", threadId);
  await server.db.put("owner", "thread-runs", {
    id: "old-run",
    threadId,
    runId: "old-run",
    createdAt: new Date(Date.now() - 1000).toISOString(),
    status: "finished",
    messages: [
      { id: "old-question", role: "user", content: "Confira os dados de agora" },
      {
        id: "old-result",
        role: "assistant",
        content: "A última fonte consultada não estava disponível.",
      },
    ],
    events: [],
    state: {},
  });
  await modelFixture(t, (index) =>
    index === 0
      ? { name: "continue_task", arguments: { taskId: old.id } }
      : index === 1
        ? {
            name: "delegate_task",
            arguments: {
              kind: "agent",
              prompt: "Confira os dados de agora",
              acknowledgment: "Vou buscar uma atualização em outras fontes.",
              reaction: null,
            },
          }
        : undefined,
  );
  const input = {
    threadId,
    runId: randomUUID(),
    messages: [{ id: "new-question", role: "user" as const, content: "Confira os dados de agora" }],
    state: {},
    context: [],
    tools: [],
  };
  for (let attempt = 0; attempt < 2; attempt++)
    await lastValueFrom(
      threads
        .withOwner("owner", () =>
          threads.run({
            threadId,
            agent: new ConversationAgent(server.agent.config, server.agent, "owner"),
            input,
          }),
        )
        .pipe(toArray()),
    );
  const tasks = (await server.agent.snapshot("owner")).tasks;
  assert.equal(tasks.length, 2);
  const fresh = tasks.find((task) => task.id !== old.id);
  assert.equal(fresh?.originMessageId, "new-question");
  assert.equal(fresh?.status, "queued");
  assert.equal(fresh?.prompt, "Confira os dados de agora");
  const history = await threads.history("owner", threadId);
  assert.equal(history.messages.filter((message) => message.id === "new-question").length, 1);
});
