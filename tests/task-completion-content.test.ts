import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { mandatoryTaskCriteria } from "../apps/server/src/engine/task-verification.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("model task kind cannot downgrade an explicit DOCX obligation", async (t) => {
  const prompt = "Create a DOCX document and send it by email";
  let messageId = "";
  await modelFixture(t, (index) =>
    index === 0
      ? {
          name: "delegate_task",
          arguments: {
            prompt: "Fill the school PDF form and prepare a reply",
            kind: "document",
            input: {
              messageId,
              fields: {
                participant_name: "Test Student",
                guardian_name: "Test Guardian",
                permission_granted: true,
              },
            },
          },
        }
      : undefined,
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  await server.workspace.ensureSample("owner", server.actions);
  const mail = (await server.workspace.snapshot("owner")).mail.find((m) => m.attachments.length);
  assert.ok(mail);
  messageId = mail.id;
  await new Promise<void>((resolve, reject) => {
    new ConversationAgent(server.agent.config, server.agent, "owner")
      .run({
        threadId: "chat",
        runId: "kind-review",
        messages: [{ id: "user1", role: "user", content: prompt }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      })
      .subscribe({ error: reject, complete: resolve });
  });
  const tasks = await server.db.list<AgentTask>("owner", "tasks");
  assert.equal(tasks.length, 1);
  await server.agent.worker.tick();
  const pending = await server.agent.getTask("owner", tasks[0].id);
  assert.equal(pending.status, "waiting_approval");
  const action = await server.db.get<ActionProposal>("owner", "actions", String(pending.actionId));
  assert.ok(action);
  await server.actions.decide("owner", action.id, action.hash, "approve");
  await server.agent.worker.tick();
  const saved = await server.agent.getTask("owner", tasks[0].id);
  assert.notEqual(
    saved.completion?.status,
    "verified",
    "A PDF cannot satisfy the user's DOCX requirement",
  );
});

for (const fileText of [
  "agenda:\ncosts:\nrisks:\n",
  "agenda: Meet at 10:00\ncosts: EUR 20\nrisks: Delay possible\n",
])
  test(`required TXT sections ${fileText.includes("Meet") ? "verify with values" : "cannot be empty headings"}`, async (t) => {
    const server = await taskRuntime(t);
    const task = await server.agent.createTask("owner", {
      prompt: "Create a TXT file with required sections: agenda, costs, risks",
    });
    const file = await server.files.importAttachment(
      "owner",
      "report.txt",
      Buffer.from(fileText),
      "Fixture",
    );
    await server.db.compareAndSwapTask(
      "owner",
      task.id,
      { status: "queued" },
      { artifactIds: [file.id] },
    );
    const assessment = await server.agent.verification.assess("owner", task.id, 0);
    assert.equal(assessment.status, fileText.includes("Meet") ? "verified" : "unverified");
  });

test("model kind preserves requested explicit format in mandatory criteria", () => {
  const criteria = mandatoryTaskCriteria(
    { kind: "document", prompt: "Only fill a PDF" },
    undefined,
    "Create a DOCX document",
  );
  assert.ok(criteria.some((c) => c.kind === "file" && c.format?.includes("wordprocessingml")));
});
