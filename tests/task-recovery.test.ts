import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { computerTools } from "../apps/server/src/computer-tools.ts";
import { bindingHash } from "../apps/server/src/conversation-inbox.ts";
import {
  currentExecutorContext,
  TaskExecutorAuthority,
} from "../apps/server/src/engine/task-executor-authority.ts";
import {
  providerContinuationCheckpointSchema,
  publicJournalValue,
} from "../apps/server/src/engine/task-history.ts";
import {
  authorizeTaskEffect,
  TaskOutcomeUnknownError,
} from "../apps/server/src/engine/task-journal.ts";
import { TaskAbortError, TaskWorker } from "../apps/server/src/engine/worker.ts";
import { RoutinesService } from "../apps/server/src/routines.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("the copied executor completes work beyond the former step cap without a forced handoff", async (t) => {
  const { requests } = await modelFixture(t, (index) =>
    index < 16
      ? { name: "set_plan", arguments: { steps: ["Collect facts", "Save report"] } }
      : index === 16
        ? {
            name: "save_artifact",
            arguments: {
              kind: "report",
              title: "Saved report",
              summary: "Source-backed report",
              data: { findings: ["A concrete saved result"] },
            },
          }
        : { name: "finish_task", arguments: { summary: "Saved the report" } },
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await server.agent.createTask("owner", { prompt: "Prepare a report" });
  await server.agent.worker.tick();

  const completed = await server.agent.getTask("owner", task.id);
  assert.equal(completed.status, "succeeded", completed.error ?? completed.question);
  const budget = await server.db.get<{ usedSteps: number }>("owner", "task-budgets", task.id);
  assert.equal(budget?.usedSteps, requests.length);
  assert.ok(requests.length > 16);
});

test("budget exhaustion preserves artifacts and needs an explicit extension", async (t) => {
  const { requests } = await modelFixture(t, () => ({
    name: "save_artifact",
    arguments: {
      kind: "report",
      title: "Partial report",
      summary: "Saved findings",
      data: { findings: ["Useful partial result"] },
    },
  }));
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await server.agent.createTask("owner", { prompt: "Prepare a report" });
  await server.db.put("owner", "task-budgets", {
    id: task.id,
    revision: 0,
    maxSteps: 1,
    usedSteps: 0,
    maxMilliseconds: 60000,
    usedMilliseconds: 0,
  });
  await server.agent.worker.tick();
  const saved = await server.agent.getTask("owner", task.id);
  assert.equal(saved.status, "waiting_input");
  assert.equal(saved.state.budgetExhausted, true);
  assert.equal(saved.artifactIds.length, 1);
  const count = requests.length;
  await server.agent.worker.tick();
  assert.equal(requests.length, count);
  const extension = {
    requestId: "explicit-budget-extension",
    expectedRevision: 0,
    additionalSteps: 1,
  };
  const granted = await server.agent.actor.extendBudget("owner", task.id, extension);
  assert.deepEqual(
    await server.agent.actor.extendBudget("owner", task.id, extension),
    granted,
    "lost acknowledgement retries do not grant the budget twice",
  );
  assert.equal(
    ((await server.agent.detail("owner", task.id)).task.state.budget as { maxSteps: number })
      .maxSteps,
    2,
  );
  assert.equal((await server.agent.getTask("owner", task.id)).status, "queued");
});

test("a parent releases its slot to children and resumes using their shared finite budget", async (t) => {
  const { requests } = await modelFixture(t, (index) =>
    index === 0
      ? {
          name: "delegate_task",
          arguments: { prompt: "Prepare a source report", title: "Source report" },
        }
      : index === 1
        ? { name: "wait_for_children", arguments: {} }
        : index === 2 || index === 4
          ? {
              name: "save_artifact",
              arguments: {
                kind: "report",
                title: index === 2 ? "Source report" : "Combined report",
                summary: "Saved report",
                data: { findings: ["Concrete verified facts"] },
              },
            }
          : { name: "finish_task", arguments: { summary: "Saved verified findings" } },
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const parent = await server.agent.createTask("owner", { prompt: "Prepare a combined report" });
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask("owner", parent.id)).status, "waiting_children");
  assert.equal(
    await server.db.get("__runtime__", "work-admissions", parent.id),
    null,
    "the parent yields its admission",
  );
  const child = (
    await server.db.list<import("../packages/domain/src/agent.ts").AgentTask>("owner", "tasks")
  ).find((task) => task.id !== parent.id);
  assert.ok(child);
  assert.equal(child.state.rootTaskId, parent.id);
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask("owner", parent.id)).status, "queued");
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask("owner", parent.id)).status, "succeeded");
  const budget = await server.db.get<{ usedSteps: number }>("owner", "task-budgets", parent.id);
  assert.equal(budget?.usedSteps, requests.length);
  assert.equal(
    await server.db.get("owner", "task-budgets", child.id),
    null,
    "children do not reset the tree budget",
  );
});

