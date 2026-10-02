import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTask } from "../../../packages/domain/src/agent.ts";
import { completionLabel, TimingSubmission, timingDraft } from "../src/task-runtime-state.ts";

function task(timing: AgentTask["timing"] = { priority: "normal", timezone: "Europe/Berlin" }) {
  return {
    title: "Task",
    prompt: "Prepare the file",
    kind: "agent",
    plan: [],
    evidence: [],
    input: {},
    createdAt: "2026-10-02T12:00:00Z",
    updatedAt: "2026-10-02T12:00:00Z",
    attempts: 0,
    artifactIds: [],
    id: "task-a",
    status: "running",
    state: { timingRevision: 4 },
    timing,
  } satisfies AgentTask;
}
test("editing a different timing field preserves an existing instant in a repeated Berlin hour", () => {
  const original = task({
    priority: "normal",
    timezone: "Europe/Berlin",
    dueAt: "2026-10-25T01:30:12.123Z",
  });
  const draft = timingDraft(original);
  assert.match(draft.dueAt, /2026-10-25T02:30:12\+01:00/);
  const submission = new TimingSubmission(original, () => "change-1");
  assert.deepEqual(submission.prepare({ ...draft, priority: "high" }), {
    expectedRevision: 4,
    requestId: "change-1",
    priority: "high",
  });
});
test("lost timing ACK retries its immutable original body even if the task's revision has advanced", () => {
  const original = task();
  let generated = 0;
  const submission = new TimingSubmission(original, () => `change-${++generated}`);
  const draft = {
    ...timingDraft(original),
    dueAt: "2026-10-03 16:00",
    validUntil: "2026-10-03 17:00",
  };
  const first = submission.prepare(draft);
  original.state.timingRevision = 5;
  assert.deepEqual(submission.prepare(draft), first);
  assert.equal(generated, 1);
  assert.equal(first.expectedRevision, 4);
  assert.equal(first.dueAt, "2026-10-03 16:00");
  assert.equal(first.validUntil, "2026-10-03 17:00");
  assert.throws(() => submission.prepare({ ...draft, priority: "high" }), /pending/);
});
test("clearing desired deadline does not silently remove the authorization expiry", () => {
  const original = task({
    priority: "low",
    timezone: "Europe/Berlin",
    dueAt: "2026-10-02T12:00:00Z",
    validUntil: "2026-10-02T13:00:00Z",
  });
  const submission = new TimingSubmission(original, () => "clear");
  assert.deepEqual(submission.prepare({ ...timingDraft(original), dueAt: "" }), {
    expectedRevision: 4,
    requestId: "clear",
    dueAt: null,
  });
});
test("completion labels do not turn partial evidence into a verified delivery", () => {
  assert.equal(
    completionLabel({ status: "partial", checks: [], remaining: ["Upload missing"] }),
    "Partial delivery",
  );
  assert.equal(
    completionLabel({ status: "unverified", checks: [], remaining: [] }),
    "Result not verified",
  );
  assert.equal(
    completionLabel({ status: "verified", checks: [], remaining: [] }),
    "Delivery verified",
  );
  assert.equal(completionLabel(undefined), undefined);
});
