import assert from "node:assert/strict";
import { test } from "node:test";
import { bindingHash } from "../apps/server/src/conversation-inbox.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import { fixture, message, review } from "./proactivity-fixture.ts";

test("live heartbeat coalesces downtime into one durable review using the four task slots", async (t) => {
  const f = await fixture(t);
  assert.ok(f.server.agent.proactivity, "live heartbeat service is connected");
  assert.equal((await f.server.agent.proactivity.settings.get("local-user")).intervalHours, 4);
  await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      f.server.agent.workAdmission.claim(`occupied-${i}`, "background", `occupied-${i}`),
    ),
  );
  const due = Date.now();
  const ids = await Promise.all([
    f.server.agent.proactivity.scheduleDue("local-user", due),
    f.server.agent.proactivity.scheduleDue("local-user", due + 7 * 86400000),
  ]);
  assert.equal(ids[0], ids[1]);
  await f.server.agent.worker.tick();
  const tasks = await f.db.list<AgentTask>("local-user", "tasks");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, "queued");
  assert.equal((await f.db.list("__runtime__", "work-admissions")).length, 4);
  await f.server.agent.workAdmission.release("occupied-0");
  await f.server.agent.worker.tick();
  assert.equal((await f.server.agent.getTask("local-user", tasks[0].id)).status, "succeeded");
  assert.ok((await f.db.list("local-user", "task-budgets")).length);
  assert.equal(await f.server.agent.proactivity.scheduleDue("local-user", due + 1000), undefined);
});

test("a sent reply anywhere in the actual thread closes the email pendency; drafts and read flags do not", async (t) => {
  const f = await fixture(t);
  f.source.messages.push(message("draft", "Draft reply", false, true));
  const suggestions = await review(f);
  assert.equal(suggestions.filter((s) => s.target.kind === "mail").length, 1);
  f.source.messages.push(message("different-sent-id", "Yes, Thursday works", true));
  const s = suggestions[0];
  const result = await f.server.agent.proactivity.respond("local-user", s.id, {
    requestId: s.requestId,
    clientResponseId: "accept-stale",
    expectedRevision: s.revision,
    action: "start",
  });
  assert.equal(result.suggestion.status, "obsolete");
  assert.equal((await f.db.list<AgentTask>("local-user", "tasks")).length, 1);
});

test("partial or unavailable sources report coverage and cannot be treated as unanswered or free agenda", async (t) => {
  const f = await fixture(t);
  f.source.truncated = true;
  await review(f);
  const cycles = await f.db.list<{
    coverage: { mail: { complete: boolean }; calendar: { complete: boolean } };
  }>("local-user", "proactivity-cycles");
  assert.equal(cycles[0].coverage.mail.complete, false);
  const s = (await f.server.agent.proactivity.list("local-user")).find(
    (x) => x.target.kind === "mail",
  )!;
  f.source.unavailable = true;
  await assert.rejects(
    () =>
      f.server.agent.proactivity.respond("local-user", s.id, {
        requestId: s.requestId,
        clientResponseId: "offline-accept",
        expectedRevision: s.revision,
        action: "start",
      }),
    /unavailable|read|source|connect/i,
  );
  assert.equal(
    (await f.server.agent.proactivity.list("local-user")).find((x) => x.id === s.id)?.status,
    "pending",
  );
  const calendar = await f.server.workspace.readCalendar("local-user", {
    timeMin: "2026-10-02",
    timeMax: "2026-10-03",
    timeZone: "Europe/Berlin",
  });
  assert.equal(calendar.status, "unavailable");
  assert.equal(calendar.metadata.complete, false);
  assert.deepEqual(calendar.metadata.authorizedCalendarIds, ["primary"]);
});

test("the next journal dispatch rechecks the accepted email thread before any effect", async (t) => {
  const f = await fixture(t);
  const s = (await review(f)).find((x) => x.target.kind === "mail")!;
  const accepted = await f.server.agent.proactivity.respond("local-user", s.id, {
    requestId: s.requestId,
    clientResponseId: "accept-fresh",
    expectedRevision: s.revision,
    action: "start",
  });
  assert.ok(accepted.task);
  f.source.messages.push(message("human-reply", "Already handled", true));
  let effects = 0;
  const worker = new TaskWorker(f.db, async (owner, task) => {
    await f.server.agent.journal.prepare(owner, {
      id: "effect-after-accept",
      taskId: task.id,
      revision: 0,
      bindingHash: bindingHash({}),
      executorId: "vps",
      executorEpoch: 1,
      resourceFence: 0,
      status: "queued",
      toolName: "send_email",
      args: {},
      effect: true,
      runToken: String(task.leaseId),
      resourceLeaseIds: [],
      createdAt: new Date().toISOString(),
    });
    await assert.rejects(
      () =>
        f.server.agent.journal.authorizeDispatch(
          owner,
          "effect-after-accept",
          0,
          String(task.leaseId),
        ),
      /answered|changed|obsolete/i,
    );
    const op = (await f.server.agent.journal.operations(owner, task.id))[0];
    if (op.status === "dispatching") effects++;
    return { status: "waiting_input" };
  });
  t.after(() => worker.stop());
  await worker.tick();
  assert.equal(
    (await f.server.agent.getTask("local-user", accepted.task.id)).status,
    "waiting_input",
  );
  assert.equal(effects, 0);
});