test("native authority requires provenance and binds real physical leases to a waiting job", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", { prompt: "Run an authorized command" });
  const authority = new TaskExecutorAuthority(server.agent.journal, {
    executor: () => ({ hostId: "lenovo" }),
  });
  const request = {
    id: "physical-command",
    executorId: "native-account",
    kind: "command" as const,
    capability: "command" as const,
    args: { command: "printf report" },
  };
  await assert.rejects(
    () => authority.authorize("owner", request, 1, undefined as never),
    /trusted provenance/i,
  );
  let operation: Awaited<ReturnType<typeof authority.authorize>> | undefined;
  const worker = new TaskWorker(server.db, async (owner, running, ctx) => {
    const resources = await server.agent.resourceLeases.acquire(owner, request.id, [
      { key: "cpu-heavy:lenovo", units: 1, mode: "exclusive" },
      { key: "system-admin:lenovo", units: 1, mode: "shared" },
    ]);
    assert.ok(resources);
    for (const lease of resources) await server.agent.resourceLeases.hold(lease);
    await server.agent.journal.prepare(owner, {
      id: "logical-command",
      taskId: running.id,
      revision: 0,
      bindingHash: bindingHash(request.args),
      executorId: "vps",
      executorEpoch: 1,
      resourceFence: 0,
      status: "queued",
      toolName: "run_command",
      args: request.args,
      effect: true,
      runToken: String(running.leaseId),
      resourceLeaseIds: [],
      createdAt: new Date().toISOString(),
    });
    await server.agent.journal.bindResources(owner, "logical-command", request.id, resources);
    // The authority receives explicit server provenance, independently of model arguments.
    operation = await authority.authorize(owner, request, 1, {
      kind: "task",
      taskId: running.id,
      desiredRevision: 0,
      runToken: String(running.leaseId),
      resourceLeaseIds: resources.map((lease) => lease.id),
      resourceBudget: { memoryBytes: 1024 * 1024 * 1024, heavy: true },
    });
    await ctx.holdAdmission();
    return {
      status: "waiting_job",
      state: { ...running.state, waitingComputerCommandId: request.id },
    };
  });
  t.after(() => worker.stop());
  await worker.tick();
  assert.ok(
    operation,
    JSON.stringify({
      task: await server.agent.getTask("owner", task.id),
      leases: await server.db.list("__runtime__", "resource-leases"),
      operations: await server.agent.journal.operations("owner", task.id),
    }),
  );
  await authority.beforeDispatch("owner", operation);
  await server.db.compareAndSwapTask(
    "owner",
    task.id,
    { status: "waiting_job" },
    { status: "cancelled" },
  );
  await server.agent.runtimePause.set("owner", { paused: true, expectedRevision: 0 });
  const original = await server.db.get<{ runToken: string }>(
    "owner",
    "task-operations",
    request.id,
  );
  assert.ok(original);
  const containment = await authority.authorize(
    "owner",
    {
      id: "cancel-owned-command",
      executorId: request.executorId,
      kind: "cancel",
      capability: "command",
      args: { operationId: request.id },
    },
    1,
    {
      kind: "task",
      taskId: task.id,
      desiredRevision: 0,
      runToken: original.runToken,
      resourceLeaseIds: [],
    },
  );
  await authority.beforeDispatch("owner", containment);
  await assert.rejects(
    () =>
      authority.authorize(
        "owner",
        {
          ...request,
          id: "unowned-cancel",
          kind: "cancel",
          args: { operationId: "another-owner-command" },
        },
        1,
        {
          kind: "task",
          taskId: task.id,
          desiredRevision: 0,
          runToken: containment.id,
          resourceLeaseIds: [],
        },
      ),
    /target authority/i,
  );
  await authority.recordReceipt(
    "owner",
    operation,
    { status: "outcome_unknown", data: { cleanupConfirmed: false } },
    1,
  );
  await authority.recordReceipt(
    "owner",
    operation,
    { status: "outcome_unknown", data: { cleanupConfirmed: true } },
    2,
  );
  const op = (await server.agent.journal.operations("owner", task.id)).find(
    (entry) => entry.id === request.id,
  );
  assert.ok(op);
  assert.equal(op?.status, "outcome_unknown");
  assert.equal((op.receipt as { data: { cleanupConfirmed: boolean } }).data.cleanupConfirmed, true);
});

