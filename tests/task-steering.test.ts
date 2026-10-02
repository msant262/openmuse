import assert from "node:assert/strict";
import { test } from "node:test";
import { bindingHash, messageContentHash } from "../apps/server/src/conversation-inbox.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import type { TaskMailbox } from "../packages/domain/src/runtime.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("accepted direction is applied at a model safe point with an idempotent inbox receipt", async (t) => {
  const { requests } = await modelFixture(t, () => ({
    name: "ask_user",
    arguments: { question: "Which format?" },
  }));
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await server.agent.createTask("owner", {
    prompt: "Prepare a report",
    originThreadId: "chat",
  });
  const input = {
    threadId: "chat",
    clientMessageId: "direction-1",
    text: "Use the title Spring",
    targetTaskId: task.id,
    attachmentIds: [],
  };
  const envelope = { ...input, contentHash: messageContentHash(input) };
  const first = await server.inbox.acceptMessage("owner", envelope);
  const retry = await server.inbox.acceptMessage("owner", envelope);
  assert.equal(retry.runId, first.runId);
  await server.agent.worker.tick();
  const saved = await server.agent.getTask("owner", task.id);
  assert.equal(saved.state.appliedRevision, 1);
  assert.equal(saved.state.appliedMailboxSeq, 1);
  const mailbox = await server.db.list<TaskMailbox>("owner", "task-mailbox");
  assert.equal(mailbox.length, 1);
  assert.equal(mailbox[0].status, "applied");
  assert.ok(requests[0].body.includes("Use the title Spring"));
  const events = await server.inbox.eventsAfter("owner", "chat");
  assert.ok(
    events.events.some(
      (event) => event.kind === "directive" && (event.payload as TaskMailbox).status === "applied",
    ),
  );
});

test("dispatch authority rejects a resource lease borrowed from another task", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", { prompt: "Prepare a result" });
  const unrelated = await server.agent.resourceLeases.acquire("owner", "other-task", [
    { key: "file:fixture:report", units: 1, mode: "exclusive" },
  ]);
  assert.ok(unrelated);
  const worker = new TaskWorker(server.db, async (owner, running) => {
    await server.agent.journal.prepare(owner, {
      id: "resource-operation",
      taskId: running.id,
      revision: 0,
      bindingHash: bindingHash({ text: "report" }),
      executorId: "vps",
      executorEpoch: 1,
      resourceFence: unrelated[0].fence,
      status: "queued",
      toolName: "write_file",
      args: { text: "report" },
      effect: true,
      runToken: String(running.leaseId),
      resourceLeaseIds: [unrelated[0].id],
      createdAt: new Date().toISOString(),
    });
    await assert.rejects(
      () =>
        server.agent.journal.authorizeDispatch(
          owner,
          "resource-operation",
          0,
          String(running.leaseId),
          unrelated,
        ),
      /resource|lease/i,
    );
    return { status: "waiting_input" };
  });
  t.after(() => worker.stop());
  await worker.tick();
  const saved = await server.agent.getTask("owner", task.id);
  assert.equal(saved.status, "waiting_input", saved.error ?? saved.question);
});

test("a direction accepted before dispatch fences the old intention without cancelling its task", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", {
    prompt: "Create a result",
    originThreadId: "chat",
  });
  let sent = 0;
  const worker = new TaskWorker(server.db, async (owner, running) => {
    await server.agent.journal.prepare(owner, {
      id: "old-intent",
      taskId: running.id,
      revision: 0,
      bindingHash: bindingHash({ value: 1 }),
      executorId: "vps",
      executorEpoch: 1,
      resourceFence: 0,
      status: "queued",
      toolName: "write_file",
      args: { value: 1 },
      effect: true,
      runToken: String(running.leaseId),
      resourceLeaseIds: [],
      createdAt: new Date().toISOString(),
    });
    await server.agent.mailbox.enqueue(owner, running.id, {
      clientMessageId: "new-direction",
      threadId: "chat",
      text: "Use value 2",
    });
    await assert.rejects(
      () => server.agent.journal.authorizeDispatch(owner, "old-intent", 0, String(running.leaseId)),
      /superseded/i,
    );
    const old = (await server.agent.journal.operations(owner, running.id))[0];
    if (old.status === "dispatching") sent++;
    return { status: "queued" };
  });
  t.after(() => worker.stop());
  await worker.tick();
  assert.equal(sent, 0);
  const saved = await server.agent.getTask("owner", task.id);
  assert.equal(saved.status, "queued");
  assert.equal(saved.state.desiredRevision, 1);
  assert.equal((await server.agent.journal.operations("owner", task.id))[0].status, "superseded");
});

