import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { EventType } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { LocalThreads } from "../apps/server/src/threads.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const prompt = "como está as eleições do brasil? como está a apuração?";
test("conversation and worker use the copied harness, broaden research after a failed source, update the plan and retain a useful thread title", async (t) => {
  const calls = [
    {
      name: "delegate_task",
      arguments: {
        kind: "agent",
        title: "Apuração das eleições no Brasil",
        prompt,
        acknowledgment: null,
        reaction: null,
      },
    },
    undefined,
    {
      name: "todo_list",
      arguments: {
        todos: [
          { id: "research", content: "Consultar fontes", status: "in_progress" },
          { id: "report", content: "Entregar resultado", status: "pending" },
        ],
      },
    },
    { name: "web_fetch", arguments: { url: "https://official.example/results" } },
    { name: "web_fetch", arguments: { url: "https://news.example/live" } },
    {
      name: "todo_list",
      arguments: {
        merge: true,
        todos: [
          { id: "research", status: "completed" },
          { id: "report", status: "in_progress" },
        ],
      },
    },
    {
      name: "todo_list",
      arguments: { merge: true, todos: [{ id: "report", status: "completed" }] },
    },
    {
      name: "finish_task",
      arguments: {
        summary:
          "Apuração em andamento: 85% das urnas, às 10h de 5/10/2026. Fonte consultada: https://news.example/live",
      },
    },
  ];
  const fixture = await modelFixture(t, (index) => calls[index], {
    text: (index) => (index === 1 ? "Vou conferir as fontes e trazer o resultado." : undefined),
  });
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const urls: string[] = [];
  const plans: string[][] = [];
  t.mock.method(server.agent.web, "read", async (url: string) => {
    urls.push(url);
    if (url.includes("official.example")) throw new Error("Source temporarily unavailable");
    return {
      url,
      title: "Apuração ao vivo",
      text: "85% das urnas apuradas. Atualização às 10h de 5/10/2026.",
      links: [],
      truncated: false,
    };
  });
  const threadId = randomUUID();
  assert.ok(server.threads instanceof LocalThreads);
  const threads = server.threads;
  await threads.ensure("owner", threadId);
  const events = await lastValueFrom(
    threads
      .withOwner("owner", () =>
        threads.run({
          threadId,
          agent: new ConversationAgent(server.agent.config, server.agent, "owner"),
          input: {
            threadId,
            runId: randomUUID(),
            messages: [{ id: randomUUID(), role: "user", content: prompt }],
            state: {},
            tools: [],
            context: [],
          },
        }),
      )
      .pipe(toArray()),
  );
  assert.deepEqual(
    events.filter((event) => event.type === EventType.RUN_ERROR),
    [],
  );
  assert.ok(
    events.some((event) => event.type === EventType.CUSTOM && event.name === "okami.harness"),
  );
  const [task] = await server.db.list<import("../packages/domain/src/agent.ts").AgentTask>(
    "owner",
    "tasks",
  );
  assert.ok(task);
  assert.equal(task.status, "queued");
  const checkpoint = server.agent.actor.beforeInference.bind(server.agent.actor);
  t.mock.method(
    server.agent.actor,
    "beforeInference",
    async (...args: Parameters<typeof checkpoint>) => {
      const result = await checkpoint(...args);
      plans.push(result.plan.map((step) => step.status));
      return result;
    },
  );
  await server.agent.worker.tick();
  const detail = await server.agent.detail("owner", task.id);
  assert.equal(detail.task.status, "succeeded", detail.task.error ?? detail.task.question);
  assert.match(detail.task.result ?? "", /85%/);
  assert.deepEqual(urls, ["https://official.example/results", "https://news.example/live"]);
  assert.ok(plans.some((plan) => plan.includes("running")));
  assert.ok(plans.some((plan) => plan.includes("succeeded") && plan.includes("running")));
  assert.ok(detail.task.plan.every((step) => step.status === "succeeded"));
  assert.equal((await server.db.list("owner", "interaction-requests")).length, 0);
  const thread = await server.db.get<{ name: string }>("owner", "threads", threadId);
  assert.match(thread?.name ?? "", /eleições do brasil/);
  assert.ok(fixture.requests.every((request) => !request.body.includes('"name":"approve"')));
});
