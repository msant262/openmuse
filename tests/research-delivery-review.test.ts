import assert from "node:assert/strict";
import test from "node:test";
import { modelFixture, offeredHostTools } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("an explicit partial result cannot bypass available research recovery", async (t) => {
  const calls = [
    { name: "web_fetch", arguments: { url: "https://official.example/about" } },
    {
      name: "finish_task",
      arguments: { summary: "The official page has no count.", outcome: "partial" },
    },
    { name: "web_fetch", arguments: { url: "https://news.example/live" } },
    {
      name: "finish_task",
      arguments: {
        summary: "Count: A 52%, B 48%. Source: https://news.example/live",
        outcome: "completed",
      },
    },
  ];
  await modelFixture(t, (i) => calls[i], {
    researchReview: (_body, i) =>
      i === 0
        ? {
            complete: false,
            needsMoreResearch: true,
            missing: ["The current count"],
            nextSteps: ["Read the returned alternative https://news.example/live"],
          }
        : { complete: true, needsMoreResearch: false, missing: [], nextSteps: [] },
  });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const urls: string[] = [];
  t.mock.method(f.agent.web, "document", async (url: string) => {
    urls.push(url);
    return {
      url,
      contentType: "text/html",
      body: url.includes("official.example")
        ? '<article>Election calendar. <a href="https://news.example/live">Live count</a></article>'
        : "<main>A 52%, B 48%.</main>",
    };
  });
  const task = await f.agent.createTask("owner", { prompt: "What is the current count?" });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.result);
  assert.deepEqual(urls, ["https://official.example/about", "https://news.example/live"]);
  assert.match(saved.result ?? "", /52%/);
  assert.equal(saved.completion?.status, "verified");
});

test("new research observations keep the worker moving beyond three delivery reviews", async (t) => {
  const calls = Array.from({ length: 5 }, (_, i) => [
    { name: "web_fetch", arguments: { url: `https://news.example/part-${i}` } },
    {
      name: "finish_task",
      arguments: {
        summary: `Observed section ${i}; source https://news.example/part-${i}`,
        outcome: "completed",
      },
    },
  ]).flat();
  let reviews = 0;
  await modelFixture(t, (i) => calls[i], {
    researchReview: (_body, i) => {
      reviews++;
      return i < 4
        ? {
            complete: false,
            needsMoreResearch: true,
            missing: ["More requested sections"],
            nextSteps: ["Read the next observed section"],
          }
        : { complete: true, needsMoreResearch: false, missing: [], nextSteps: [] };
    },
  });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: `<article>New observed section: ${url}</article>`,
  }));
  const task = await f.agent.createTask("owner", {
    prompt: "What are the latest findings from these pages?",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(
    saved.status,
    "succeeded",
    JSON.stringify({
      completion: saved.completion,
      review: saved.state.researchDeliveryReview,
      operations: (await f.agent.journal.operations("owner", task.id)).map((op) => ({
        name: op.toolName,
        receipt: op.receipt,
      })),
    }),
  );
  assert.equal(reviews, 5);
});

test("research cannot finish with instructions to consult an unread results link; review sends it back to work", async (t) => {
  const calls = [
    { name: "web_fetch", arguments: { url: "https://news.example/about" } },
    {
      name: "finish_task",
      arguments: {
        summary: "I could not read the results. Check https://news.example/live",
        outcome: "completed",
      },
    },
    { name: "web_fetch", arguments: { url: "https://news.example/live" } },
    {
      name: "finish_task",
      arguments: {
        summary:
          "Current count:\n- Candidate A: 52%, 12345 votes.\nSource: https://news.example/live",
        outcome: "completed",
      },
    },
  ];
  let reviews = 0;
  await modelFixture(t, (i) => calls[i], {
    researchReview: (body, index) => {
      reviews++;
      assert.match(body, /how is the count/);
      return index === 0
        ? {
            complete: false,
            missing: ["The actual current count"],
            nextSteps: ["Read the live results link already returned by the source."],
          }
        : { complete: true, missing: [], nextSteps: [] };
    },
  });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: url.endsWith("/about")
      ? '<title>About</title><article>Counting starts today. <a href="/live">Live results</a></article>'
      : "<title>Live</title><main>Candidate A: 52%, 12345 votes</main>",
  }));
  const task = await f.agent.createTask("owner", { prompt: "how is the count?" });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.result);
  assert.match(saved.result ?? "", /12345/);
  assert.equal(reviews, 2);
});