test("native physical success cannot complete a logical file before its publication ACK", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", { prompt: "Create a file" });
  const authority = new TaskExecutorAuthority(server.agent.journal, {
    executor: () => ({ hostId: "lenovo" }),
  });
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const request = {
    id: "physical-file",
    executorId: "native-account",
    kind: "file" as const,
    capability: "files" as const,
    args: { operation: "write", path: "/workspace/report.txt", text: "Requested result" },
  };
  const worker = new TaskWorker(server.db, async (owner, running) => {
    const publication = async () => {
      const resources = await server.agent.resourceLeases.acquire(
        owner,
        "computer-operation:file",
        [
          {
            key: `file:lenovo:${hash(owner).slice(0, 20)}:${hash(request.args.path).slice(0, 32)}`,
            units: 1,
            mode: "exclusive",
          },
        ],
      );
      assert.ok(resources);
      try {
        await authorizeTaskEffect(resources, "computer-operation:file");
        const context = await currentExecutorContext(owner, request.id);
        assert.ok(context);
        const native = await authority.authorize(owner, request, 1, context);
        await authority.beforeDispatch(owner, native);
        await authority.recordReceipt(
          owner,
          native,
          {
            status: "succeeded",
            data: { hash: "published-on-node", cleanupConfirmed: true },
          },
          1,
        );
        const ops = await server.agent.journal.operations(owner, task.id);
        assert.equal(ops.find((op) => op.id === request.id)?.status, "succeeded");
        assert.ok(
          ops
            .filter(
              (op) =>
                op.toolName === "write_computer_file" ||
                op.toolName === "primitive.write_computer_file",
            )
            .every((op) => op.status === "dispatching"),
        );
        throw new Error("Artifact publication ACK failed");
      } finally {
        for (const lease of resources) await server.agent.resourceLeases.release(lease);
      }
    };
    const backend = new Proxy(server.agent.computer, {
      get(target, key, receiver) {
        return key === "write" ? publication : Reflect.get(target, key, receiver);
      },
    });
    const write = computerTools(backend, server.files, owner, "publication").find(
      (tool) => tool.name === "write_computer_file",
    );
    assert.ok(write?.execute);
    const executeWrite = write.execute as unknown as (args: {
      path: string;
      text: string;
    }) => Promise<unknown>;
    await assert.rejects(
      () =>
        server.agent.journal.run(
          owner,
          running,
          { id: "write-file", name: "write_computer_file", args: request.args },
          async () => executeWrite({ path: request.args.path, text: request.args.text }),
          true,
        ),
      TaskOutcomeUnknownError,
    );
    return { status: "waiting_input", question: "Reconcile publication" };
  });
  t.after(() => worker.stop());
  await worker.tick();
  const logical = (await server.agent.journal.operations("owner", task.id)).find(
    (op) => op.toolName === "write_computer_file",
  );
  assert.equal(logical?.status, "outcome_unknown");
  assert.equal((await server.agent.verification.assess("owner", task.id, 0)).status, "unverified");
});

test("worker shutdown carries a typed cause and preserves a pending native review", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", { prompt: "Prepare an event" });
  const action = await server.actions.propose(
    "owner",
    {
      kind: "calendar.create",
      data: {
        title: "Reviewed event",
        start: "2026-10-03T10:00:00+02:00",
        end: "2026-10-03T11:00:00+02:00",
      },
    },
    "review-shutdown",
    task.id,
  );
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let cause: unknown;
  const worker = new TaskWorker(server.db, async (_owner, _running, ctx) => {
    entered();
    await new Promise<void>((resolve) =>
      ctx.signal.addEventListener(
        "abort",
        () => {
          cause = ctx.signal.reason;
          resolve();
        },
        { once: true },
      ),
    );
    await ctx.guard();
    return { status: "waiting_approval" };
  });
  const ticking = worker.tick();
  await started;
  await worker.stop();
  await ticking;
  assert.ok(cause instanceof TaskAbortError);
  assert.equal(cause.cause, "shutdown");
  assert.equal(
    (await server.db.get<{ status: string }>("owner", "actions", action.id))?.status,
    "awaiting_review",
  );
});

