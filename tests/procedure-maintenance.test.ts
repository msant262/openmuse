import assert from "node:assert/strict";
import { test } from "node:test";
import { personalTools } from "../apps/server/src/personal-tools.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

async function learned(t: Parameters<typeof taskRuntime>[0]) {
  const server = await taskRuntime(t);
  const task = await server.agent.taskRecord(
    "owner",
    { prompt: "Compare current rail fares" },
    "verified-source",
  );
  await server.db.put("owner", "tasks", {
    ...task,
    status: "succeeded",
    completion: { status: "verified", checks: [], remaining: [] },
  });
  await server.db.put("owner", "task-operations", {
    id: "rail-read",
    taskId: task.id,
    toolName: "web_fetch",
    status: "succeeded",
    receipt: { url: "https://rail.example", text: "Current fares" },
  });
  const input = {
    requestId: "rail",
    sourceTaskId: task.id,
    title: "Compare rail fares",
    steps: ["Read current fares from the operator and compare dates."],
    verification: ["Cite the fare and acquisition date."],
    requiredTools: ["web_fetch"],
    inputs: [],
  };
  const procedure = await server.agent.playbooks.saveLearned("owner", input, [task.id]);
  return { ...server, source: task, procedure, input };
}

test("procedure discovery is bounded metadata; a separate exact read exposes the method", async (t) => {
  const f = await learned(t);
  for (let i = 0; i < 12; i++)
    await f.agent.playbooks.saveLearned(
      "owner",
      {
        ...f.input,
        requestId: `method-${i}`,
        title: `Reusable method ${i}`,
        steps: [`METHOD_BODY_${i} ${"detailed step ".repeat(30)}`],
      },
      [f.source.id],
    );
  const tools = personalTools(f.agent, "owner", "chat:discovery");
  const list = tools.find((tool) => tool.name === "list_procedures")!;
  const result = (await list.execute!({ limit: 3 } as never)) as {
    entries: { id: string; version: number }[];
    nextCursor?: string;
  };
  assert.equal(result.entries.length, 3);
  assert.ok(result.nextCursor);
  assert.doesNotMatch(JSON.stringify(result), /METHOD_BODY/);
  const read = tools.find((tool) => tool.name === "read_procedure");
  assert.ok(read);
  const detail = (await read.execute!({ id: f.procedure.id, version: 1 } as never)) as {
    steps: string[];
  };
  assert.deepEqual(detail.steps, f.input.steps);
  const next = await f.agent.playbooks.catalog("owner", { limit: 3, cursor: result.nextCursor });
  assert.ok(next.entries.every((e) => !result.entries.some((first) => first.id === e.id)));
  await assert.rejects(
    f.agent.playbooks.read("other", { id: f.procedure.id, version: 1 }),
    /not found/i,
  );
});

test("procedure runs record exact-version reuse and verified/failed outcomes once", async (t) => {
  const f = await learned(t);
  const run = await f.agent.playbooks.run("owner", f.procedure.id, {
    version: 1,
    requestId: "use-v1",
    inputs: {},
  });
  await f.agent.playbooks.saveLearned(
    "owner",
    {
      ...f.input,
      id: f.procedure.id,
      expectedVersion: 1,
      requestId: "corrected",
      steps: ["Read the fare conditions first, then compare total prices."],
    },
    [f.source.id],
  );
  await f.db.compareAndSwapTask(
    "owner",
    run.id,
    { status: "queued" },
    { status: "succeeded", completion: { status: "verified", checks: [], remaining: [] } },
  );
  await f.agent.playbooks.recordOutcome("owner", run.id);
  await f.agent.playbooks.recordOutcome("owner", run.id);
  const stats = await f.agent.playbooks.usage("owner", f.procedure.id, 1);
  assert.equal(stats.runs, 1);
  assert.equal(stats.verified, 1);
  assert.equal(stats.failed, 0);
  assert.equal((await f.agent.playbooks.usage("owner", f.procedure.id, 2)).verified, 0);
  const failed = await f.agent.playbooks.run("owner", f.procedure.id, {
    version: 2,
    requestId: "use-v2",
    inputs: {},
  });
  await f.db.compareAndSwapTask(
    "owner",
    failed.id,
    { status: "queued" },
    { status: "failed", error: "Source changed" },
  );
  await f.agent.playbooks.recordOutcome("owner", failed.id);
  await f.agent.playbooks.recordOutcome("owner", failed.id);
  assert.equal((await f.agent.playbooks.usage("owner", f.procedure.id, 2)).failed, 1);
});

