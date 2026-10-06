import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { modelFixture, offeredHostTools } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("a review cannot certify a comparison while its request audit identifies missing entities", async (t) => {
  await modelFixture(t, () => undefined, {
    researchReview: () => ({
      complete: true,
      needsMoreResearch: true,
      missing: [],
      nextSteps: ["Read the second candidate's values and revise the image"],
      requestAudit: [
        {
          requirement: "Both candidates' percentages in each region",
          satisfied: false,
          evidence: "The image shows only the regional winner's percentage",
        },
      ],
    }),
  });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", {
    prompt: "Create a map showing candidate A and candidate B percentages in each region.",
  });
  const { reviewResearchDelivery } = await import(
    "../apps/server/src/engine/research-delivery-review.ts"
  );
  const providers = f.agent.config.modelProviders;
  assert.ok(providers);
  const decision = await reviewResearchDelivery({
    task,
    summary: "Map of each region's winner.",
    operations: [],
    model: "openai/fixture",
    providers,
    structured: false,
    signal: new AbortController().signal,
  });
  assert.equal(decision.complete, false);
  assert.match(decision.missing.join(" "), /Both candidates/);
  assert.equal(decision.blocked, false, "a concrete repair path keeps work active");
});

test("delivery review preserves facts in the middle of a source that fits the configured model", async (t) => {
  let observed = "";
  await modelFixture(t, () => undefined, {
    researchReview: (body) => {
      const payload = JSON.parse(JSON.parse(body).input[0].content[0].text);
      observed = payload.observations[0].text;
      return { complete: true, missing: [], nextSteps: [] };
    },
  });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", { prompt: "What are the current percentages?" });
  const source =
    "Historical coverage. ".repeat(700) +
    "Candidate A: 52%; Candidate B: 48%." +
    " More coverage.".repeat(700);
  const { reviewResearchDelivery } = await import(
    "../apps/server/src/engine/research-delivery-review.ts"
  );
  await reviewResearchDelivery({
    task,
    summary: "Candidate A: 52%; Candidate B: 48%.",
    operations: [
      {
        toolName: "web_fetch",
        status: "succeeded",
        args: { url: "https://news.example/live" },
        receipt: { url: "https://news.example/live", text: source },
      },
    ] as Parameters<typeof reviewResearchDelivery>[0]["operations"],
    model: "openai/fixture",
    providers: f.agent.config.modelProviders!,
    structured: false,
    signal: new AbortController().signal,
  });
  assert.equal(
    observed,
    source,
    "review must receive the complete source rather than lose its middle to a fixed character cap",
  );
});

test("infographic review receives actual file pixels and discovered links beyond navigation entries", async (t) => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=",
    "base64",
  );
  let checked = false;
  await modelFixture(
    t,
    (i) =>
      [
        { name: "web_fetch", arguments: { url: "https://news.example/results" } },
        { name: "generate_image", arguments: { prompt: "A map with results", operationId: "map" } },
        {
          name: "finish_task",
          arguments: {
            summary: "The map is attached, but its regional values are missing.",
            outcome: "partial",
          },
        },
      ][i],
    {
      researchReview: (body) => {
        const input = JSON.parse(body).input;
        checked =
          input.some(
            (message: { content?: { type: string; image_url?: string }[] }) =>
              Array.isArray(message.content) &&
              message.content.some(
                (part) =>
                  part.type === "input_image" &&
                  part.image_url === `data:image/png;base64,${png.toString("base64")}`,
              ),
          ) && body.includes("https://news.example/region-26");
        return {
          complete: false,
          blocked: true,
          missing: ["The observed image lacks the requested regional results"],
          nextSteps: [],
        };
      },
    },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  f.agent.config.modelProviders!.routing!.capabilities["openai/fixture"].vision = true;
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: `<main>Current results: A 52%, B 48%.${Array.from({ length: 27 }, (_, i) => `<a href="/region-${i}">Region ${i}</a>`).join("")}</main>`,
  }));
  t.mock.method(f.agent.media, "generatedImage", async () => {
    const file = await f.files.importAttachment(
      "owner",
      "map.png",
      png,
      "Generated image",
      "image/png",
    );
    return f.files.reference("owner", file.id);
  });
  const task = await f.agent.createTask("owner", {
    prompt: "Crie um infográfico com um mapa e os resultados por região.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.ok(checked);
  assert.equal(saved.status, "failed");
  assert.equal(saved.artifactIds.length, 1);
  assert.notEqual(saved.completion?.status, "verified");
});

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

