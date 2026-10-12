import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { EventType } from "@ag-ui/core";
import { defineTool } from "@copilotkit/runtime/v2";
import { lastValueFrom, toArray } from "rxjs";
import { z } from "zod";
import { openclawAgent } from "../apps/server/src/engine/openclaw-agent.ts";
import { modelHistory } from "../apps/server/src/engine/task-history.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import { modelFixture, richChatFixtureProviders } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

for (const deferred of [false, true])
  test(`restoring ${deferred ? "deferred" : "direct"} receipts keeps journal identities and sends each result once`, async (t) => {
    const fixture = await modelFixture(t, (index) =>
      index === 0
        ? deferred
          ? { name: "tool_call", arguments: { id: "okami_lookup", args: {} } }
          : { name: "lookup", arguments: {} }
        : undefined,
    );
    const f = await taskRuntime(t);
    const created = await f.agent.createTask("owner", { prompt: "Compare the saved sources." });
    let executed = 0;
    const worker = new TaskWorker(f.db, async (owner, task) => {
      assert.ok(task.leaseId);
      const runToken = task.leaseId;
      const agent = openclawAgent({
        dataDir: f.directory,
        compaction: { db: f.db, owner, scope: task.id },
        model: "openai/fixture",
        providers: richChatFixtureProviders(f.directory),
        ...(!deferred && { directToolNames: ["lookup"] }),
        prompt: "Compare the sources and keep their receipts.",
        tools: [
          defineTool({
            name: "lookup",
            description: "Read the requested sources",
            parameters: z.object({}),
            execute: async () => {
              executed++;
              return { sources: [{ url: "https://example.com/course", duration: "2 hours" }] };
            },
          }),
        ],
        executeTool: (call, execute) => f.agent.journal.run(owner, task, call, execute, false),
        onMessages: (messages) =>
          f.agent.journal
            .checkpoint(owner, task.id, runToken, modelHistory(messages))
            .then(() => {}),
      });
      const run = async (messages: Parameters<typeof agent.run>[0]["messages"]) => {
        const events = await lastValueFrom(
          agent
            .run({
              threadId: task.id,
              runId: randomUUID(),
              messages,
              tools: [],
              context: [],
              state: {},
            })
            .pipe(toArray()),
        );
        assert.ok(
          !events.some((event) => event.type === EventType.RUN_ERROR),
          JSON.stringify(events),
        );
      };
      await run([{ id: randomUUID(), role: "user", content: task.prompt }]);
      const before = await f.agent.journal.history(owner, task.id);
      const original = before.filter((message) => message.role === "tool");
      assert.equal(original.length, 1);
      // The durable checkpoint precedes the final prose response, so this is
      // the real task-restart path that reseeds an authoritative transcript.
      await run(before);
      const after = await f.agent.journal.history(owner, task.id);
      const restored = after.filter((message) => message.role === "tool");
      assert.deepEqual(
        restored.map((message) => message.toolCallId),
        original.map((message) => message.toolCallId),
      );
      assert.equal(executed, 1, "restoring a result never dispatches its host action again");
      const lastRequest = fixture.requests.at(-1);
      assert.ok(lastRequest);
      const wire = JSON.parse(lastRequest.body);
      assert.equal(
        wire.input.filter((item: { type: string }) => item.type === "function_call_output").length,
        1,
      );
      return { status: "succeeded", result: "Receipts preserved." };
    });
    t.after(() => worker.stop());
    await worker.tick();
    const saved = await f.agent.getTask("owner", created.id);
    assert.equal(saved.status, "succeeded", saved.error ?? saved.question ?? undefined);
  });
