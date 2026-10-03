import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { CredentialBroker } from "../apps/server/src/credentials/broker.ts";
import type { CredentialAdapter, SecretStore } from "../apps/server/src/credentials/contracts.ts";
import { OpenBaoSecretStore } from "../apps/server/src/credentials/openbao-store.ts";
import { createStore } from "../apps/server/src/db.ts";

const canary = "CREDENTIAL-CANARY-91f0a2";
const adapter: CredentialAdapter = {
  id: "portal-x",
  serviceName: "Portal X",
  origin: "https://portal.example.test",
  fields: [
    { id: "username", label: "Email", type: "text", required: true },
    { id: "password", label: "Password", type: "password", required: true },
  ],
  selectors: { username: "input[name=email]", password: "input[name=password]" },
  submitSelector: "button[type=submit]",
  authenticatedSelector: "[data-account-menu]",
  invalidCredentialsSelector: "[role=alert]",
};

function secretFixture() {
  const values = new Map<string, Record<string, string>>();
  let writes = 0;
  const store: SecretStore = {
    async write(owner, id, data, expectedVersion) {
      assert.equal(expectedVersion, 0);
      values.set(`${owner}:${id}`, { ...data });
      writes++;
      return 1;
    },
    async read(owner, id) {
      const data = values.get(`${owner}:${id}`);
      return data ? { version: 1, data: { ...data } } : null;
    },
    async delete() {},
  };
  return {
    store,
    values,
    get writes() {
      return writes;
    },
  };
}

test("credential forms store secrets privately and resume the matching task by reference once", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const secrets = secretFixture();
  const broker = new CredentialBroker(db, secrets.store, [adapter]);
  const taskId = randomUUID();
  const threadId = randomUUID();
  await db.put<Record<string, unknown> & { id: string }>("owner", "tasks", {
    id: taskId,
    title: "Read Portal X documents",
    status: "waiting_input",
    attempts: 3,
    originThreadId: threadId,
    plan: [],
    evidence: [],
    input: {},
    state: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    artifactIds: [],
  });

  const request = await broker.request("owner", {
    taskId,
    revision: 3,
    adapterId: adapter.id,
    purpose: "Read the latest account documents",
  });
  assert.equal(request.kind, "credential");
  assert.equal(request.status, "waiting");
  assert.equal(request.schema.origin, adapter.origin);
  const pausedTask = await db.get<Record<string, unknown>>("owner", "tasks", taskId);
  await db.put<Record<string, unknown> & { id: string }>("owner", "tasks", {
    ...pausedTask,
    id: taskId,
    state: { ...(pausedTask?.state as Record<string, unknown>), interactionRequestId: request.id },
  });

  const saved = await broker.submit("owner", request.id, {
    clientResponseId: "response-91f0a2",
    values: { username: "owner@example.test", password: canary },
  });
  assert.equal(saved.status, "saved");
  assert.equal(saved.credentialRef?.version, 1);
  assert.equal(secrets.writes, 1);

  const replay = await broker.submit("owner", request.id, {
    clientResponseId: "response-91f0a2",
    values: { username: "owner@example.test", password: canary },
  });
  assert.equal(replay.status, "saved");
  assert.equal(secrets.writes, 1, "a repeated response ID must not create another version");
  const task = await db.get<Record<string, unknown>>("owner", "tasks", taskId);
  assert.ok(task);
  assert.equal(task.status, "queued");
  assert.deepEqual((task.state as Record<string, unknown>).credentialRef, saved.credentialRef);

  const serialized = JSON.stringify({
    request: await db.get("owner", "interaction-requests", request.id),
    credentialRequest: await db.get("owner", "credential-requests", request.id),
    task,
    events: await db.conversationEvents("owner", threadId, 0),
    operations: await db.list("owner", "task-operations"),
  });
  assert.equal(
    serialized.includes(canary),
    false,
    "the secret must never enter durable chat or task data",
  );
  assert.equal(secrets.values.get(`owner:${saved.credentialRef?.id}`)?.password, canary);
});

test("credential requests reject stale revisions and are owner-scoped", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const broker = new CredentialBroker(db, secretFixture().store, [adapter]);
  const taskId = randomUUID();
  await db.put("owner", "tasks", {
    id: taskId,
    title: "Read account documents",
    status: "waiting_input",
    attempts: 4,
    plan: [],
    evidence: [],
    input: {},
    state: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    artifactIds: [],
  });
  await assert.rejects(
    broker.request("owner", {
      taskId,
      revision: 3,
      adapterId: adapter.id,
      purpose: "Read documents",
    }),
    /revision/i,
  );
  const current = await broker.request("owner", {
    taskId,
    revision: 4,
    adapterId: adapter.id,
    purpose: "Read documents",
  });
  await assert.rejects(
    broker.submit("other-owner", current.id, {
      clientResponseId: "other-response",
      values: { username: "owner@example.test", password: canary },
    }),
    /not found/i,
  );
});

