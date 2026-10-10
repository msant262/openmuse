import assert from "node:assert/strict";
import { test } from "node:test";
import { AbstractAgent } from "@ag-ui/client";
import { type BaseEvent, EventType } from "@ag-ui/core";
import { CopilotKitCore } from "@copilotkit/core";
import { Subject, throwError } from "rxjs";
import { ConversationQueue } from "../apps/mobile/src/conversation-queue.ts";
import {
  connectConversationStream,
  runConversationTurn,
} from "../apps/mobile/src/conversation-run.ts";

test("a live reconnect clears its warning on a received snapshot before the stream finishes", async () => {
  const events = new Subject<BaseEvent>();
  let runs = 0;
  class LiveAgent extends AbstractAgent {
    run() {
      runs++;
      return throwError(() => new Error("Must not run"));
    }
    connect() {
      return events;
    }
  }
  const agent = new LiveAgent({ agentId: "default", threadId: "recovered-thread" });
  const core = new CopilotKitCore({ agents__unsafe_dev_only: { default: agent } });
  let restored = 0;
  let finished = false;
  const pending = connectConversationStream(
    "default",
    agent,
    () => core.connectAgent({ agent }),
    (onError) => core.subscribe({ onError }),
    () => {
      restored++;
    },
  ).then(() => {
    finished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  events.next({ type: EventType.RUN_STARTED, threadId: "recovered-thread", runId: "restored" });
  agent.threadId = "different-thread";
  events.next({ type: EventType.STATE_SNAPSHOT, snapshot: {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(restored, 0, "a snapshot for the former selection cannot clear the current error");
  agent.threadId = "recovered-thread";
  events.next({ type: EventType.MESSAGES_SNAPSHOT, messages: [] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(restored, 1);
  assert.equal(finished, false);
  assert.equal(runs, 0);
  events.next({ type: EventType.STATE_SNAPSHOT, snapshot: {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(restored, 1);
  events.next({ type: EventType.RUN_FINISHED, threadId: "recovered-thread", runId: "restored" });
  events.complete();
  await pending;
  assert.equal(finished, true);
});

test("read-only reconnect surfaces a swallowed SDK connection error without starting another run", async () => {
  let connects = 0;
  let runs = 0;
  class ReconnectingAgent extends AbstractAgent {
    run() {
      runs++;
      return throwError(() => new Error("Must not run"));
    }
    connect() {
      connects++;
      return throwError(() => new Error("Connection interrupted"));
    }
  }
  const agent = new ReconnectingAgent({ agentId: "default" });
  const core = new CopilotKitCore({ agents__unsafe_dev_only: { default: agent } });
  await assert.rejects(
    runConversationTurn(
      "default",
      () => core.connectAgent({ agent }),
      (onError) => core.subscribe({ onError }),
    ),
    /Connection interrupted/,
  );
  assert.equal(connects, 1);
  assert.equal(runs, 0);
});

test("an emitted CopilotKit run error stops the queue even when runAgent resolves", async () => {
  let attempts = 0;
  class FailingAgent extends AbstractAgent {
    run() {
      attempts++;
      return throwError(() => new Error("Connection interrupted"));
    }
  }
  const agent = new FailingAgent({ agentId: "default" });
  const core = new CopilotKitCore({ agents__unsafe_dev_only: { default: agent } });
  const queue = new ConversationQueue();
  queue.enqueue({ id: "first", text: "First task" });
  queue.enqueue({ id: "second", text: "Second task" });
  await assert.rejects(
    queue.flush(() =>
      runConversationTurn(
        "default",
        () => core.runAgent({ agent }),
        (onError) => core.subscribe({ onError }),
      ),
    ),
    /Connection interrupted/,
  );
  assert.equal(attempts, 1);
  assert.equal(queue.getSnapshot().paused, true);
  assert.deepEqual(
    queue.getSnapshot().pending.map((message) => message.id),
    ["first", "second"],
  );
});