test("maintenance versions archive/restore/rollback without deleting snapshots and protect pinned/user methods", async (t) => {
  const f = await learned(t);
  const originalSoul = await f.agent.profiles.get("owner");
  const second = await f.agent.playbooks.saveLearned(
    "owner",
    {
      ...f.input,
      id: f.procedure.id,
      expectedVersion: 1,
      requestId: "v2",
      steps: ["Read fare restrictions, then compare."],
    },
    [f.source.id],
  );
  const archived = await f.agent.playbooks.manage(
    "owner",
    f.procedure.id,
    { action: "archive", expectedVersion: 2, requestId: "archive", reason: "Old unused method" },
    "curator",
  );
  assert.equal(archived.lifecycle, "archived");
  assert.ok(
    !(await f.agent.playbooks.catalog("owner")).entries.some((e) => e.id === f.procedure.id),
  );
  await assert.rejects(
    f.agent.playbooks.run("owner", f.procedure.id, { version: 2, requestId: "archived-run" }),
    /archived/i,
  );
  const restored = await f.agent.playbooks.manage("owner", f.procedure.id, {
    action: "restore",
    expectedVersion: 3,
    requestId: "restore",
    reason: "Use this again",
  });
  assert.equal(restored.lifecycle, "active");
  const rollback = await f.agent.playbooks.manage("owner", f.procedure.id, {
    action: "rollback",
    version: 1,
    expectedVersion: 4,
    requestId: "rollback",
    reason: "Previous method worked",
  });
  assert.deepEqual(rollback.steps, f.input.steps);
  assert.equal(rollback.version, 5);
  assert.deepEqual(
    (await f.agent.playbooks.read("owner", { id: f.procedure.id, version: 2 })).steps,
    second.steps,
  );
  await f.agent.playbooks.manage("owner", f.procedure.id, {
    action: "pin",
    expectedVersion: 5,
    requestId: "pin",
    reason: "Keep available",
  });
  await assert.rejects(
    f.agent.playbooks.manage(
      "owner",
      f.procedure.id,
      { action: "archive", expectedVersion: 6, requestId: "auto-pin", reason: "Aging" },
      "curator",
    ),
    /pinned/i,
  );
  await assert.rejects(
    f.agent.playbooks.saveLearned(
      "owner",
      { ...f.input, id: f.procedure.id, expectedVersion: 6, requestId: "edit-pinned" },
      [f.source.id],
    ),
    /pinned/i,
  );
  const manual = await f.agent.playbooks.save("owner", { ...f.input, requestId: "manual" });
  await assert.rejects(
    f.agent.playbooks.manage(
      "owner",
      manual.id,
      { action: "archive", expectedVersion: 1, requestId: "auto-manual", reason: "Aging" },
      "curator",
    ),
    /user-owned/i,
  );
  assert.deepEqual(await f.agent.profiles.get("owner"), originalSoul);
});

test("scheduled curator uses the existing worker, archives old learned methods and preserves pinned/user methods", async (t) => {
  const f = await learned(t);
  const pinned = await f.agent.playbooks.saveLearned(
    "owner",
    { ...f.input, requestId: "keep", title: "Pinned rail method" },
    [f.source.id],
  );
  await f.agent.playbooks.manage("owner", pinned.id, {
    action: "pin",
    expectedVersion: 1,
    requestId: "pin-keep",
    reason: "Keep this method",
  });
  const manual = await f.agent.playbooks.save("owner", { ...f.input, requestId: "user-method" });
  assert.ok(f.agent.procedureMaintenance, "procedure upkeep must be wired to the runtime");
  t.mock.method(
    f.agent.procedureMaintenance as unknown as { now: () => number },
    "now",
    () => Date.now() + 31 * 86400000,
  );
  // Curator operates only on learned methods; no model or external side effect is needed for aging.
  const job = await f.agent.procedureMaintenance.scheduleDue("owner");
  assert.ok(job);
  assert.equal(await f.agent.procedureMaintenance.scheduleDue("owner"), job);
  await f.agent.worker.tick();
  const completed = await f.agent.getTask("owner", job);
  assert.equal(completed.status, "succeeded", completed.error ?? undefined);
  assert.equal(
    (await f.agent.playbooks.read("owner", { id: f.procedure.id })).lifecycle,
    "archived",
  );
  assert.equal((await f.agent.playbooks.read("owner", { id: pinned.id })).lifecycle, "active");
  assert.equal((await f.agent.playbooks.read("owner", { id: manual.id })).lifecycle, "active");
  assert.equal(
    await f.agent.procedureMaintenance.scheduleDue("owner"),
    undefined,
    "weekly maintenance cannot loop each tick",
  );
});

test("exact duplicate consolidation is recoverable and history remains readable past thirty edits", async (t) => {
  const f = await learned(t);
  const duplicate = await f.agent.playbooks.saveLearned(
    "owner",
    { ...f.input, requestId: "duplicate" },
    [f.source.id],
  );
  const consolidated = await f.agent.playbooks.manage(
    "owner",
    duplicate.id,
    {
      action: "consolidate",
      replacementId: f.procedure.id,
      expectedVersion: 1,
      requestId: "merge",
      reason: "Same verified method",
    },
    "curator",
  );
  assert.equal(consolidated.lifecycle, "archived");
  assert.equal(consolidated.maintenance?.replacedBy?.id, f.procedure.id);
  let version = 1;
  for (let i = 0; i < 32; i++) {
    const saved = await f.agent.playbooks.saveLearned(
      "owner",
      {
        ...f.input,
        id: f.procedure.id,
        expectedVersion: version,
        requestId: `patch-${i}`,
        steps: [`Read current fare conditions and compare dates; iteration ${i}.`],
      },
      [f.source.id],
    );
    version = saved.version;
  }
  assert.deepEqual(
    (await f.agent.playbooks.read("owner", { id: f.procedure.id, version: 1 })).steps,
    f.input.steps,
  );
  const restored = await f.agent.playbooks.manage("owner", f.procedure.id, {
    action: "rollback",
    version: 1,
    expectedVersion: version,
    requestId: "old-version",
    reason: "Restore known working version",
  });
  assert.deepEqual(restored.steps, f.input.steps);
  assert.equal(
    (await f.agent.playbooks.get("owner", f.procedure.id)).versions.length,
    30,
    "current record stays bounded; historical snapshots are separate",
  );
  const page = await f.agent.playbooks.history("owner", f.procedure.id, { limit: 3 });
  assert.equal(page.entries.length, 3);
  assert.ok(page.nextCursor);
});
