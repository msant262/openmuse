import assert from "node:assert/strict";
import { test } from "node:test";
import type { InteractionRequest } from "../../../packages/domain/src/runtime.ts";
import * as interactions from "../src/interaction-state.ts";

const question = (
  id: string,
  revision: number,
  status: "waiting" | "answered" | "superseded",
  taskId = "research",
): InteractionRequest => ({
  id,
  taskId,
  revision,
  status,
  kind: "question",
  createdAt: `2026-10-03T16:0${revision}:00Z`,
  schema: {
    title: "How should I continue?",
    fields: [{ id: "reply", label: "Answer", type: "text", required: true, multiline: true }],
  },
  ...(status === "answered" ? { answer: { reply: "That is enough, stop here." } } : {}),
});
function partition(requests: InteractionRequest[]) {
  assert.equal(
    typeof interactions.partitionInteractions,
    "function",
    "the conversation must separate active questions from history",
  );
  return interactions.partitionInteractions(requests);
}

test("answered questions stay in history and cannot leave an older cached form active", () => {
  const old = question("old", 1, "waiting");
  const result = partition([old, question("answer", 2, "answered")]);
  assert.deepEqual(result.pending, []);
  assert.deepEqual(
    result.history.map((r) => [r.id, r.status]),
    [
      ["old", "superseded"],
      ["answer", "answered"],
    ],
  );
  assert.equal(old.status, "waiting", "presentation does not mutate the replay snapshot");
});

test("one current question per task remains visible without hiding another task's question", () => {
  const result = partition([
    question("third", 3, "waiting"),
    question("other", 1, "waiting", "other-task"),
    question("first", 1, "answered"),
    question("second", 2, "waiting"),
  ]);
  assert.deepEqual(
    result.pending.map((r) => r.id),
    ["other", "third"],
  );
  assert.deepEqual(
    result.history.map((r) => r.id),
    ["first", "second"],
  );
});

test("replayed versions of the same answer cannot resurrect a pending form", () => {
  const answered = question("same", 1, "answered");
  const result = partition([answered, question("same", 1, "waiting"), answered]);
  assert.equal(result.pending.length, 0);
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].status, "answered");
});
