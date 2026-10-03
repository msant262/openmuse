import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";
import { fixture, review } from "./proactivity-fixture.ts";

test("accepting a selected email request cannot send its reply to another recipient", async (t) => {
  const f = await fixture(t);
  const s = (await review(f)).find((s) => s.target.kind === "mail")!;
  const accepted = await f.server.agent.proactivity.respond("local-user", s.id, {
    requestId: s.requestId,
    clientResponseId: "scope-accept",
    expectedRevision: s.revision,
    action: "start",
  });
  assert.ok(accepted.task);
  let action: ActionProposal | undefined;
  const worker = new TaskWorker(f.db, async (owner, task) => {
    action = await f.server.actions.propose(
      owner,
      {
        kind: "email.send",
        data: {
          to: ["unrelated@example.com"],
          subject: "Re: Coffee this week?",
          body: "Source text",
          attachmentIds: [],
          threadId: "thread-one",
          replyToMessageId: "incoming",
        },
      },
      "scope-recipient",
      task.id,
    );
    return { status: "waiting_input" };
  });
  t.after(() => worker.stop());
  await worker.tick();
  assert.equal(action?.status, "failed");
  assert.match(action?.error ?? "", /scope|recipient|selected/);
  assert.equal(f.source.writes, 0);
});

test("an explicit suppression reversal is persisted in the original interaction history", async (t) => {
  const f = await fixture(t);
  const s = (await review(f)).find((s) => s.target.kind === "mail")!;
  const suppressed = await f.server.agent.proactivity.respond("local-user", s.id, {
    requestId: s.requestId,
    clientResponseId: "suppress-one",
    expectedRevision: s.revision,
    action: "dismiss",
  });
  const restored = await f.server.agent.proactivity.unsuppress(
    "local-user",
    s.id,
    suppressed.suggestion.revision,
  );
  assert.equal(restored.status, "obsolete");
  const request = await f.db.get<{ suggestion: { revision: number; status: string } }>(
    "local-user",
    "interaction-requests",
    s.requestId,
  );
  assert.equal(request?.suggestion.revision, restored.revision);
  assert.equal(request?.suggestion.status, "obsolete");
  await f.restart();
  f.now += 5 * 3600000;
  const fresh = (await review(f, f.now)).find((x) => x.id === s.id)!;
  assert.equal(fresh.status, "pending");
  assert.ok(fresh.revision > restored.revision);
  await assert.rejects(
    () => f.server.agent.proactivity.unsuppress("local-user", s.id, suppressed.suggestion.revision),
    /changed/,
  );
});

test("calendar source metadata does not authorize a disconnected primary calendar", async (t) => {
  const f = await fixture(t);
  await f.db.remove("local-user", "credentials", "google");
  const result = await f.server.workspace.readCalendar("local-user", {
    timeMin: "2026-10-02",
    timeMax: "2026-10-03",
    timeZone: "Europe/Berlin",
  });
  assert.equal(result.status, "disconnected");
  assert.equal(result.metadata.complete, false);
  assert.deepEqual(result.metadata.authorizedCalendarIds, []);
  await assert.rejects(
    () =>
      f.server.workspace.readCalendar("local-user", {
        timeMin: "2026-02-30",
        timeMax: "2026-03-02",
        timeZone: "Europe/Berlin",
      }),
    /date|invalid|impossible|Calendar/i,
  );
});
