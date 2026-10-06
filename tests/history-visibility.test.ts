import assert from "node:assert/strict";
import { test } from "node:test";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("archived history disappears from presentation while canonical receipts and other owners remain accessible", async (t) => {
  const f = await taskRuntime(t, { mode: "live" });
  const at = "2026-10-06T00:00:00Z";
  for (const kind of [
    "actions",
    "activity",
    "agent-artifacts",
    "notifications",
    "files",
    "google-mail-drafts",
    "proactivity-suggestions",
  ]) {
    await f.db.put("owner", kind, {
      id: "test",
      historyHiddenAt: at,
      createdAt: at,
      updatedAt: at,
    });
    await f.db.put("owner", kind, { id: "real", createdAt: at, updatedAt: at });
    await f.db.put("another-owner", kind, { id: "other", createdAt: at, updatedAt: at });
    assert.deepEqual(
      (await f.db.visibleRecords<{ id: string }>("owner", kind)).map((r) => r.id),
      ["real"],
    );
    assert.deepEqual(
      (
        await f.db.recordPage<{ id: string }>("owner", kind, {
          visibleOnly: true,
          limit: 1,
          order: "createdAt",
        })
      ).entries.map((r) => r.id),
      ["real"],
    );
    assert.equal(
      (await f.db.list("owner", kind)).length,
      2,
      "execution and reconciliation keep both canonical records",
    );
    assert.equal((await f.db.get("owner", kind, "test"))?.historyHiddenAt, at);
    assert.deepEqual(
      (await f.db.visibleRecords<{ id: string }>("another-owner", kind)).map((r) => r.id),
      ["other"],
    );
  }
  const oldTask = await f.agent.createTask("owner", { prompt: "Development test" });
  await f.db.put("owner", "tasks", {
    ...oldTask,
    status: "succeeded",
    historyHiddenAt: at,
  });
  const realTask = await f.agent.createTask("owner", { prompt: "Real user request" });
  // Exercise the actual workspace surfaces rather than a front-end-only filter.
  const workspace = await f.workspace.snapshot("owner", undefined, "essential");
  assert.deepEqual(
    workspace.actions.map((r) => r.id),
    ["real"],
  );
  assert.deepEqual(
    workspace.activity.map((r) => r.id),
    ["real"],
  );
  assert.deepEqual(
    workspace.files.map((r) => r.id),
    ["real"],
  );
  const agent = await f.agent.snapshot("owner");
  assert.deepEqual(
    agent.tasks.map((r) => r.id),
    [realTask.id],
  );
  assert.ok(await f.db.get("owner", "tasks", oldTask.id));
  assert.deepEqual(
    agent.notifications.map((r) => r.id),
    ["real"],
  );
  assert.deepEqual(
    agent.artifacts.map((r) => r.id),
    ["real"],
  );
  assert.deepEqual(
    (await f.agent.proactivity.list("owner")).map((r) => r.id),
    ["real"],
  );
});