test("an actual unresolved blocker remains partial after the model uses more than three repair attempts", async (t) => {
  const sources = ["official", "news-a", "news-b", "news-c", "archive"].map(
    (name) => `https://${name}.example/results`,
  );
  const calls = sources.flatMap((url, i) => [
    { name: "web_fetch", arguments: { url } },
    {
      name: "finish_task",
      arguments: {
        summary: "The consulted sources have not published the requested results.",
        outcome: i === 4 ? "partial" : "completed",
      },
    },
  ]);
  await modelFixture(t, (i) => calls[i], {
    researchReview: (_body, i) => ({
      complete: false,
      blocked: i >= 4,
      missing: ["Requested results remain absent"],
      nextSteps: i >= 4 ? [] : ["Try a relevant alternative data source"],
    }),
  });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const observed: string[] = [];
  t.mock.method(f.agent.web, "document", async (url: string) => {
    observed.push(url);
    return {
      url,
      contentType: "text/html",
      body: "<article>The requested results have not been published.</article>",
    };
  });
  const task = await f.agent.createTask("owner", { prompt: "What are the results now?" });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "failed");
  assert.notEqual(saved.completion?.status, "verified");
  assert.deepEqual(observed, sources);
  assert.ok(
    (await f.agent.journal.operations("owner", task.id)).filter((o) => o.toolName === "finish_task")
      .length >= 5,
  );
});

test("ending with plain text cannot bypass the research delivery review", async (t) => {
  await modelFixture(
    t,
    (i) =>
      i === 0 ? { name: "web_fetch", arguments: { url: "https://news.example/about" } } : undefined,
    {
      text: (i) => (i > 0 ? "Visit the website for the results." : undefined),
      researchReview: () => ({
        complete: false,
        missing: ["The count is absent"],
        nextSteps: ["Read the actual count"],
      }),
    },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<article>General election information.</article>",
  }));
  const task = await f.agent.createTask("owner", { prompt: "What are the results?" });
  for (let i = 0; i < 3; i++) await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(
    saved.status,
    "queued",
    "incomplete prose stays repairable without a three-review cutoff",
  );
  assert.notEqual(saved.completion?.status, "verified");
});

test("the model reads discovered alternative sources after incomplete delivery reviews", async (t) => {
  let count = 0;
  await modelFixture(
    t,
    (i) =>
      i === 0
        ? { name: "search_web", arguments: { query: "current count" } }
        : i === 1
          ? { name: "web_fetch", arguments: { url: "https://official.example/selector" } }
          : i === 3
            ? { name: "web_fetch", arguments: { url: "https://news.example/live" } }
            : {
                name: "finish_task",
                arguments: {
                  summary:
                    i < 4
                      ? "The selector does not show totals."
                      : "Candidate A has 52%, 12345 votes. https://news.example/live",
                },
              },
    {
      researchReview: (body) => {
        count++;
        return body.includes("12345")
          ? { complete: true, missing: [], nextSteps: [] }
          : {
              complete: false,
              missing: ["Actual count"],
              nextSteps: ["Read alternative result sources"],
            };
      },
    },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.search, "search", async () => ({
    query: "current count",
    status: "ok",
    sources: [
      {
        url: "https://official.example/selector",
        title: "Official results",
        snippet: "Select election",
      },
      { url: "https://news.example/live", title: "Current count", snippet: "Live results" },
    ],
    observedAt: new Date().toISOString(),
    truncated: false,
    provenance: {
      backend: "http",
      provider: "duckduckgo-html",
      searchUrl: "https://example.com/search",
      fullPagesRead: false,
    },
  }));
  const read = t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: url.includes("news.example")
      ? "<title>Results</title><main>Candidate A has 52%, 12345 votes.</main>"
      : "<title>Results</title><main>Select election to see results.</main>",
  }));
  const task = await f.agent.createTask("owner", { prompt: "What is the actual count?" });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.result);
  assert.ok(read.mock.calls.some((call) => call.arguments[0] === "https://news.example/live"));
  assert.match(saved.result ?? "", /12345/);
  assert.equal(count, 2);
  assert.ok(
    (await f.agent.journal.operations("owner", task.id)).some(
      (op) => op.toolName === "web_fetch" && op.status === "succeeded" && !op.effect,
    ),
  );
});

