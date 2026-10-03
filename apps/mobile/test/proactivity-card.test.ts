import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProactivitySuggestion } from "../../../packages/domain/src/proactivity.ts";
import { ApiError } from "../src/api-errors.ts";
import type { MessageStorage } from "../src/message-storage.ts";

const suggestion: ProactivitySuggestion = {
  id: "suggestion",
  semanticKey: "goal:one",
  cycleId: "cycle",
  threadId: "chat",
  requestId: "request",
  revision: 1,
  title: "Choose a course",
  reason: "Your saved plan has an open step",
  prompt: "Choose a course",
  target: { kind: "goal", goalId: "goal", revision: 0 },
  evidence: [],
  status: "pending",
  createdAt: "2026-10-02T10:00:00Z",
  updatedAt: "2026-10-02T10:00:00Z",
};
function storage(): MessageStorage {
  const values = new Map<string, string>();
  return {
    async read(key) {
      return values.get(key) ?? null;
    },
    async write(key, value) {
      values.set(key, value);
    },
    async update(key, change) {
      const value = change(values.get(key) ?? null);
      values.set(key, value);
      return value;
    },
  };
}
async function state() {
  const module = await import("../src/proactivity-state.ts").catch(() => undefined);
  assert.ok(module, "Actionable proactivity cards must have durable response state");
  return module;
}
test("double taps and a lost ACK reuse the exact response after reopening the app", async () => {
  const { ProactivitySubmission } = await state();
  const saved = storage();
  const first = new ProactivitySubmission(saved, "owner/chat", suggestion);
  let attempts = 0;
  let body: unknown;
  const failedSend = async (value: unknown): Promise<never> => {
    attempts++;
    body = value;
    throw new Error("lost ACK");
  };
  const a = first.submit("start", undefined, failedSend);
  const b = first.submit("start", undefined, failedSend);
  assert.equal(a, b);
  await assert.rejects(a, /lost ACK/);
  assert.equal(attempts, 1);
  const reopened = new ProactivitySubmission(saved, "owner/chat", suggestion);
  const result = await reopened.submit("start", undefined, async (value) => {
    assert.deepEqual(value, body);
    return {
      suggestion: { ...suggestion, status: "accepted" },
      task: { id: "task", status: "queued" },
    };
  });
  assert.equal(result.task?.status, "queued");
  assert.match((await state()).proactivityTaskLabel("queued", "pt"), /fila/i);
});
test("failed local persistence prevents sending a suggestion response", async () => {
  const { ProactivitySubmission } = await state();
  const saved = storage();
  saved.update = async () => {
    throw new Error("disk unavailable");
  };
  let sent = false;
  const submit = new ProactivitySubmission(saved, "owner/chat", suggestion);
  await assert.rejects(
    () =>
      submit.submit("dismiss", undefined, async () => {
        sent = true;
        return { suggestion };
      }),
    /disk unavailable/,
  );
  assert.equal(sent, false);
});
test("snooze validates a complete instant and stale cards cannot send a different target", async () => {
  const { ProactivitySubmission } = await state();
  const submit = new ProactivitySubmission(storage(), "owner/chat", suggestion);
  await assert.rejects(
    () => submit.submit("snooze", "2026-10-02", async () => ({ suggestion })),
    /time|snooze/i,
  );
  const closed = new ProactivitySubmission(storage(), "owner/chat", {
    ...suggestion,
    status: "resolved",
  });
  await assert.rejects(
    () => closed.submit("start", undefined, async () => ({ suggestion })),
    /closed|current|pending/i,
  );
});

test("a past snooze is rejected before persistence and a reopened card can choose another answer", async () => {
  const { ProactivitySubmission } = await state();
  const saved = storage();
  let sends = 0;
  await assert.rejects(
    new ProactivitySubmission(saved, "owner/chat", suggestion).submit(
      "snooze",
      new Date(Date.now() - 1000).toISOString(),
      async () => {
        sends++;
        return { suggestion };
      },
    ),
    /future snooze/i,
  );
  const result = await new ProactivitySubmission(saved, "owner/chat", suggestion).submit(
    "resolved",
    undefined,
    async () => {
      sends++;
      return { suggestion: { ...suggestion, status: "resolved" } };
    },
  );
  assert.equal(result.suggestion.status, "resolved");
  assert.equal(sends, 1);
});

test("an authoritative snooze rejection releases the saved answer, while an ambiguous HTTP error retains it", async () => {
  const { ProactivitySubmission } = await state();
  const saved = storage();
  const future = new Date(Date.now() + 3600000).toISOString();
  await assert.rejects(
    new ProactivitySubmission(saved, "owner/chat", suggestion).submit(
      "snooze",
      future,
      async () => {
        throw new ApiError("Choose a future snooze time", 422, "PROACTIVITY_INVALID_SNOOZE");
      },
    ),
    /future snooze/i,
  );
  const reopened = new ProactivitySubmission(saved, "owner/chat", suggestion);
  let original: unknown;
  await assert.rejects(
    reopened.submit("start", undefined, async (body) => {
      original = body;
      throw new ApiError("Gateway failed after dispatch", 502);
    }),
    /Gateway/,
  );
  const retry = new ProactivitySubmission(saved, "owner/chat", suggestion);
  await assert.rejects(
    retry.submit("resolved", undefined, async () => ({ suggestion })),
    /Another decision/,
  );
  const result = await retry.submit("start", undefined, async (body) => {
    assert.deepEqual(body, original);
    return { suggestion: { ...suggestion, status: "accepted" } };
  });
  assert.equal(result.suggestion.status, "accepted");
});

test("an uncertain snooze retries its original receipt even after the requested instant is past", async (t) => {
  const { ProactivitySubmission } = await state();
  const saved = storage();
  const now = Date.now();
  const future = new Date(now + 1000).toISOString();
  let original: unknown;
  await assert.rejects(
    new ProactivitySubmission(saved, "owner/chat", suggestion).submit(
      "snooze",
      future,
      async (body) => {
        original = body;
        throw new Error("lost ACK");
      },
    ),
    /lost ACK/,
  );
  t.mock.method(Date, "now", () => now + 2000);
  const result = await new ProactivitySubmission(saved, "owner/chat", suggestion).submit(
    "snooze",
    future,
    async (body) => {
      assert.deepEqual(body, original);
      return { suggestion: { ...suggestion, status: "snoozed" } };
    },
  );
  assert.equal(result.suggestion.status, "snoozed");
});
