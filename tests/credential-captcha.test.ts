import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { BrowserService } from "../apps/server/src/browser.ts";
import { CredentialBroker } from "../apps/server/src/credentials/broker.ts";
import { type CaptchaRecord, CredentialCaptcha } from "../apps/server/src/credentials/captcha.ts";
import type { CredentialGrantBroker } from "../apps/server/src/credentials/grants.ts";
import { CredentialLoginService } from "../apps/server/src/credentials/login.ts";
import { createStore } from "../apps/server/src/db.ts";
import { authorizeTaskEffect, TaskJournal } from "../apps/server/src/engine/task-journal.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";

async function fixture(t: TestContext) {
  const db = await createStore();
  t.after(() => db.close());
  const broker = new CredentialBroker(
    db,
    {
      write: async () => 1,
      read: async () => assert.fail("CAPTCHA never reads plaintext"),
      delete: async () => {},
    },
    [
      {
        id: "portal",
        serviceName: "Portal",
        origin: "https://portal.test",
        fields: [{ id: "password", label: "Password", type: "password" }],
        selectors: { password: "#password" },
        submitSelector: "#login",
        authenticatedSelector: "#account",
        challengeSubmitSelector: "#verify",
        challengeSelectors: { captcha: "#challenge" },
      },
    ],
  );
  const task = {
    id: randomUUID(),
    status: "running",
    leaseId: randomUUID(),
    attempts: 1,
    leaseUntil: new Date(Date.now() + 600_000).toISOString(),
    state: {
      appliedRevision: 0,
      desiredRevision: 0,
      credentialRef: { id: randomUUID(), version: 1 },
    },
    plan: [],
    evidence: [],
    input: {},
    title: "Read documents",
    prompt: "Read account documents",
    kind: "agent",
    artifactIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as AgentTask;
  const ref = task.state.credentialRef as { id: string; version: number };
  const record: CaptchaRecord = {
    id: randomUUID(),
    taskId: task.id,
    revision: 1,
    credentialRefId: ref.id,
    adapterId: "portal",
    origin: "https://portal.test",
    sessionId: randomUUID(),
    sessionGeneration: randomUUID(),
    executorId: "lenovo",
    profileId: "personal",
    kind: "captcha",
    status: "waiting",
    submissions: 0,
    actionSequence: 0,
    actionId: null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  task.state.credentialChallengeId = record.id;
  await db.put("owner", "tasks", task);
  await db.put("owner", "credentials", {
    id: ref.id,
    credentialRef: ref,
    adapterId: "portal",
    serviceName: "Portal",
    origin: record.origin,
    status: "needs_challenge",
  });
  await db.put("owner", "credential-challenges", record);
  const journal = new TaskJournal(db);
  let calls = 0,
    now = Date.now(),
    status: "pending" | "authenticated" = "pending";
  const browser = {
    runOnExecutor: async (
      _owner: unknown,
      _task: unknown,
      _account: unknown,
      target: {
        sessionId: string;
        executorId: string;
        profileId: string;
        sessionGeneration: string;
      },
      _url: unknown,
      _signal: unknown,
      operation: (id: string) => Promise<unknown>,
    ) => {
      assert.equal(target.executorId, record.executorId);
      assert.equal(target.profileId, record.profileId);
      assert.equal(target.sessionGeneration, record.sessionGeneration);
      return operation(target.sessionId);
    },
    challenge: async () => {
      calls++;
      return { status, sessionId: record.sessionId };
    },
  } as unknown as Pick<BrowserService, "runOnExecutor" | "challenge">;
  let captcha = new CredentialCaptcha(db, broker, browser, { now: () => now });
  const step = (input: unknown, taskOverride = task) =>
    journal.run(
      "owner",
      taskOverride,
      { id: randomUUID(), name: "connection_challenge", args: input },
      async () => {
        await authorizeTaskEffect();
        return captcha.step("owner", task.id, record.id, input);
      },
      true,
    ) as Promise<any>;
  return {
    db,
    broker,
    browser,
    task,
    record,
    step,
    calls: () => calls,
    advance: (ms: number) => (now += ms),
    succeed: () => (status = "authenticated"),
    restart: () => {
      captcha = new CredentialCaptcha(db, broker, browser, { now: () => now });
    },
  };
}
test("three submissions stay exhausted across service restart and provider retry", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) {
    const result = await f.step({ action: "submit", frameId: randomUUID() });
    assert.equal(result.remainingSubmissions, 2 - i);
  }
  f.restart();
  const retried = { ...f.task, attempts: 9 };
  await f.db.put("owner", "tasks", retried);
  assert.equal((await f.step({ action: "observe" }, retried)).status, "manual_required");
  assert.equal(f.calls(), 3);
  assert.equal(
    (await f.db.get<CaptchaRecord>("owner", "credential-challenges", f.record.id))!.submissions,
    3,
  );
});
test("sixty seconds survive restart; human handback can confirm actual success without more input", async (t) => {
  const f = await fixture(t);
  await f.step({ action: "observe" });
  f.advance(61_000);
  f.restart();
  assert.equal((await f.step({ action: "observe" })).status, "manual_required");
  assert.equal(f.calls(), 1);
  f.succeed();
  assert.equal((await f.step({ action: "check" })).status, "authenticated");
  assert.equal(
    (await f.db.get<CaptchaRecord>("owner", "credential-challenges", f.record.id))!.status,
    "completed",
  );
  assert.equal((await f.broker.connection("owner", f.record.credentialRefId)).status, "connected");
});
test("uncertain action is retained and cannot be resubmitted after restart", async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  f.browser.challenge = async () => {
    attempts++;
    throw Object.assign(new Error("receipt lost"), {
      code: "OUTCOME_UNKNOWN",
      outcomeUnknown: true,
    });
  };
  await assert.rejects(f.step({ action: "submit", frameId: randomUUID() }));
  f.restart();
  assert.equal(
    (await f.db.get<CaptchaRecord>("owner", "credential-challenges", f.record.id))!.status,
    "outcome_unknown",
  );
  await assert.rejects(f.step({ action: "submit", frameId: randomUUID() }));
  assert.equal(attempts, 1);
});
test("a paused/revised task cannot dispatch or consume a challenge submission", async (t) => {
  const f = await fixture(t);
  await f.db.put("owner", "tasks", { ...f.task, state: { ...f.task.state, desiredRevision: 1 } });
  await assert.rejects(f.step({ action: "submit", frameId: randomUUID() }));
  assert.equal(f.calls(), 0);
  assert.equal(
    (await f.db.get<CaptchaRecord>("owner", "credential-challenges", f.record.id))!.submissions,
    0,
  );
});
test("browser handback wakes only the matching challenge task and preserves its budget", async (t) => {
  const f = await fixture(t);
  await f.db.put("owner", "tasks", { ...f.task, status: "waiting_input" });
  const login = new CredentialLoginService(
    f.db,
    f.broker,
    f.browser as any,
    {} as CredentialGrantBroker,
  );
  const woken: string[] = [];
  login.configureWake(async (owner, taskId) => {
    assert.equal(owner, "owner");
    woken.push(taskId);
  });
  await login.handback("owner", randomUUID());
  assert.equal(woken.length, 0);
  await login.handback("owner", f.record.sessionId);
  assert.deepEqual(woken, [f.task.id]);
  assert.equal(
    (await f.db.get<CaptchaRecord>("owner", "credential-challenges", f.record.id))!.submissions,
    0,
  );
});