test("a direction accepted after dispatch preserves its receipt and is applied at the next safe point", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", {
    prompt: "Create a result",
    originThreadId: "chat",
  });
  let effects = 0;
  const worker = new TaskWorker(server.db, async (owner, running, ctx) => {
    await server.agent.journal.prepare(owner, {
      id: "sent-intent",
      taskId: running.id,
      revision: 0,
      bindingHash: bindingHash({ value: 1 }),
      executorId: "vps",
      executorEpoch: 1,
      resourceFence: 0,
      status: "queued",
      toolName: "write_file",
      args: { value: 1 },
      effect: true,
      runToken: String(running.leaseId),
      resourceLeaseIds: [],
      createdAt: new Date().toISOString(),
    });
    await server.agent.journal.authorizeDispatch(owner, "sent-intent", 0, String(running.leaseId));
    effects++;
    await server.agent.mailbox.enqueue(owner, running.id, {
      clientMessageId: "after-dispatch",
      threadId: "chat",
      text: "Use another title for the next result",
    });
    await server.agent.journal.recordReceipt(owner, "sent-intent", { written: true });
    const latest = await server.agent.actor.apply(owner, running, ctx);
    assert.equal(latest.state.appliedRevision, 1);
    return { status: "waiting_input" };
  });
  t.after(() => worker.stop());
  await worker.tick();
  assert.equal(effects, 1);
  assert.equal((await server.agent.journal.operations("owner", task.id))[0].status, "succeeded");
  assert.equal((await server.agent.mailbox.list("owner", task.id))[0].status, "applied");
});

test("a direction racing verified completion keeps the task queued for its latest revision", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", {
    prompt: "Prepare a report",
    originThreadId: "chat",
  });
  const worker = new TaskWorker(server.db, async (owner, running) => {
    await server.agent.mailbox.enqueue(owner, running.id, {
      clientMessageId: "finish-race",
      threadId: "chat",
      text: "Add a cost table",
    });
    return {
      status: "succeeded",
      completion: { status: "verified", checks: [], remaining: [] },
      state: { ...running.state, verificationRevision: 0 },
    };
  });
  t.after(() => worker.stop());
  await worker.tick();
  const saved = await server.agent.getTask("owner", task.id);
  assert.equal(saved.status, "queued");
  assert.equal(saved.state.desiredRevision, 1);
  assert.ok(saved.completion?.remaining.some((item) => /direction|revision/i.test(item)));
});

test("applying a direction does not revive a proposal prepared for the previous revision", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", {
    prompt: "Send the reviewed calendar invitation",
    originThreadId: "chat",
  });
  const proposal = await server.actions.propose(
    "owner",
    {
      kind: "calendar.create",
      data: {
        title: "Old recipient",
        start: "2026-10-03T10:00:00+02:00",
        end: "2026-10-03T11:00:00+02:00",
      },
    },
    "old-reviewed-binding",
    task.id,
  );
  let effects = 0;
  const execute = server.workspace.execute.bind(server.workspace);
  server.workspace.execute = async (...args) => {
    effects++;
    return execute(...args);
  };
  const worker = new TaskWorker(server.db, async (owner, running, ctx) => {
    await server.agent.mailbox.enqueue(owner, running.id, {
      clientMessageId: "changed-recipient",
      threadId: "chat",
      text: "Use the new recipient instead",
    });
    const applied = await server.agent.actor.apply(owner, running, ctx);
    assert.equal(applied.state.appliedRevision, 1);
    return { status: "waiting_approval", actionId: proposal.id };
  });
  t.after(() => worker.stop());
  await worker.tick();
  await assert.rejects(
    () => server.actions.decide("owner", proposal.id, proposal.hash, "approve"),
    /superseded|direction/i,
  );
  assert.equal(effects, 0);
  assert.equal(
    (await server.db.get<{ status: string }>("owner", "actions", proposal.id))?.status,
    "awaiting_review",
  );
});