test("automatic recovery uses ranked sources, not analytics JSON observed on a page", async () => {
  const { researchRecoverySources } = await import(
    "../apps/server/src/engine/research-delivery-review.ts"
  );
  const operations = [
    {
      toolName: "search_web",
      args: { query: "count" },
      receipt: {
        sources: [
          { url: "https://news.example/live" },
          { url: "https://alternative.example/live" },
        ],
      },
    },
    {
      toolName: "web_fetch",
      args: { url: "https://news.example/live" },
      receipt: {
        url: "https://news.example/live",
        dataSources: [{ url: "https://analytics.example/config.json" }],
      },
    },
  ] as never;
  assert.deepEqual(researchRecoverySources(operations), ["https://alternative.example/live"]);
});

test("a follow-up recovers from sources observed in the parent conversation when its new searches fail", async (t) => {
  const fixture = await modelFixture(
    t,
    (i) =>
      i === 0
        ? { name: "web_fetch", arguments: { url: "https://official.example/selector" } }
        : i === 2
          ? { name: "web_fetch", arguments: { url: "https://news.example/live" } }
          : {
              name: "finish_task",
              arguments: {
                summary:
                  i < 3 ? "No results." : "A: 52%, 12345 votes. Source: https://news.example/live",
              },
            },
    {
      researchReview: (body) =>
        body.includes("12345")
          ? { complete: true, missing: [], nextSteps: [] }
          : {
              complete: false,
              missing: ["Actual count"],
              nextSteps: ["Read a previously observed source"],
            },
    },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const read = t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: url.includes("news.example")
      ? "<main>Candidate A: 52%, 12345 votes.</main>"
      : "<main>Select an election to see results.</main>",
  }));
  const task = await f.agent.createTask(
    "owner",
    {
      prompt: "Show the count from that conversation",
    },
    "durable-conversation-admission",
  );
  await f.db.put("owner", "tasks", {
    ...task,
    state: {
      ...task.state,
      conversationContext: {
        messages: [],
        priorResults: [
          {
            taskId: "previous",
            evidence: [
              { kind: "web", url: "https://news.example/live", acquiredAt: "2026-10-04T00:00:00Z" },
              { kind: "file", url: "https://unrelated.example/private-document" },
            ],
          },
        ],
      },
    },
  });
  await f.agent.worker.tick();
  assert.equal((await f.agent.getTask("owner", task.id)).status, "succeeded");
  assert.ok(read.mock.calls.some((call) => call.arguments[0] === "https://news.example/live"));
  assert.ok(!read.mock.calls.some((call) => call.arguments[0].includes("unrelated.example")));
  assert.equal(task.id.length, 64);
  for (const request of fixture.requests) {
    const input = JSON.parse(request.body).input ?? [];
    for (const message of input)
      if (message.call_id)
        assert.ok(
          message.call_id.length <= 64,
          "provider call IDs must fit even with deterministic task IDs",
        );
  }
});

