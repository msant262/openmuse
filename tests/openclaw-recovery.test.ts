import assert from "node:assert/strict";
import test from "node:test";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("upstream recovery clears an interrupted provider checkpoint after a successful answer", async (t) => {
  const provider = await modelFixture(t, () => undefined, {
    errorStatus: (index) => (index === 0 ? 400 : undefined),
    text: () => "The accepted answer is available after recovery.",
  });
  const app = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await app.agent.createTask("owner", {
    kind: "agent",
    prompt: "Give me a simple answer.",
    criteria: [
      {
        id: "answer",
        kind: "response",
        description: "Return the accepted answer",
        requiredItems: [],
      },
    ],
  });
  await app.agent.worker.tick();
  const saved = await app.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", JSON.stringify(saved));
  assert.equal(saved.state.providerCheckpoint ?? null, null);
  assert.match(saved.result ?? "", /available after recovery/);
  assert.equal(provider.requests.length, 2);
});