test("OpenBao KV v2 adapter uses a hashed owner path and CAS without exposing secret data in errors", async () => {
  let outbound: { url: string; init?: RequestInit } | undefined;
  const store = new OpenBaoSecretStore({
    address: "http://openbao:8200",
    token: "fixture-service-token-not-root",
    mount: "secret",
    fetch: async (input, init) => {
      outbound = { url: String(input), init };
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const payload =
        init?.method === "GET"
          ? { data: { data: { password: canary }, metadata: { version: 1 } } }
          : { data: { version: 1 } };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const ref = randomUUID();
  assert.equal(await store.write("user@example.test", ref, { password: canary }, 0), 1);
  assert.match(
    outbound?.url ?? "",
    /^http:\/\/openbao:8200\/v1\/secret\/data\/openmuse\/[a-f0-9]{64}\//,
  );
  const requestBody = JSON.parse(String(outbound?.init?.body));
  assert.equal(requestBody.options.cas, 0);
  assert.equal(requestBody.data.password, canary);
  assert.equal(
    (outbound?.init?.headers as Record<string, string>)?.["X-Vault-Token"],
    "fixture-service-token-not-root",
  );
  await store.delete("user@example.test", ref, 1);
  assert.equal(outbound?.init?.method, "DELETE");
  assert.match(
    outbound?.url ?? "",
    /^http:\/\/openbao:8200\/v1\/secret\/metadata\/openmuse\/[a-f0-9]{64}\//,
  );
});

test("OpenBao never treats an empty write receipt as a confirmed credential save", async () => {
  const store = new OpenBaoSecretStore({
    address: "http://openbao:8200",
    token: "fixture-token",
    mount: "secret",
    fetch: async (_input, init) => {
      assert.equal(init?.redirect, "error");
      return new Response(null, { status: 204 });
    },
  });
  await assert.rejects(
    store.write("owner", randomUUID(), { password: canary }, 0),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "VAULT_UNAVAILABLE",
  );
});

test("authenticated credential routes save inline values without returning them or exposing a secret lookup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-credential-route-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const secrets = secretFixture();
  const server = await createApp(
    db,
    {
      mode: "sample",
      port: 8787,
      host: "127.0.0.1",
      publicUrl: "http://localhost:8787",
      dataDir: directory,
      agentBackend: "sample",
      googleRedirectUri: "http://localhost:8787/api/google/callback",
      allowedOrigins: [],
    },
    { credentialSecretStore: secrets.store, credentialAdapters: [adapter] },
  );
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const paired = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(paired.status, 200);
  const token = (await paired.json()).token as string;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const taskId = randomUUID();
  await db.put<Record<string, unknown> & { id: string }>("local-user", "tasks", {
    id: taskId,
    title: "Read Portal X documents",
    status: "waiting_input",
    attempts: 1,
    plan: [],
    evidence: [],
    input: {},
    state: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    artifactIds: [],
  });
  const request = await server.credentials.request("local-user", {
    taskId,
    revision: 1,
    adapterId: adapter.id,
    purpose: "Read the latest documents",
  });
  const task = await db.get<Record<string, unknown>>("local-user", "tasks", taskId);
  await db.put<Record<string, unknown> & { id: string }>("local-user", "tasks", {
    ...task,
    id: taskId,
    state: { ...(task?.state as Record<string, unknown>), interactionRequestId: request.id },
  });
  assert.equal((await server.app.request(`/api/credential-requests/${request.id}`)).status, 401);
  const card = await server.app.request(`/api/credential-requests/${request.id}`, { headers });
  assert.equal(card.status, 200);
  assert.equal((await card.json()).schema.origin, adapter.origin);
  const response = await server.app.request(`/api/credential-requests/${request.id}/submit`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      clientResponseId: `credential-${request.id}`,
      values: { username: "owner@example.test", password: canary },
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.text();
  assert.match(body, /"status":"saved"/);
  assert.equal(body.includes(canary), false);
  const savedTask = await db.get<Record<string, unknown>>("local-user", "tasks", taskId);
  assert.equal(savedTask?.status, "queued");
  assert.equal(
    JSON.stringify(await db.list("local-user", "task-operations")).includes(canary),
    false,
  );
});