test("verified facts stay available through repeated delivery repair with the full tool catalog", async (t) => {
  const fixture = await modelFixture(
    t,
    (i) =>
      i === 0
        ? { name: "web_fetch", arguments: { url: "https://news.example/live" } }
        : {
            name: "finish_task",
            arguments: {
              summary:
                i < 3
                  ? "No results."
                  : i === 3
                    ? "A 52%; B 48%; extra unsupported claim."
                    : "Count:\n- A: 52%\n- B: 48%\nSource: https://news.example/live",
            },
          },
    {
      researchReview: (_body, i) =>
        i < 2
          ? {
              complete: false,
              needsMoreResearch: true,
              missing: ["The count"],
              nextSteps: ["Use observed results"],
            }
          : i === 2
            ? {
                complete: false,
                needsMoreResearch: false,
                missing: ["Unsupported extra claim and readable formatting"],
                nextSteps: ["Remove extra claim and present the observed count in bullets"],
              }
            : { complete: true, needsMoreResearch: false, missing: [], nextSteps: [] },
    },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const read = t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<main>A 52%, B 48%</main>",
  }));
  const task = await f.agent.createTask("owner", { prompt: "What is the count?" });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.result);
  assert.equal(read.mock.callCount(), 1);
  assert.equal((saved.state.researchDeliveryReview as { attempts: number }).attempts, 4);
  const lastRequest = fixture.requests.at(-1);
  assert.ok(lastRequest);
  const repairTools = offeredHostTools(lastRequest.body);
  assert.ok(repairTools.includes("finish_task"));
  assert.ok(repairTools.includes("read_tool_output"), "previous source results remain retrievable");
  assert.ok(repairTools.includes("todo_list"), "the agent can finish updating its actual plan");
  assert.ok(
    repairTools.includes("web_fetch"),
    "repair retains the ability to acquire additional evidence",
  );
  assert.match(
    lastRequest.body,
    /Remove extra claim and present the observed count in bullets/,
    "the current repair instruction survives context projection",
  );
});

test("artifact delivery repair keeps authoring tools available after the facts are verified", async (t) => {
  let repairOffered = false;
  const fixture = await modelFixture(
    t,
    (i) => {
      if (i === 0) return { name: "web_fetch", arguments: { url: "https://news.example/live" } };
      if (i === 1 || i === 3) {
        if (i === 3) {
          const tools = offeredHostTools(fixture.requests[i].body);
          repairOffered = tools.includes("create_document") || tools.includes("search_tools");
          assert.ok(tools.includes("web_fetch"), "repair does not restrict additional research");
        }
        return {
          name: "create_document",
          arguments: {
            name: "Count",
            format: "text",
            operationId: `draft-${i}`,
            content:
              i === 1
                ? "A: 52%; B: 48%. Source: user."
                : "A: 52%; B: 48%. Source: https://news.example/live",
          },
        };
      }
      return { name: "finish_task", arguments: { summary: "Created the requested count file." } };
    },
    {
      researchReview: (_body, i) =>
        i === 0
          ? {
              complete: false,
              needsMoreResearch: false,
              missing: ["The file incorrectly attributes the observed data to the user"],
              nextSteps: ["Create a corrected file with the observed source attribution"],
            }
          : { complete: true, needsMoreResearch: false, missing: [], nextSteps: [] },
    },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const read = t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<main>A: 52%; B: 48%.</main>",
  }));
  const task = await f.agent.createTask("owner", {
    prompt: "Research the count and create a TXT file with the results and source.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.result);
  assert.ok(repairOffered);
  assert.equal(read.mock.callCount(), 1);
  const creates = (await f.agent.journal.operations("owner", task.id)).filter(
    (op) => op.toolName === "create_document" && op.status === "succeeded",
  );
  assert.equal(
    creates.length,
    2,
    "the rejected artifact must actually be revised before finishing",
  );
});

test("a revised request restores research tools after an older delivery-only review", async (t) => {
  const fixture = await modelFixture(t, () => undefined, { text: () => "Updated answer." });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", { prompt: "What is the current count?" });
  await f.db.put("owner", "tasks", {
    ...task,
    state: {
      ...task.state,
      desiredRevision: 1,
      appliedRevision: 1,
      researchDeliveryReview: {
        revision: 0,
        complete: false,
        needsMoreResearch: false,
        attempts: 3,
        repairAttempts: 1,
        missing: ["Formatting"],
        nextSteps: ["Use bullets"],
      },
    },
  });
  await f.agent.worker.tick();
  const firstRequest = fixture.requests.at(0);
  assert.ok(firstRequest);
  const tools = offeredHostTools(firstRequest.body);
  assert.ok(tools.includes("web_fetch"), "A new revision must be allowed to acquire new facts");
});
