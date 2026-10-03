import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentArtifact,
  AgentNotification,
  AgentTask,
  RunEvent,
} from "../../../packages/domain/src/agent.ts";
import { buildFeed, feedExcerpt, orderedTaskEvents } from "../src/muse-surfaces-model.ts";

const task = (patch: Partial<AgentTask> = {}): AgentTask => ({
  id: "task-1",
  title: "Prepare the document",
  prompt: "Use the saved notes",
  kind: "document",
  status: "succeeded",
  plan: [],
  evidence: [],
  input: {},
  state: {},
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-02T10:00:00Z",
  attempts: 1,
  artifactIds: [],
  result: "The document is ready.",
  ...patch,
});
const notification = (patch: Partial<AgentNotification> = {}): AgentNotification => ({
  id: "notice-1",
  taskId: "task-1",
  title: "Your document is ready",
  body: "The final copy has been saved.",
  createdAt: "2026-10-02T11:00:00Z",
  read: false,
  ...patch,
});
const artifact: AgentArtifact = {
  id: "artifact-1",
  taskId: "task-1",
  kind: "report",
  title: "Saved document",
  summary: "Final copy",
  data: {},
  createdAt: "2026-10-02T10:00:00Z",
};

test("Feed combines a saved task, latest notification, and result without duplicate posts", () => {
  const entries = buildFeed(
    [task()],
    [
      notification(),
      notification({ id: "old-notice", createdAt: "2026-10-01T11:00:00Z", body: "Earlier update" }),
    ],
    [artifact],
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].taskId, "task-1");
  assert.equal(entries[0].body, "The final copy has been saved.");
  assert.equal(entries[0].artifact, artifact);
});

test("Feed preserves a newer task question instead of showing an obsolete completion notice", () => {
  const entries = buildFeed(
    [
      task({
        status: "waiting_input",
        question: "Which recipient should I use?",
        updatedAt: "2026-10-03T12:00:00Z",
      }),
    ],
    [notification()],
    [],
  );
  assert.equal(entries[0].body, "Which recipient should I use?");
});

test("Feed retains standalone notifications and artifacts, in date order, with no invented posts", () => {
  assert.deepEqual(buildFeed([], [], []), []);
  const entries = buildFeed(
    [],
    [notification({ taskId: undefined, createdAt: "2026-10-03T12:00:00Z" })],
    [artifact],
  );
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ["notice:notice-1", "artifact:artifact-1"],
  );
  assert.equal(entries[0].taskId, undefined);
});

test("Task lineage is chronological without changing the saved event array", () => {
  const events: RunEvent[] = [
    {
      id: "done",
      taskId: "task-1",
      date: "2026-10-02T12:00:00Z",
      kind: "result",
      title: "Completed",
      detail: "Saved final copy",
    },
    {
      id: "start",
      taskId: "task-1",
      date: "2026-10-02T10:00:00Z",
      kind: "step",
      title: "Read notes",
      detail: "Read saved notes",
    },
  ];
  assert.deepEqual(
    orderedTaskEvents(events).map((event) => event.id),
    ["start", "done"],
  );
  assert.equal(events[0].id, "done");
});

test("Feed excerpts keep form identifiers in task details without trimming ordinary updates", () => {
  const question =
    "Enter the form values you want to use. Supported fields: participant_name, guardian_name. The original PDF stays intact.";
  assert.equal(feedExcerpt(question), "Enter the form values you want to use.");
  assert.equal(
    feedExcerpt("Your travel plan has three stops. The second needs a booking."),
    "Your travel plan has three stops. The second needs a booking.",
  );
  assert.ok(question.includes("guardian_name"));
});

test("Feed removes legacy desktop receipts and background scans without hiding requested work", () => {
  const internal = [
    task({
      id: "viewer",
      title: "Desktop viewer",
      prompt: "Authenticated desktop observation and control lifecycle",
    }),
    task({
      id: "manual",
      title: "Computer: list",
      prompt: "Perform the requested computer list operation and retain its receipt",
    }),
    task({
      id: "scan",
      title: "Review pending personal work",
      input: { proactivityCycleId: "cycle" },
    }),
    task({ id: "future", input: { internalActivity: true } }),
  ];
  const product = task({
    id: "requested",
    title: "Desktop viewer",
    prompt: "Help me design a desktop viewer",
  });
  const notices = internal.map((item) =>
    notification({ id: `notice-${item.id}`, taskId: item.id, title: item.title }),
  );
  const entries = buildFeed([...internal, product], notices, []);
  assert.deepEqual(
    entries.map((item) => item.taskId),
    ["requested"],
  );
  assert.equal(internal.length, 4, "the underlying audit history is not mutated");
});

test("Feed hides orphan legacy telemetry and keeps meaningful standalone notices", () => {
  const entries = buildFeed(
    [],
    [
      notification({
        id: "viewer",
        taskId: "old-viewer",
        title: "Desktop viewer",
        body: "Desktop viewer closed; desktop and jobs remain available",
      }),
      notification({
        id: "manual",
        taskId: "old-manual",
        title: "Computer: list",
        body: "Work completed",
      }),
      notification({
        id: "scan",
        title: "Review pending personal work",
        body: "Personal review is partial; source coverage and saved suggestions are available",
      }),
      notification({
        id: "useful",
        title: "Your flight price dropped",
        body: "The saved route is now cheaper.",
      }),
    ],
    [],
  );
  assert.deepEqual(
    entries.map((item) => item.id),
    ["notice:useful"],
  );
});

test("Feed preserves the user's task title and describes legacy failures without an unrelated PDF instruction", () => {
  const entries = buildFeed(
    [
      task({
        title: "Create election infographic",
        status: "failed",
        result: undefined,
        error: "Choose a current email with a PDF attachment to start this task",
      }),
    ],
    [
      notification({
        title: "Task needs attention",
        body: "Choose a current email with a PDF attachment to start this task",
      }),
    ],
    [],
  );
  assert.equal(entries[0].title, "Create election infographic");
  assert.equal(entries[0].status, "failed");
  assert.equal(entries[0].body, "Could not finish this task. Open it to review or try again.");
});
