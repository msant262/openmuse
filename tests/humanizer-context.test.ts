import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { lastValueFrom, toArray } from "rxjs";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { taskReplyVoice } from "../apps/server/src/engine/task-reply-voice.ts";
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

test("a custom SOUL composes the delivered task result from the draft without tool authority", async (t) => {
  const draft = "1. Read the brief.\n2. Write the answer. Reference: https://example.org/brief";
  const voiced =
    "Gata, bora resolver isso:\n1. Leia o briefing.\n2. Escreva a resposta. Referência: https://example.org/brief";
  const fixture = await modelFixture(
    t,
    (i) => (i === 0 ? { name: "finish_task", arguments: { summary: draft } } : undefined),
    { text: (i) => (i === 1 ? voiced : undefined) },
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
  assert.equal(fixture.requests.length, 2);
  const composition = JSON.parse(fixture.requests[1].body);
  assert.deepEqual(composition.tools ?? [], []);
  assert.match(fixture.requests[1].body, /Afetuosa, divertida, com energia de diva/);
  assert.ok(fixture.requests[1].body.includes("https://example.org/brief"));
});

test("voice composition keeps the original draft when the model changes facts or source links", async (t) => {
  const draft = "Total: 42 votes. Source: https://example.org/results";
  const replies = [
    "Gata, total: 43 votes. Source: https://example.org/results",
    "Gata, total: 42 votes. Source: https://example.org/invented",
    "",
  ];
  await modelFixture(t, () => undefined, { text: (i) => replies[i] });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const profile = await f.agent.profiles.get("owner");
  profile.fields.personality = "Afetuosa e divertida.";
  for (const _ of replies) {
    const text = await taskReplyVoice({
      config: f.agent.config,
      owner: "owner",
      profile,
      mode: "task",
      request: "Report the total.",
      draft,
      signal: new AbortController().signal,
    });
    assert.equal(text, draft);
  }
});
