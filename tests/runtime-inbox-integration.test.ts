import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversationInbox, messageContentHash } from "../apps/server/src/conversation-inbox.ts";
import { createStore } from "../apps/server/src/db.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { TaskMailbox } from "../packages/domain/src/runtime.ts";

test("accepted chat and steering leave four active tasks running and survive stale checkpoints", async () => {
  const db = await createStore();
  const inbox = new ConversationInbox(db);
  const starts: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worker = new TaskWorker(db, async (_owner, running, context) => {
    starts.push(running.id);
    await gate;
    assert.equal(context.signal.aborted, false);
    await context.guard();
    await context.checkpoint({ state: { ...running.state, savedProgress: "kept" } });
    return { status: "succeeded" };
  });
  let tick: Promise<void> | undefined;
  try {
    for (let index = 0; index < 4; index++) {
      const now = new Date().toISOString();
      const task: AgentTask = {
        id: `work-${index}`,
        title: `Work ${index}`,
        prompt: "Prepare the requested work",
        kind: "agent",
        status: "queued",
        plan: [],
        evidence: [],
        input: {},
        state: { desiredRevision: 0, mailboxSeq: 0 },
        createdAt: now,
        updatedAt: now,
        attempts: 0,
        leaseId: null,
        leaseUntil: null,
        artifactIds: [],
      };
      await db.put("owner", "tasks", task);
    }
    tick = worker.tick();
    const deadline = Date.now() + 10_000;
    while (starts.length < 4 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(starts.length, 4);
    const direction = {
      threadId: "chat",
      clientMessageId: "direction-1",
      targetTaskId: "work-0",
      text: "Use the new title for that report",
      attachmentIds: [],
    };
    const envelope = { ...direction, contentHash: messageContentHash(direction) };
    const receipt = await inbox.acceptMessage("owner", envelope);
    const retry = await inbox.acceptMessage("owner", envelope);
    assert.equal(retry.runId, receipt.runId);
    assert.equal(retry.duplicate, true);
    const chat = {
      threadId: "chat",
      clientMessageId: "chat-2",
      text: "How are the other tasks going?",
      attachmentIds: [],
    };
    await inbox.acceptMessage("owner", { ...chat, contentHash: messageContentHash(chat) });
    assert.ok((await db.list<AgentTask>("owner", "tasks")).every((t) => t.status === "running"));
    release();
    await tick;
    const saved = await db.get<AgentTask>("owner", "tasks", "work-0");
    assert.equal(saved?.state.savedProgress, "kept");
    assert.equal(saved?.state.desiredRevision, 1);
    assert.equal(saved?.state.mailboxSeq, 1);
    const mailbox = await db.list<TaskMailbox>("owner", "task-mailbox");
    assert.equal(mailbox.length, 1);
    assert.equal(mailbox[0].status, "received", "only M4 may claim the direction was applied");
    assert.equal(mailbox[0].directiveId, "directive:chat:direction-1");
    assert.ok((await db.list<AgentTask>("owner", "tasks")).every((t) => t.status === "succeeded"));
    assert.equal(starts.length, 4, "chat and retry did not restart any task");
  } finally {
    release();
    await Promise.allSettled(tick ? [tick] : []);
    try {
      await worker.stop();
    } finally {
      await db.close();
    }
  }
});