test("ask_user survives a provider that would fail the next inference without issuing it", async (t) => {
  const { requests } = await modelFixture(
    t,
    () => ({ name: "ask_user", arguments: { question: "Choose the recipient" } }),
    { errorStatus: (index) => (index ? 500 : undefined) },
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await server.agent.createTask("owner", { prompt: "Prepare the requested message" });
  await server.agent.worker.tick();
  const saved = await server.agent.getTask("owner", task.id);
  assert.equal(saved.status, "waiting_input", saved.error ?? saved.question);
  assert.equal(saved.question, "Choose the recipient");
  assert.equal(requests.length, 1);
  assert.equal((await server.agent.detail("owner", task.id)).interactions.length, 1);
});

test("file publication crash recovers the same intent while two equal imports remain distinct", async (t) => {
  const server = await taskRuntime(t);
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const bytes = await pdf.save();
  const publish = server.files.import.bind(server.files) as (
    ...args: unknown[]
  ) => Promise<{ id: string }>;
  const put = server.db.put.bind(server.db);
  let fail = true;
  server.db.put = async (owner, kind, value) => {
    if (kind === "files" && fail) {
      fail = false;
      throw new Error("Crash after publication");
    }
    return put(owner, kind, value);
  };
  await assert.rejects(
    () => publish("owner", "report.pdf", bytes, "Task", undefined, "intent-a"),
    /Crash after publication/,
  );
  const recovered = await publish("owner", "report.pdf", bytes, "Task", undefined, "intent-a");
  const next = await publish("owner", "report.pdf", bytes, "Task", undefined, "intent-b");
  assert.notEqual(recovered.id, next.id);
  assert.equal(
    (await readdir(join(server.directory, "files"))).length,
    2,
    "retry must reclaim the already published file",
  );
});

test("a blocked routine warns and schedules future occurrences after the prior task settles", async (t) => {
  const server = await taskRuntime(t);
  let now = Date.parse("2026-10-02T07:59:00Z"),
    warnings = 0;
  const routines = new RoutinesService(
    server.db,
    async (owner, input, key) => server.agent.createTask(owner, input, key),
    "UTC",
    () => now,
    async () => {
      warnings++;
    },
  );
  const routine = await routines.create("owner", {
    title: "Daily report",
    prompt: "Prepare a report",
    cron: "0 8 * * *",
  });
  now = Date.parse("2026-10-02T08:00:00Z");
  await routines.tick();
  const prior = (
    await server.db.list<import("../packages/domain/src/agent.ts").AgentTask>("owner", "tasks")
  )[0];
  await server.db.compareAndSwapTask(
    "owner",
    prior.id,
    { status: prior.status },
    { status: "waiting_input", question: "A source is missing" },
  );
  now = Date.parse("2026-10-03T08:00:00Z");
  await routines.tick();
  assert.ok(warnings > 0, "a skipped blocked occurrence must not disappear silently");
  assert.equal((await routines.get("owner", routine.id)).skipped, 1);
  await server.db.compareAndSwapTask(
    "owner",
    prior.id,
    { status: "waiting_input" },
    { status: "succeeded" },
  );
  now = Date.parse("2026-10-04T08:00:00Z");
  await routines.tick();
  assert.equal(
    (await server.db.list("owner", "tasks")).length,
    2,
    "future occurrences still enqueue after the prior run settles",
  );
});

test("public journal values omit model thinking, credentials and configured secrets inside output", () => {
  const previous = process.env.JOURNAL_TEST_API_KEY;
  process.env.JOURNAL_TEST_API_KEY = "configured-secret-with-at-least-eight-bytes";
  try {
    const serialized = JSON.stringify(
      publicJournalValue({
        stdout: "Output configured-secret-with-at-least-eight-bytes",
        thinking: "private reasoning",
        refreshToken: "private refresh token",
        args: { path: "/workspace/report.txt" },
      }),
    );
    assert.ok(!serialized.includes("configured-secret-with-at-least-eight-bytes"));
    assert.ok(!serialized.includes("private reasoning"));
    assert.ok(!serialized.includes("private refresh token"));
    assert.ok(serialized.includes("/workspace/report.txt"));
    const checkpoint = providerContinuationCheckpointSchema.parse({
      version: 1,
      messages: [
        {
          id: "plain-output",
          role: "assistant",
          content: "Output configured-secret-with-at-least-eight-bytes",
        },
      ],
      partialText: "Partial configured-secret-with-at-least-eight-bytes",
      rejectedModel: "fixture",
      accepted: true,
      code: "MODEL_PROVIDER_INTERRUPTED",
    });
    assert.ok(
      !JSON.stringify(checkpoint).includes("configured-secret-with-at-least-eight-bytes"),
      "plain text and partial buffers use the same public secret scrub",
    );
    assert.equal(
      providerContinuationCheckpointSchema.safeParse({
        version: 2,
        messages: [],
        partialText: "",
        rejectedModel: "fixture",
        accepted: true,
        code: "MODEL_PROVIDER_INTERRUPTED",
      }).success,
      false,
    );
  } finally {
    if (previous === undefined) delete process.env.JOURNAL_TEST_API_KEY;
    else process.env.JOURNAL_TEST_API_KEY = previous;
  }
});
