import assert from "node:assert/strict";
import test from "node:test";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("public research does not load Workspace mutation instructions into every model turn", async (t) => {
  const fixture = await modelFixture(t, (i) =>
    i === 0
      ? { name: "web_fetch", arguments: { url: "https://research.example/course" } }
      : { name: "finish_task", arguments: { summary: "The course has six lessons." } },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<main>The course has six lessons.</main>",
  }));
  const task = await f.agent.createTask("owner", { prompt: "Pesquise quantas aulas tem o curso." });
  await f.agent.worker.tick();
  assert.equal((await f.agent.getTask("owner", task.id)).status, "succeeded");
  for (const request of fixture.requests)
    assert.doesNotMatch(
      request.body,
      /For deleting a group of emails|For Calendar work, preserve|Gmail folders are labels/,
    );
});
