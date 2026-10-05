import assert from "node:assert/strict";
import test from "node:test";
import { AbstractAgent, type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import { lastValueFrom, Observable, toArray } from "rxjs";
import { createStore } from "../apps/server/src/db.ts";
import { LocalThreads } from "../apps/server/src/threads.ts";

test("a burst of costly durable stream events leaves the lease heartbeat time to run", async (t) => {
  const db = await createStore();
  const threads = new LocalThreads(db, 1000);
  t.after(async () => {
    await threads.close();
    await db.close();
  });
  const append = db.appendRecordEvent.bind(db);
  t.mock.method(db, "appendRecordEvent", async (...args: Parameters<typeof append>) => {
    // Model a busy embedded database without replacing its durable writes or fencing.
    const until = performance.now() + 8;
    while (performance.now() < until) {}
    return append(...args);
  });
  class BurstAgent extends AbstractAgent {
    run(input: RunAgentInput) {
      return new Observable<BaseEvent>((subscriber) => {
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        });
        subscriber.next({
          type: EventType.TEXT_MESSAGE_START,
          messageId: "answer",
          role: "assistant",
        });
        for (let i = 0; i < 160; i++)
          subscriber.next({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "answer",
            delta: "word ",
          });
        subscriber.next({ type: EventType.TEXT_MESSAGE_END, messageId: "answer" });
        subscriber.next({
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        });
        subscriber.complete();
      });
    }
  }
  const input = {
    threadId: "busy-stream",
    runId: "burst",
    messages: [{ id: "question", role: "user" as const, content: "Continue" }],
    state: {},
    tools: [],
    context: [],
  };
  const events = await lastValueFrom(
    threads
      .withOwner("owner", () =>
        threads.run({ threadId: input.threadId, input, agent: new BurstAgent() }),
      )
      .pipe(toArray()),
  );
  assert.deepEqual(
    events.filter((event) => event.type === EventType.RUN_ERROR),
    [],
  );
  const history = await threads.history("owner", input.threadId);
  assert.equal(
    history.messages.find((message) => message.id === "answer")?.content,
    "word ".repeat(160),
  );
  assert.equal(await db.threadLeaseActive("owner", input.threadId), false);
});