test("review admits escaped source data using the harness token estimate, preserving facts that fit", async (t) => {
  let observed = "";
  await modelFixture(t, () => undefined, {
    researchReview: (body) => {
      observed = JSON.parse(JSON.parse(body).input[0].content[0].text).observations[0].text;
      return { complete: true, missing: [], nextSteps: [] };
    },
  });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", { prompt: "Compare A and B in each region." });
  const source = '"\\\n'.repeat(15000) + "Region 27: A 52%, B 48%." + '"\\\n'.repeat(15000);
  const { reviewResearchDelivery } = await import(
    "../apps/server/src/engine/research-delivery-review.ts"
  );
  const decision = await reviewResearchDelivery({
    task,
    summary: "A 52%; B 48%.",
    operations: [
      {
        toolName: "web_fetch",
        status: "succeeded",
        args: { url: "https://news.example/data" },
        receipt: { url: "https://news.example/data", text: source },
      },
    ] as Parameters<typeof reviewResearchDelivery>[0]["operations"],
    model: "openai/fixture",
    providers: f.agent.config.modelProviders!,
    structured: false,
    signal: new AbortController().signal,
  });
  assert.equal(decision.complete, true, "a review that fits must actually reach the provider");
  assert.equal(
    observed,
    source,
    "JSON escaping must not invent token pressure or discard the requested facts",
  );
});

test("a review provider outage pauses only the review and resumes without regenerating the image", async (t) => {
  let unavailable = true;
  const calls = [
    { name: "web_fetch", arguments: { url: "https://news.example/results" } },
    {
      name: "generate_image",
      arguments: { prompt: "Geographic map: A 52%, B 48%", operationId: "map" },
    },
    {
      name: "finish_task",
      arguments: { summary: "Geographic map with A 52%, B 48% and source.", outcome: "completed" },
    },
  ];
  const fixture = await modelFixture(t, (i) => calls[i], {
    reviewErrorStatus: () => (unavailable ? 503 : undefined),
    researchReview: () => ({ complete: true, missing: [], nextSteps: [] }),
  });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  f.agent.config.modelProviders!.routing!.capabilities["openai/fixture"].vision = true;
  f.agent.config.modelProviders!.routing!.maxAttempts = 1;
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<main>A 52%, B 48%.</main>",
  }));
  let generations = 0;
  t.mock.method(f.agent.media, "generatedImage", async () => {
    generations++;
    const file = await f.files.importAttachment(
      "owner",
      "map.png",
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=",
        "base64",
      ),
      "Generated image",
      "image/png",
    );
    return f.files.reference("owner", file.id);
  });
  const task = await f.agent.createTask("owner", {
    prompt: "Create an infographic with a geographic map showing A and B percentages.",
  });
  await f.agent.worker.tick();
  let saved = await f.agent.getTask("owner", task.id);
  assert.equal(
    saved.status,
    "waiting_provider",
    "review outages must not become semantic repair instructions or task failures",
  );
  assert.equal(generations, 1);
  assert.equal(saved.completion?.status, undefined);
  assert.equal(
    (await f.agent.detail("owner", task.id)).files.length,
    0,
    "unreviewed images must stay out of the chat delivery",
  );
  const executionRequests = fixture.requests.length;
  unavailable = false;
  const { sharedModelRouter } = await import("../apps/server/src/providers/model-router.ts");
  const cooldown = sharedModelRouter(f.agent.config.modelProviders!).health.get(
    "openai/fixture",
  ).cooldownUntil;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, cooldown - Date.now() + 5)));
  await f.db.put("owner", "tasks", { ...saved, nextRunAt: new Date(0).toISOString() });
  await f.agent.worker.tick();
  saved = await f.agent.getTask("owner", task.id);
  assert.equal(
    saved.status,
    "succeeded",
    JSON.stringify({
      error: saved.error,
      completion: saved.completion,
      review: saved.state.researchDeliveryReview,
    }),
  );
  assert.equal(generations, 1, "resuming the review must not call the generator again");
  assert.equal(
    fixture.requests.length,
    executionRequests,
    "resume the saved delivery before invoking the executor",
  );
  assert.equal((await f.agent.detail("owner", task.id)).files.length, 1);
});

