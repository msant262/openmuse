import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { lastValueFrom, toArray } from "rxjs";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { SkillCatalog } from "../apps/server/src/skill-catalog.ts";
import { stripFrontmatterBlock } from "../apps/server/src/skill-frontmatter.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("the packaged humanizer reaches chat and task models automatically without discovery calls", async (t) => {
  const fixture = await modelFixture(
    t,
    (i) =>
      i === 1
        ? { name: "finish_task", arguments: { summary: "A short useful answer." } }
        : undefined,
    { text: (i) => (i === 0 ? "Que notícia boa!" : undefined) },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const skill = await new SkillCatalog(f.agent.config).read("owner", "builtin:humanizer", []);
  const body = stripFrontmatterBlock(skill.content);
  assert.equal(skill.authority, "workflow_guidance");
  const conversation = new ConversationAgent(f.agent.config, f.agent, "owner");
  await lastValueFrom(
    conversation
      .run({
        threadId: "chat",
        runId: randomUUID(),
        messages: [{ id: "news", role: "user", content: "Passei na prova!" }],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  await f.agent.createTask("owner", {
    prompt: "Explain the difference between a list and a paragraph.",
  });
  await f.agent.worker.tick();
  assert.equal(fixture.requests.length, 2);
  for (const request of fixture.requests) {
    const serialized = JSON.stringify(JSON.parse(request.body));
    assert.ok(
      serialized.includes(JSON.stringify(body).slice(1, -1)),
      "the complete deployed skill must reach both models, not just its name",
    );
    assert.ok(serialized.includes(skill.sha256));
  }
});

test("the native executor uses a custom SOUL and delivers its result without a separate rewriting call", async (t) => {
  const voiced =
    "Gata, bora resolver isso:\n1. Leia o briefing.\n2. Escreva a resposta. Referência: https://example.org/brief";
  const fixture = await modelFixture(t, (i) =>
    i === 0 ? { name: "finish_task", arguments: { summary: voiced } } : undefined,
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  await f.agent.profiles.update("owner", {
    scope: { kind: "global" },
    patch: { personality: "Afetuosa, divertida, com energia de diva.", language: "pt-BR" },
    expectedRevision: 0,
    requestId: "voice",
    origin: { kind: "settings" },
  });
  const task = await f.agent.createTask("owner", {
    prompt: "Create a two-step plan for reading a brief and writing an answer.",
  });
  await f.agent.worker.tick();
  const result = await f.agent.getTask("owner", task.id);
  assert.equal(result.result, voiced);
  assert.equal(fixture.requests.length, 1);
  assert.match(fixture.requests[0].body, /Afetuosa, divertida, com energia de diva/);
  assert.doesNotMatch(fixture.requests[0].body, /TASK_REPLY_VOICE/);
});

test("a personalized task preserves its exact facts and source links without postprocessing", async (t) => {
  const summary = "Total: 42 votes. Source: https://example.org/results";
  const fixture = await modelFixture(t, (i) =>
    i === 0
      ? { name: "web_fetch", arguments: { url: "https://example.org/results" } }
      : i === 1
        ? { name: "finish_task", arguments: { summary } }
        : undefined,
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  await f.agent.profiles.update("owner", {
    scope: { kind: "global" },
    patch: { personality: "Afetuosa e divertida." },
    expectedRevision: 0,
    requestId: "exact-personalized-result",
    origin: { kind: "settings" },
  });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<article>Total: 42 votes.</article>",
  }));
  const task = await f.agent.createTask("owner", {
    prompt: "Read the total from https://example.org/results",
  });
  await f.agent.worker.tick();
  const result = await f.agent.getTask("owner", task.id);
  assert.equal(result.status, "succeeded", result.error ?? undefined);
  assert.equal(result.result, summary);
  assert.equal(fixture.requests.length, 2);
  assert.ok(fixture.requests.every((request) => !request.body.includes("TASK_REPLY_VOICE")));
});
