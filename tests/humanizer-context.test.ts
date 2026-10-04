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