test("a short follow-up repairs the original geographic map and publishes only the reviewed revision", async (t) => {
  const ids: string[] = [];
  let f: Awaited<ReturnType<typeof taskRuntime>>;
  let taskId = "";
  const calls = [
    { name: "web_fetch", arguments: { url: "https://news.example/results" } },
    {
      name: "generate_image",
      arguments: { prompt: "Grid of region cards, A 52%, B 48%", operationId: "draft" },
    },
    { name: "finish_task", arguments: { summary: "Grid of regions", outcome: "completed" } },
    {
      name: "generate_image",
      arguments: {
        prompt: "Geographic map with real outlines, A 52%, B 48%",
        operationId: "corrected",
      },
    },
  ];
  const fixture = await modelFixture(
    t,
    async (i) => {
      if (i === 3) assert.equal((await f.agent.detail("owner", taskId)).files.length, 0);
      return i === 4
        ? {
            name: "finish_task",
            arguments: {
              summary: "Geographic map with A 52%, B 48%",
              outcome: "completed",
              artifactIds: [ids[1]],
            },
          }
        : calls[i];
    },
    {
      researchReview: (body, index) => {
        const payload = JSON.parse(JSON.parse(body).input[0].content[0].text);
        assert.equal(payload.originalRequest, "faz um novo por gentileza eu apaguei o anterior");
        assert.match(JSON.stringify(payload.conversationContext), /mapa do Brasil/);
        if (index === 1) {
          assert.deepEqual(
            payload.reviewedImageIds,
            [ids[1]],
            "the rejected revision must not be certified as part of the final delivery",
          );
          return { complete: true, missing: [], nextSteps: [], needsMoreResearch: false };
        }
        return {
          complete: false,
          missing: ["The requested geographic map is a grid"],
          nextSteps: ["Replace the grid with real geographic outlines using the observed facts"],
          needsMoreResearch: false,
          requestAudit: [
            {
              requirement: "Geographic map of Brazil",
              satisfied: false,
              evidence: "The image is a grid of cards",
            },
          ],
        };
      },
    },
  );
  f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  f.agent.config.modelProviders!.routing!.capabilities["openai/fixture"].vision = true;
  const urls: string[] = [];
  t.mock.method(f.agent.web, "document", async (url: string) => {
    urls.push(url);
    return { url, contentType: "text/html", body: "<main>A 52%, B 48%.</main>" };
  });
  t.mock.method(f.agent.media, "generatedImage", async () => {
    const file = await f.files.importAttachment(
      "owner",
      `map-${ids.length}.png`,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=",
        "base64",
      ),
      "Generated image",
      "image/png",
    );
    ids.push(file.id);
    return f.files.reference("owner", file.id);
  });
  const prompt = "faz um novo por gentileza eu apaguei o anterior";
  const task = await f.agent.createTask(
    "owner",
    { prompt, originThreadId: "map-chat" },
    undefined,
    false,
    undefined,
    prompt,
    [
      {
        id: "original",
        role: "user",
        content:
          "Quero um infográfico: mapa do Brasil mostrando os percentuais de A e B por estado.",
      },
    ],
  );
  taskId = task.id;
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", JSON.stringify(saved.completion));
  assert.deepEqual(
    urls,
    ["https://news.example/results"],
    "a format repair must reuse sufficient observed facts",
  );
  assert.equal(ids.length, 2);
  assert.deepEqual(saved.artifactIds, ids, "both files remain in the task's audit history");
  assert.deepEqual(
    (await f.agent.detail("owner", task.id)).files.map((file) => file.id),
    [ids[1]],
  );
  assert.ok(fixture.requests.length >= 5);
});

