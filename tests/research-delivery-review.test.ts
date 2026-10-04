import assert from "node:assert/strict";
import test from "node:test";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

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

test("unresolved research is bounded and can never be verified by repeatedly claiming completion", async (t) => {
  await modelFixture(
    t,
    (i) =>
      i === 0
        ? { name: "web_fetch", arguments: { url: "https://news.example/about" } }
        : {
            name: "finish_task",
            arguments: {
              summary: "The result is unavailable. See the website.",
              outcome: "completed",
            },
          },
    {
      researchReview: () => ({
        complete: false,
        missing: ["Requested results remain absent"],
        nextSteps: ["Try a relevant alternative data source"],
      }),
    },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<title>About</title><article>Counting starts today.</article>",
  }));
  const task = await f.agent.createTask("owner", { prompt: "What are the results now?" });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "failed");
  assert.notEqual(saved.completion?.status, "verified");
  assert.ok(
    (await f.agent.journal.operations("owner", task.id)).filter((o) => o.toolName === "finish_task")
      .length <= 3,
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
  assert.equal(saved.status, "failed");
  assert.notEqual(saved.completion?.status, "verified");
});
