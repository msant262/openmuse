import assert from "node:assert/strict";
import test from "node:test";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

for (const computerBackend of ["docker", "rpc"] as const) {
  test(`${computerBackend} configuration rejection lets research continue without uncertain dispatch`, async (t) => {
    const calls = [
      { name: "start_computer", arguments: {} },
      { name: "write_computer_file", arguments: { path: "/workspace/note.txt", text: "note" } },
      { name: "run_computer_command", arguments: { command: "pwd", operationId: "preflight" } },
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
      researchReview: () => ({ complete: true, missing: [], nextSteps: [] }),
    });
    const f = await taskRuntime(t, {
      agentBackend: "model",
      model: "openai/fixture",
      computerBackend,
      // Also cover a nominally enabled RPC backend with missing credentials.
      computerEnabled: computerBackend === "rpc",
    });
    let reads = 0;
    t.mock.method(f.agent.web, "document", async (url: string) => {
      reads++;
      return { url, contentType: "text/html", body: "<main>A 52%, B 48%.</main>" };
    });
    const task = await f.agent.createTask("owner", { prompt: "What is the current count?" });
    await f.agent.worker.tick();
    const saved = await f.agent.getTask("owner", task.id);
    assert.equal(saved.status, "succeeded", saved.error ?? saved.question);
    assert.equal(saved.completion?.status, "verified");
    assert.equal(reads, 1);
    const operations = await f.agent.journal.operations("owner", task.id);
    for (const name of calls.slice(0, 3).map((call) => call.name)) {
      const rejected = operations.find((operation) => operation.toolName === name);
      assert.ok(rejected, name);
      assert.equal(rejected.status, "failed", name);
      assert.equal(rejected.dispatchedAt, undefined, name);
      assert.match(JSON.stringify(rejected.receipt), /configur/i);
      assert.equal(
        operations.some((operation) => operation.parentOperationId === rejected.id),
        false,
      );
    }
    assert.equal(
      operations.some((operation) => operation.status === "outcome_unknown"),
      false,
    );
    assert.deepEqual(await f.db.list("owner", "computer-audit"), []);
  });
}
