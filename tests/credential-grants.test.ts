import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import type { CredentialAdapter, SecretStore } from "../apps/server/src/credentials/contracts.ts";
import { trustedCredentialPlan } from "../apps/server/src/credentials/trusted-input.ts";
import {
  hello as baseHello,
  nodeToken,
  registration as baseRegistration,
} from "./helpers/executors.ts";

const owner = "local-user";
const canary = "PRIVATE-CREDENTIAL-CANARY";
const adapter: CredentialAdapter = {
  id: "portal-test",
  serviceName: "Portal Test",
  origin: "https://portal.example.test",
  fields: [
    { id: "username", label: "Email", type: "text", required: true },
    { id: "password", label: "Password", type: "password", required: true },
  ],
  selectors: { username: "#username", password: "#password" },
  submitSelector: "#submit",
  authenticatedSelector: "#signed-in",
};

async function runtime(t: TestContext, secretStore: SecretStore) {
  const directory = await mkdtemp(join(tmpdir(), "okami-credential-grant-app-"));
  const db = await createStore();
  const registration = { ...baseRegistration, owner };
  const browserSessionId = randomUUID();
  const desktopSessionId = randomUUID();
  const sessionGeneration = randomUUID();
  const profileId = "okami-personal";
  const executorHello = {
    ...baseHello,
    capabilities: [{ name: "browser.dom" as const, version: 1 }],
    readiness: {
      ...baseHello.readiness,
      account: { state: "ready" as const },
      runtime: { state: "ready" as const },
      files: { state: "ready" as const },
      display: { state: "ready" as const },
      capture: { state: "ready" as const },
      input: { state: "ready" as const },
      browser: { state: "ready" as const },
      desktopSession: {
        id: desktopSessionId,
        browserSessionId,
        sessionGeneration,
        profileId,
        width: 1280,
        height: 720,
      },
    },
  };
  const config: Config = {
    mode: "sample",
    agentBackend: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    computerEnabled: true,
    computerBackend: "native",
    nativeExecutorId: registration.executorId,
    nativeExecutors: [registration],
    taskWorkerEnabled: false,
  };
  const server = await createApp(db, config, {
    credentialSecretStore: secretStore,
    credentialAdapters: [adapter],
  });
  const node = async (route: string, body: unknown) => {
    const response = await server.app.request(`/executor/${registration.executorId}/${route}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${nodeToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    return payload as any;
  };
  const { epoch } = await node("register", executorHello);
  await node("reconcile", {
    epoch,
    bootId: executorHello.bootId,
    operations: [],
    contained: true,
  });
  t.after(async () => {
    await server.agent.stop();
    if (server.threads && "close" in server.threads) await server.threads.close();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    server,
    db,
    node,
    epoch,
    registration,
    browserSessionId,
    desktopSessionId,
    sessionGeneration,
    profileId,
  };
}

function secretFixture(read: () => Promise<{ version: number; data: Record<string, string> }>) {
  let reads = 0;
  const store: SecretStore = {
    async write() {
      return 1;
    },
    async read() {
      reads++;
      return read();
    },
    async delete() {},
  };
  return { store, reads: () => reads };
}

async function startLogin(
  server: Awaited<ReturnType<typeof runtime>>["server"],
  db: Awaited<ReturnType<typeof runtime>>["db"],
  refId: string,
) {
  const taskId = randomUUID();
  const task = {
    id: taskId,
    title: "Read portal documents",
    prompt: "Read the latest documents",
    kind: "agent",
    status: "running",
    leaseId: randomUUID(),
    leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    attempts: 1,
    plan: [],
    evidence: [],
    input: {},
    state: {
      credentialRef: { id: refId, version: 1 },
      appliedRevision: 0,
      desiredRevision: 0,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    artifactIds: [],
  } as AgentTask;
  await db.put(owner, "tasks", task);
  await db.put(owner, "credentials", {
    id: refId,
    adapterId: adapter.id,
    serviceName: adapter.serviceName,
    origin: adapter.origin,
    credentialRef: { id: refId, version: 1 },
    status: "saved",
    updatedAt: new Date().toISOString(),
  });
  assert.equal(await server.agent.workAdmission.claim(taskId, "background", taskId), true);
  const result = server.agent.journal.run(
    owner,
    task,
    {
      id: "credential-login",
      name: "authenticate_connection",
      args: { credentialRefId: refId },
    },
    () => server.credentialLogin.authenticate(owner, taskId, refId),
    true,
  );
  return { taskId, task, result };
}

async function nextOperation(
  node: (route: string, body: unknown) => Promise<{ operations: any[] }>,
  epoch: number,
) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await node("claim", { epoch, waitMs: 0 });
    if (result.operations.length) return result.operations[0];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Native browser operation was not published");
}

async function receipt(
  node: (route: string, body: unknown) => Promise<unknown>,
  epoch: number,
  operationId: string,
  data: Record<string, unknown>,
  status: "succeeded" | "rejected_not_dispatched" = "succeeded",
) {
  await node("receipt", {
    epoch,
    operationId,
    sequence: 1,
    receipt: { status, data },
  });
}

test("actual app and registry bind a grant to the published Lenovo delivery and return it once", async (t) => {
  const secrets = secretFixture(async () => ({
    version: 1,
    data: { username: "owner@example.test", password: canary },
  }));
  const context = await runtime(t, secrets.store);
  const refId = randomUUID();
  const { taskId, task, result } = await startLogin(context.server, context.db, refId);

  const opening = await nextOperation(context.node, context.epoch);
  assert.equal(opening.args.operation, "open");
  await receipt(context.node, context.epoch, opening.id, {
    id: context.browserSessionId,
    url: adapter.origin,
    title: "Portal Test",
    status: "active",
    control: "agent",
    updatedAt: new Date().toISOString(),
  });

  const operation = await nextOperation(context.node, context.epoch);
  assert.equal(operation.kind, "browser");
  assert.equal(operation.args.operation, "credentials");
  const grantId = (operation.args.body as { grantId: string }).grantId;
  const request = () =>
    context.server.app.request(
      `/executor/${context.registration.executorId}/credential-grants/${grantId}/consume`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${nodeToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          epoch: context.epoch,
          operationId: operation.id,
          sessionId: context.browserSessionId,
          desktopSessionId: context.desktopSessionId,
          sessionGeneration: context.sessionGeneration,
          origin: adapter.origin,
        }),
      },
    );

  const consumed = await request();
  assert.equal(consumed.status, 200, await consumed.clone().text());
  const input = await consumed.json();
  assert.equal(
    input.fields.find((field: { selector: string }) => field.selector === "#password").value,
    canary,
  );
  assert.equal(secrets.reads(), 1);
  assert.equal(
    (await request()).status,
    404,
    "the same claimed delivery cannot read a grant twice",
  );

  await receipt(context.node, context.epoch, operation.id, {
    status: "authenticated",
    origin: adapter.origin,
    sessionId: context.browserSessionId,
    sessionGeneration: context.sessionGeneration,
    executorId: context.registration.executorId,
    profileId: context.profileId,
  });
  assert.equal(((await result) as { status: string }).status, "connected");
  assert.equal((await context.server.credentials.connection(owner, refId)).status, "connected");

  const pendingChallengeId = randomUUID();
  context.server.credentialGrants.stageChallengeCode(
    owner,
    taskId,
    refId,
    pendingChallengeId,
    "123456",
  );
  await context.server.agent.journal.run(
    owner,
    task,
    { id: "pending-credential-grant", name: "authenticate_connection", args: {} },
    () =>
      context.server.credentialGrants.issue(
        owner,
        {
          id: context.desktopSessionId,
          browserSessionId: context.browserSessionId,
          sessionGeneration: context.sessionGeneration,
          executorId: context.registration.executorId,
          executorEpoch: context.epoch,
        },
        trustedCredentialPlan(adapter, refId, taskId, 0),
      ),
    true,
  );
  assert.equal(context.server.credentialGrants.pendingCount, 1);
  assert.equal(
    context.server.credentialGrants.hasChallengeCode(owner, taskId, pendingChallengeId),
    true,
  );
  const revoked = await context.server.credentials.revoke(owner, refId);
  assert.equal(revoked.browserSessionRevoked, false);
  assert.equal(context.server.credentialGrants.pendingCount, 0);
  assert.equal(
    context.server.credentialGrants.hasChallengeCode(owner, taskId, pendingChallengeId),
    false,
  );
  const durable = JSON.stringify([
    await context.db.list(owner, "task-operations"),
    await context.server.executors.deliveries(owner, context.registration.executorId),
    await context.db.list(owner, "action-log"),
  ]);
  assert.equal(durable.includes(canary), false);
  assert.equal(durable.includes("owner@example.test"), false);
});

test("concurrent consume claims once and a pause/revision during vault read prevents response release", async (t) => {
  let enterRead!: () => void;
  let releaseRead!: () => void;
  const entered = new Promise<void>((resolve) => (enterRead = resolve));
  const blocked = new Promise<void>((resolve) => (releaseRead = resolve));
  const secrets = secretFixture(async () => {
    enterRead();
    await blocked;
    return { version: 1, data: { username: "owner@example.test", password: canary } };
  });
  const context = await runtime(t, secrets.store);
  const refId = randomUUID();
  const { task, result } = await startLogin(context.server, context.db, refId);
  const opening = await nextOperation(context.node, context.epoch);
  await receipt(context.node, context.epoch, opening.id, {
    id: context.browserSessionId,
    url: adapter.origin,
    title: "Portal Test",
    status: "active",
    control: "agent",
    updatedAt: new Date().toISOString(),
  });
  const operation = await nextOperation(context.node, context.epoch);
  const grantId = (operation.args.body as { grantId: string }).grantId;
  const request = () =>
    context.server.app.request(
      `/executor/${context.registration.executorId}/credential-grants/${grantId}/consume`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${nodeToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          epoch: context.epoch,
          operationId: operation.id,
          sessionId: context.browserSessionId,
          desktopSessionId: context.desktopSessionId,
          sessionGeneration: context.sessionGeneration,
          origin: adapter.origin,
        }),
      },
    );

  const first = request();
  await entered;
  const duplicate = await request();
  assert.notEqual(duplicate.status, 200);
  assert.equal(secrets.reads(), 1, "only the atomic claim can begin a vault read");

  await context.server.agent.runtimePause.set(owner, { paused: true, expectedRevision: 0 });
  await context.db.put(owner, "tasks", {
    ...task,
    state: { ...task.state, desiredRevision: 1 },
    updatedAt: new Date().toISOString(),
  });
  releaseRead();
  const rejected = await first;
  assert.equal(rejected.status, 409, await rejected.clone().text());
  const rejection = await rejected.text();
  assert.equal(rejection.includes(canary), false);

  await receipt(
    context.node,
    context.epoch,
    operation.id,
    { cleanupConfirmed: true, code: "CREDENTIAL_CONSUME_REJECTED" },
    "rejected_not_dispatched",
  );
  await result;
  assert.equal(secrets.reads(), 1);
  const durable = JSON.stringify([
    await context.db.list(owner, "task-operations"),
    await context.server.executors.deliveries(owner, context.registration.executorId),
  ]);
  assert.equal(durable.includes(canary), false);
});
