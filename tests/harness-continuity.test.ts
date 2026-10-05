import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { lastValueFrom, toArray } from "rxjs";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { needsResearchReview } from "../apps/server/src/engine/research-delivery-review.ts";
import { LocalThreads } from "../apps/server/src/threads.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("delegated follow-up retains the user's election, source receipt and preceding result in worker context", async (t) => {
  const fixture = await modelFixture(t, (i) =>
    i === 0
      ? {
          name: "delegate_task",
          arguments: { kind: "agent", title: "Mapa por estado", prompt: "Make the requested map" },
        }
      : i === 2
        ? { name: "finish_task", arguments: { summary: "Context preserved" } }
        : undefined,
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const previous = await f.agent.createTask("owner", {
    prompt: "Apuração presidencial de 2026",
    originThreadId: "continuity",
  });
  await f.db.put("owner", "tasks", {
    ...previous,
    status: "succeeded",
    result: "Candidata A: 52%. Fonte https://news.example/2026/live",
    evidence: [
      {
        id: "observed-feed",
        kind: "web",
        title: "Contagem de 2026",
        url: "https://news.example/2026/live",
        excerpt: "Candidata A 52%; candidata B 48%",
        acquiredAt: "2026-10-05T00:10:00Z",
      },
    ],
  });
  await f.db.put("another-owner", "tasks", {
    ...previous,
    id: "foreign-task",
    status: "succeeded",
    result: "other-owner-secret",
    originThreadId: "continuity",
  });
  const messages = [
    { id: "year", role: "user" as const, content: "Como está a apuração presidencial de 2026?" },
    {
      id: "result",
      role: "assistant" as const,
      content: "Candidata A: 52%. Fonte https://news.example/2026/live",
    },
    {
      id: "map",
      role: "user" as const,
      content: "Agora faça o infográfico com esses dados e um mapa por estado.",
    },
  ];
  await lastValueFrom(
    new ConversationAgent(f.agent.config, f.agent, "owner")
      .run({
        threadId: "continuity",
        runId: randomUUID(),
        messages,
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  await f.agent.worker.tick();
  const workerRequest = fixture.requests[2]?.body ?? "";
  assert.match(workerRequest, /apuração presidencial de 2026/);
  assert.match(workerRequest, /https:\/\/news.example\/2026\/live/);
  assert.match(workerRequest, /observed-feed/);
  assert.doesNotMatch(workerRequest, /other-owner-secret/);
});

test("task progress persists completed and current steps through actual todo tool calls", async (t) => {
  let observed = false;
  const fixture = await modelFixture(
    t,
    async (i) => {
      if (i === 0)
        return {
          name: "todo_list",
          arguments: {
            todos: [
              { id: "sources", content: "Conferir fontes", status: "in_progress" },
              { id: "map", content: "Preparar resumo", status: "pending" },
            ],
          },
        };
      if (i === 1) return { name: "web_fetch", arguments: { url: "https://news.example/live" } };
      if (i === 2)
        return {
          name: "todo_list",
          arguments: {
            merge: true,
            todos: [
              { id: "sources", status: "completed" },
              { id: "map", status: "in_progress" },
            ],
          },
        };
      const saved = await f.agent.getTask("owner", task.id);
      observed = saved.plan[0]?.status === "succeeded" && saved.plan[1]?.status === "running";
      return {
        name: "finish_task",
        arguments: {
          summary: "Dados conferidos: A tem 51%, B tem 49%. Fonte: https://news.example/live",
        },
      };
    },
    {
      researchReview: () => ({
        complete: true,
        needsMoreResearch: false,
        missing: [],
        nextSteps: [],
      }),
    },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<title>Contagem</title><main>A: 51%, B: 49%. Dados completos de todos os votos.</main>",
  }));
  const task = await f.agent.createTask("owner", { prompt: "Pesquise e resuma as fontes" });
  await f.agent.worker.tick();
  assert.ok(observed, "completed and running steps must be visible before task finishes");
  assert.ok(
    (await f.agent.getTask("owner", task.id)).plan.every((step) => step.status === "succeeded"),
    "verified completion must close the displayed plan",
  );
  assert.ok(
    JSON.parse(fixture.requests[0].body).tools.some(
      (x: { name: string }) => x.name === "todo_list",
    ),
    "planning must be available immediately",
  );
});

test("creating an image does not bypass research validation", async (t) => {
  const f = await taskRuntime(t);
  const task = await f.agent.createTask("owner", {
    prompt: "Faça um mapa com os resultados por estado",
  });
  assert.equal(
    needsResearchReview({ ...task, artifactIds: ["an-image"] }, [
      { toolName: "web_fetch" },
    ] as never),
    true,
  );
});