test("OTP remains attached to its direction across provider retries; steering invalidates it", async (t) => {
  const f = await fixture(t);
  const challenge = {
    ...f.record,
    kind: "otp",
    taskRevision: 0,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  await f.db.put("owner", "credential-challenges", challenge);
  await f.db.put("owner", "tasks", { ...f.task, status: "waiting_input", attempts: 7 });
  let stages = 0;
  const grants = {
    stageChallengeCode: () => stages++,
    hasChallengeCode: () => true,
  } as unknown as CredentialGrantBroker;
  const login = new CredentialLoginService(f.db, f.broker, f.browser as any, grants);
  await login.submitChallenge("owner", f.record.id, {
    clientResponseId: "otp-response-once",
    value: "123456",
  });
  assert.equal(stages, 1);
  await f.db.put("owner", "tasks", {
    ...f.task,
    status: "waiting_input",
    attempts: 8,
    state: { ...f.task.state, desiredRevision: 1 },
  });
  await assert.rejects(
    login.submitChallenge("owner", f.record.id, {
      clientResponseId: "otp-response-after-steer",
      value: "654321",
    }),
    /no longer attached/,
  );
  assert.equal(stages, 1);
});

test("stale rejected inputs do not consume submissions or poison the task journal", async (t) => {
  const f = await fixture(t);
  f.browser.challenge = async () => {
    throw Object.assign(new Error("fresh frame required"), { code: "STALE_CHALLENGE_FRAME" });
  };
  const first = await f.step({ action: "submit", frameId: randomUUID() });
  assert.equal(first.dispatched, false);
  assert.equal(
    (await f.db.get<CaptchaRecord>("owner", "credential-challenges", f.record.id))!.submissions,
    0,
  );
  f.browser.challenge = async () => ({ status: "pending", sessionId: f.record.sessionId });
  assert.equal((await f.step({ action: "observe" })).status, "pending");
});