test("incomplete image facts are repaired before dispatching an expensive generator", async (t) => {
  const briefDecisions: string[] = [];
  const calls = [
    { name: "web_fetch", arguments: { url: "https://news.example/partial" } },
    {
      name: "generate_image",
      arguments: { prompt: "Map: North A 52%, B 48%; South unknown", operationId: "partial-map" },
    },
    { name: "web_fetch", arguments: { url: "https://news.example/complete" } },
    {
      name: "generate_image",
      arguments: {
        prompt: "Map: North A 52%, B 48%; South A 41%, B 59%",
        operationId: "complete-map",
      },
    },
    {
      name: "finish_task",
      arguments: { summary: "Complete geographic map of both regions and candidates." },
    },
  ];
  await modelFixture(t, (i) => calls[i], {
    imageBriefReview: (body) => {
      const input = JSON.parse(JSON.parse(body).input[0].content[0].text);
      assert.equal(input.stage, "image_brief");
      briefDecisions.push(input.proposedAnswer);
      const complete = input.proposedAnswer.includes("South A 41%");
      return {
        complete,
        needsMoreResearch: !complete,
        missing: complete ? [] : ["South has no values for A and B"],
        nextSteps: complete ? [] : ["Read the observed complete source before generating"],
      };
    },
  });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  f.agent.config.modelProviders!.routing!.capabilities["openai/fixture"].vision = true;
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: url.endsWith("complete")
      ? "North A 52%, B 48%; South A 41%, B 59%."
      : "North A 52%, B 48%. https://news.example/complete",
  }));
  const generated: string[] = [];
  t.mock.method(
    f.agent.media,
    "generatedImage",
    async (_owner: string, _model: string | undefined, args: unknown) => {
      generated.push((args as { prompt: string }).prompt);
      const file = await f.files.importAttachment(
        "owner",
        "map.png",
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=",
          "base64",
        ),
        "Generated image",
        "image/png",
      );
      return f.files.reference("owner", file.id);
    },
  );
  const task = await f.agent.createTask("owner", {
    prompt:
      "Create an infographic with a geographic map of North and South showing A and B percentages.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", JSON.stringify(saved.completion));
  assert.equal(briefDecisions.length, 2);
  assert.deepEqual(generated, [calls[3].arguments.prompt]);
  assert.equal(
    saved.artifactIds.length,
    1,
    "a rejected brief must not create a draft or image receipt",
  );
});

for (const legacyApproved of [false, true])
  test(`an unavailable image brief review resumes the saved generation before another executor inference${legacyApproved ? " from a legacy approved task" : ""}`, async (t) => {
    let unavailable = true;
    let generations = 0;
    const calls = [
      { name: "web_fetch", arguments: { url: "https://news.example/results" } },
      {
        name: "generate_image",
        arguments: { prompt: "Geographic map: A 52%, B 48%", operationId: "map" },
      },
      { name: "finish_task", arguments: { summary: "Geographic map: A 52%, B 48% with source." } },
    ];
    const fixture = await modelFixture(
      t,
      (i) => {
        if (i === 2) {
          assert.equal(
            generations,
            1,
            "the host resumes the approved image before asking the executor",
          );
          assert.ok(
            fixture.requests[i].body.includes('"type":"input_image"'),
            "the resumed executor must see the actual new image, not historical drafts",
          );
        }
        return calls[i];
      },
      {
        imageBriefErrorStatus: () => (unavailable ? 503 : undefined),
      },
    );
    const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
    f.agent.config.modelProviders!.routing!.capabilities["openai/fixture"].vision = true;
    f.agent.config.modelProviders!.routing!.maxAttempts = 1;
    const read = t.mock.method(f.agent.web, "document", async (url: string) => ({
      url,
      contentType: "text/html",
      body: "A 52%, B 48%.",
    }));
    t.mock.method(f.agent.media, "generatedImage", async () => {
      generations++;
      const file = await f.files.importAttachment(
        "owner",
        "map.png",
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=",
          "base64",
        ),
        "Generated image",
        "image/png",
      );
      return f.files.reference("owner", file.id);
    });
    const task = await f.agent.createTask("owner", {
      prompt: "Create an infographic with a geographic map showing A and B percentages.",
    });
    await f.agent.worker.tick();
    let saved = await f.agent.getTask("owner", task.id);
    assert.equal(saved.status, "waiting_provider");
    assert.equal(
      generations,
      0,
      "no generator is dispatched while the brief review is unavailable",
    );
    assert.equal(saved.artifactIds.length, 0);
    assert.equal(read.mock.callCount(), 1);
    assert.equal(fixture.requests.length, 2);
    assert.ok(saved.state.pendingImageBrief);
    assert.deepEqual(
      (saved.state.pendingImageGeneration as { args: unknown }).args,
      { ...calls[1].arguments, provider: "auto" },
      "retain the exact image request, not only its prompt",
    );
    unavailable = false;
    if (legacyApproved) {
      const { researchObservations } = await import(
        "../apps/server/src/engine/research-delivery-review.ts"
      );
      const operations = await f.agent.journal.operations("owner", task.id);
      saved.state = {
        ...saved.state,
        pendingImageBrief: null,
        pendingImageGeneration: null,
        researchReviewFailure: null,
        imageBriefReview: {
          key: createHash("sha256")
            .update(
              JSON.stringify({
                prompt: calls[1].arguments.prompt,
                revision: 0,
                observations: researchObservations(operations).map((op) => op.receipt),
              }),
            )
            .digest("hex"),
          revision: 0,
          complete: true,
        },
      };
    }
    const { sharedModelRouter } = await import("../apps/server/src/providers/model-router.ts");
    const cooldown = sharedModelRouter(f.agent.config.modelProviders!).health.get(
      "openai/fixture",
    ).cooldownUntil;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, cooldown - Date.now() + 5)));
    await f.db.put("owner", "tasks", { ...saved, nextRunAt: new Date(0).toISOString() });
    await f.agent.worker.tick();
    saved = await f.agent.getTask("owner", task.id);
    assert.equal(
      saved.status,
      "succeeded",
      JSON.stringify({ error: saved.error, state: saved.state, completion: saved.completion }),
    );
    assert.equal(read.mock.callCount(), 1);
    assert.equal(generations, 1);
    assert.equal(fixture.requests.length, 3, "no inference is needed to resubmit the saved image");
    assert.equal(saved.state.pendingImageGeneration, null);
    assert.equal(
      fixture.imageBriefRequests.length,
      legacyApproved ? 1 : 2,
      "resume the saved brief, then reuse its approval for generation",
    );
    assert.equal((await f.agent.detail("owner", task.id)).files.length, 1);
  });

