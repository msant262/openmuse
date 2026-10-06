import assert from "node:assert/strict";
import test from "node:test";
import { taskEventOperations } from "../apps/server/src/engine/task-event-operations.ts";
import type { JournalOperation } from "../apps/server/src/engine/task-journal.ts";
import type { RunEvent } from "../packages/domain/src/agent.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("old step events select their own saved source receipt, excluding other tasks and primitives", () => {
  const events: RunEvent[] = [0, 2].map((i) => ({
    id: `event-${i}`,
    taskId: "task",
    kind: "step",
    title: "Reading sources",
    detail: "",
    date: `2026-10-06T08:00:0${i}.000Z`,
  }));
  const op = (id: string, second: number, extra = {}) =>
    ({
      id,
      taskId: "task",
      toolName: "web_fetch",
      createdAt: `2026-10-06T08:00:0${second}.500Z`,
      ...extra,
    }) as JournalOperation;
  const mapped = taskEventOperations(events, [
    op("first", 0),
    op("child", 0, { parentOperationId: "first" }),
    op("other", 0, { taskId: "someone-else" }),
    op("second", 2),
  ]);
  assert.deepEqual(
    mapped.map((e) => e.operationId),
    ["first", "second"],
  );
  assert.equal(events[0].operationId, undefined);
  assert.equal(
    taskEventOperations([events[0]], [op("ambiguous-a", 0), op("ambiguous-b", 0)])[0].operationId,
    undefined,
  );
  assert.equal(
    taskEventOperations([{ ...events[0], operationId: "exact" }], [op("other-id", 0)])[0]
      .operationId,
    "exact",
  );
});

test("task detail exposes historical delivery input and outcome with sensitive fields removed", async (t) => {
  const f = await taskRuntime(t, { taskWorkerEnabled: false });
  const task = await f.agent.createTask("owner", { prompt: "Make an infographic" });
  await f.db.put("owner", "run-events", {
    id: "finish",
    taskId: task.id,
    kind: "step",
    title: "Checking and preparing the delivery",
    detail: "",
    date: "2026-10-06T08:00:00.000Z",
  });
  await f.db.put("owner", "task-operations", {
    id: "delivery",
    taskId: task.id,
    toolName: "finish_task",
    status: "succeeded",
    createdAt: "2026-10-06T08:00:00.020Z",
    args: { summary: "Final image checked", artifactIds: ["image"], password: "must-not-appear" },
    receipt: { outcome: "completed", api_key: "must-not-appear", thinking: "private reasoning" },
  });
  const detail = await f.agent.detail("owner", task.id);
  assert.equal(detail.events[0].operationId, "delivery");
  const output = detail.operations.find((o) => o.id === detail.events[0].operationId)!;
  assert.match(JSON.stringify(output), /Final image checked/);
  assert.match(JSON.stringify(output), /completed/);
  assert.doesNotMatch(JSON.stringify(output), /must-not-appear|private reasoning/);
  await assert.rejects(f.agent.detail("other-owner", task.id), /Task not found/);
});
