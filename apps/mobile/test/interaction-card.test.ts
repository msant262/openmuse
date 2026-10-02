import assert from "node:assert/strict";
import { test } from "node:test";
import type { InteractionRequest } from "../../../packages/domain/src/runtime.ts";
import {
  QuestionSubmission,
  questionAnswerError,
  questionOptionSpace,
} from "../src/interaction-state.ts";

const request: InteractionRequest = {
  id: "card",
  taskId: "task",
  revision: 1,
  kind: "question",
  status: "waiting",
  createdAt: "2026-10-02T00:00:00Z",
  schema: {
    title: "Travel",
    fields: [
      {
        id: "city",
        label: "City",
        type: "single",
        required: true,
        options: [{ id: "porto", label: "Porto" }],
      },
      {
        id: "days",
        label: "Days",
        type: "multiple",
        required: true,
        options: [
          { id: "fri", label: "Friday" },
          { id: "sat", label: "Saturday" },
        ],
      },
      { id: "comment", label: "Comment", type: "text", required: true, multiline: false },
    ],
  },
};
const values = { city: "porto", days: ["fri", "sat"], comment: "Near the station" };
test("Space selects an accessible question option once without duplicating Pressable Enter or disabled controls", () => {
  let selected = 0,
    prevented = 0;
  const event = (key: string, repeat = false) => ({
    key,
    repeat,
    preventDefault: () => {
      prevented++;
    },
  });
  questionOptionSpace(event(" "), false, () => {
    selected++;
  });
  questionOptionSpace(event("Spacebar", true), false, () => {
    selected++;
  });
  questionOptionSpace(event(" "), true, () => {
    selected++;
  });
  questionOptionSpace(event("Enter"), false, () => {
    selected++;
  });
  assert.equal(selected, 1);
  assert.equal(prevented, 3);
});
test("inline question validates single/multiple/free text and refuses generic approval/secret answers", () => {
  assert.equal(questionAnswerError(request, values), "");
  assert.match(questionAnswerError(request, { ...values, days: [] }), /Days/);
  assert.match(questionAnswerError(request, { ...values, city: "unknown" }), /City/);
  assert.match(questionAnswerError({ ...request, kind: "approval" }, values), /trusted/);
  assert.match(questionAnswerError(request, { ...values, password: "secret" }), /Secrets/);
  assert.match(
    questionAnswerError(
      { ...request, schema: { ...request.schema, title: "Password for this login" } },
      values,
    ),
    /trusted/,
  );
  assert.match(questionAnswerError({ ...request, status: "answered" }, values), /already answered/);
});
test("double tap shares one answer; ACK-loss retry reuses ID; reopening an answered card cannot submit", async () => {
  let resolve!: (value: InteractionRequest) => void;
  const sent: string[] = [];
  const submission = new QuestionSubmission(request, "response1");
  const send = async (body: { clientResponseId: string }) => {
    sent.push(body.clientResponseId);
    return new Promise<InteractionRequest>((done) => {
      resolve = done;
    });
  };
  const first = submission.submit(values, send),
    second = submission.submit(values, send);
  assert.deepEqual(sent, ["response1"]);
  resolve({ ...request, status: "answered", answer: values });
  await Promise.all([first, second]);
  const reopened = new QuestionSubmission({ ...request, status: "answered" }, "new-response");
  await assert.rejects(reopened.submit(values, send), /already answered/);
  const retry = new QuestionSubmission(request, "retry1");
  await assert.rejects(
    retry.submit(values, async (body) => {
      sent.push(body.clientResponseId);
      throw new Error("ACK lost");
    }),
  );
  await retry.submit(values, async (body) => {
    sent.push(body.clientResponseId);
    return { ...request, status: "answered" };
  });
  assert.deepEqual(sent.slice(-2), ["retry1", "retry1"]);
});