test("saved evidence recovers complete canonical source data beyond its excerpt without another network read", async (t) => {
  const source =
    "Context. ".repeat(900) + "Verified region Z: A 52%, B 48%." + "Tail. ".repeat(500);
  const fixture = await modelFixture(
    t,
    (i) =>
      [
        { name: "web_fetch", arguments: { url: "https://news.example/canonical" } },
        { name: "read_task_evidence", arguments: { offset: 0, limit: 1, includeSourceData: true } },
        {
          name: "finish_task",
          arguments: { summary: "Region Z: A 52%, B 48%, from the observed source." },
        },
      ][i],
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const read = t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: `<main>${source}</main>`,
  }));
  const task = await f.agent.createTask("owner", {
    prompt: "Compare the two percentages in region Z.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.result);
  const output = JSON.parse(fixture.requests[2].body)
    .input.filter((item: { type: string }) => item.type === "function_call_output")
    .at(-1);
  assert.ok(output, "the evidence read must return a canonical receipt to the model");
  const receipt = JSON.parse(output.output);
  assert.doesNotMatch(receipt.items[0].excerpt, /Verified region Z/);
  assert.match(JSON.stringify(receipt.sourceData), /Verified region Z: A 52%, B 48%/);
  assert.equal(receipt.sourceData[0].url, "https://news.example/canonical");
  assert.equal(read.mock.callCount(), 1, "recovering archived evidence makes no network request");
});

test("a 32k model completes research and image delivery without any larger model fallback", async (t) => {
  const fixture = await modelFixture(
    t,
    (i) =>
      [
        { name: "web_fetch", arguments: { url: "https://news.example/results" } },
        {
          name: "generate_image",
          arguments: {
            prompt: "Geographic map: North A 52%, B 48%; South A 49%, B 51%",
            operationId: "small-model-map",
          },
        },
        {
          name: "finish_task",
          arguments: { summary: "Map with both candidates in both regions and the source." },
        },
      ][i],
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const providers = f.agent.config.modelProviders;
  assert.ok(providers?.routing);
  providers.routing.capabilities["openai/fixture"] = {
    contextTokens: 32768,
    tools: true,
    structuredOutput: true,
    vision: true,
  };
  f.agent.config.modelFallbacks = [];
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "North A 52%, B 48%; South A 49%, B 51%.",
  }));
  let generations = 0;
  t.mock.method(f.agent.media, "generatedImage", async () => {
    generations++;
    const file = await f.files.importAttachment(
      "owner",
      "map.png",
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=",
        "base64",
      ),
      "Generated image",
      "image/png",
    );
    return f.files.reference("owner", file.id);
  });
  const task = await f.agent.createTask("owner", {
    prompt:
      "Research both candidates' percentages in North and South and generate a geographic infographic.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(
    saved.status,
    "succeeded",
    JSON.stringify({ error: saved.error, state: saved.state }),
  );
  assert.equal(generations, 1);
  assert.equal(fixture.requests.length, 3);
  for (const request of [
    ...fixture.requests,
    ...fixture.imageBriefRequests,
    ...fixture.reviewRequests,
  ])
    assert.equal(
      JSON.parse(request.body).model,
      "fixture",
      "every text phase uses the same 32k model",
    );
  assert.equal((await f.agent.detail("owner", task.id)).files.length, 1);
});
