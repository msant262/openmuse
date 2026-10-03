import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, parseResponse } from "../apps/mobile/src/api-errors.ts";
import type { MessageStorage } from "../apps/mobile/src/message-storage.ts";
import {
  type ProactivityResult,
  ProactivitySubmission,
} from "../apps/mobile/src/proactivity-state.ts";
import type { ProactivityResponse } from "../packages/domain/src/proactivity.ts";
import { fixture, review } from "./proactivity-fixture.ts";

test("a server-rejected snooze allows editing and retrying the same card after reopening", async (t) => {
  const f = await fixture(t);
  const clientNow = Date.now();
  f.now = clientNow + 2 * 3600000;
  const s = (await review(f, f.now)).find((s) => s.target.kind === "mail")!;
  const session = await f.server.auth.devices.pair("local-user", "synthetic-mobile", "native");
  const values = new Map<string, string>();
  const saved: MessageStorage = {
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
  const bodies: ProactivityResponse[] = [];
  const send = async (body: ProactivityResponse) => {
    bodies.push(body);
    const response = await f.server.app.request(
      `/api/agent/proactivity/suggestions/${s.id}/respond`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return parseResponse<ProactivityResult>(response);
  };
  const first = new ProactivitySubmission(saved, "owner/chat", s);
  await assert.rejects(
    first.submit("snooze", new Date(clientNow + 3600000).toISOString(), send),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 422 &&
      error.code === "PROACTIVITY_INVALID_SNOOZE",
  );
  assert.equal(
    (await f.server.agent.proactivity.list("local-user")).find((card) => card.id === s.id)?.status,
    "pending",
  );
  const reopened = new ProactivitySubmission(saved, "owner/chat", s);
  const result = await reopened.submit(
    "snooze",
    new Date(clientNow + 4 * 3600000).toISOString(),
    send,
  );
  assert.equal(result.suggestion.status, "snoozed");
  assert.equal(bodies.length, 2);
  assert.notEqual(bodies[0].clientResponseId, bodies[1].clientResponseId);
});