test("a correction is delivered to the existing worker instead of creating a competing task", async (t) => {
  await modelFixture(t, (i) =>
    i === 0 ? { name: "continue_task", arguments: { taskId: task.id } } : undefined,
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", {
    prompt: "Prepare o mapa eleitoral",
    originThreadId: "correction",
  });
  await lastValueFrom(
    new ConversationAgent(f.agent.config, f.agent, "owner")
      .run({
        threadId: "correction",
        runId: randomUUID(),
        messages: [
          {
            id: "correct-year",
            role: "user",
            content: "Estou falando de 2026; use os dados que você já encontrou",
          },
        ],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  const tasks = (await f.agent.snapshot("owner")).tasks;
  assert.equal(tasks.length, 1);
  const directions = await f.agent.mailbox.list("owner", task.id);
  assert.equal(directions.length, 1);
  assert.match(directions[0]!.text, /Estou falando de 2026/);
});

test("handoff can acknowledge and react in its first inference without a second model round trip", async (t) => {
  const fixture = await modelFixture(t, (i) =>
    i === 0
      ? {
          name: "delegate_task",
          arguments: {
            kind: "agent",
            prompt: "Criar o infográfico",
            acknowledgment: "Vou montar o mapa com esses dados.",
            reaction: "🗺️",
          },
        }
      : undefined,
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const messages = [
    { id: "fast-message", role: "user" as const, content: "Faça um infográfico com esses dados" },
  ];
  assert.ok(f.threads instanceof LocalThreads);
  await f.threads.ensure("owner", "fast");
  // Canonical accepted message is needed by the real reaction service.
  await f.db.put("owner", "thread-runs", {
    id: "fast-run",
    threadId: "fast",
    runId: "fast-run",
    createdAt: new Date().toISOString(),
    status: "finished",
    events: [],
    messages,
    state: {},
  });
  const events = await lastValueFrom(
    new ConversationAgent(f.agent.config, f.agent, "owner")
      .run({ threadId: "fast", runId: randomUUID(), messages, tools: [], context: [], state: {} })
      .pipe(toArray()),
  );
  const text = events
    .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
    .map((e) => String(e.delta ?? ""))
    .join("");
  assert.equal(
    text,
    "Vou montar o mapa com esses dados.",
    JSON.stringify(events.filter((e) => e.type === "RUN_ERROR" || e.type === "TOOL_CALL_RESULT")),
  );
  assert.equal(fixture.requests.length, 1, "acknowledgment must not need another inference");
  const handoff = JSON.parse(fixture.requests[0]!.body).tools.find(
    (tool: { name: string }) => tool.name === "delegate_task",
  );
  assert.ok(handoff.parameters.required.includes("acknowledgment"));
  assert.ok(handoff.parameters.required.includes("reaction"));
  assert.equal(handoff.strict, true, "the provider must enforce the first-call acknowledgment");
  assert.equal(handoff.parameters.properties.input, undefined);
  assert.deepEqual(
    handoff.parameters.properties.kind.enum.filter((value: unknown) => value !== null),
    ["agent"],
  );
  const social = await f.agent.social!.state("owner", "fast");
  assert.ok(
    social.reactions.some(
      (r) => r.actor === "assistant" && r.messageId === "fast-message" && r.emoji === "🗺️",
    ),
  );
});

test("a truncated old tool call cannot prevent a new handoff or erase its source receipt", async () => {
  const { delegatedContext } = await import("../apps/server/src/engine/delegated-context.ts");
  const messages = [
    { id: "q", role: "user" as const, content: "Presidencial 2026" },
    {
      id: "broken",
      role: "assistant" as const,
      content: "",
      toolCalls: [
        {
          id: "old-read",
          type: "function" as const,
          function: { name: "web_fetch", arguments: '{"url":"https://news.example' },
        },
      ],
    },
    {
      id: "receipt",
      role: "tool" as const,
      toolCallId: "old-read",
      content: '{"url":"https://news.example/live","text":"A: 51%"}',
    },
    { id: "new", role: "user" as const, content: "Faça um mapa com esses dados" },
  ];
  const before = JSON.stringify(messages);
  const inherited = delegatedContext(messages, [], "new");
  assert.match(JSON.stringify(inherited), /Presidencial 2026/);
  assert.match(JSON.stringify(inherited), /news.example\/live/);
  assert.equal(JSON.stringify(messages), before, "source transcript must stay untouched");
});

test("research review retains every small source in a multi-region delivery", async (t) => {
  const { reviewResearchDelivery } = await import(
    "../apps/server/src/engine/research-delivery-review.ts"
  );
  let request = "";
  await modelFixture(t, () => undefined, {
    researchReview: (body) => {
      request = body;
      return { complete: true, missing: [], nextSteps: [] };
    },
  });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", { prompt: "Compare all 27 regional results" });
  const pages = Array.from({ length: 27 }, (_, i) => ({
    url: `https://news.example/region/${i}`,
    text: JSON.stringify({ region: i, candidates: { a: 51, b: 49 } }),
    links: [],
    truncated: false,
  }));
  await reviewResearchDelivery({
    task,
    summary: "All 27 regions: A 51%, B 49%",
    operations: pages.map((receipt, i) => ({
      id: `read-${i}`,
      toolName: "web_fetch",
      status: "succeeded",
      args: { url: receipt.url },
      receipt,
    })) as never,
    model: "openai/fixture",
    providers: f.agent.config.modelProviders!,
    structured: false,
    signal: new AbortController().signal,
  });
  for (const page of pages) assert.ok(request.includes(page.url), `Reviewer lost ${page.url}`);
});
