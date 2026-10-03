import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import { CredentialBroker } from "../apps/server/src/credentials/broker.ts";
import type { SecretStore } from "../apps/server/src/credentials/contracts.ts";
import { GenericCredentials } from "../apps/server/src/credentials/generic.ts";
import type { GenericCredentialInput } from "../apps/server/src/credentials/generic-contracts.ts";
import { credentialPromptRoutes } from "../apps/server/src/credentials/prompts.ts";
import { createStore } from "../apps/server/src/db.ts";
import { IntegrationService } from "../apps/server/src/integrations.ts";
import { InteractionRequests } from "../apps/server/src/interaction-requests.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";

const site = {
  serviceName: "Unregistered account portal",
  origin: "https://portal.example.com",
  fields: [
    { id: "username", label: "Email", type: "text", required: true },
    { id: "password", label: "Password", type: "password", required: true },
  ],
  selectors: { username: "input[name=email]", password: "input[name=password]" },
  submitSelector: "button[type=submit]",
};
const apiSpec: GenericCredentialInput = {
  serviceName: "Unregistered API",
  origin: "https://api.example.com",
  purpose: "Read the requested account record",
  fields: [{ id: "key", label: "API key", type: "password", required: true }],
  authentication: { type: "bearer", fieldId: "key" },
};
function vault(): SecretStore {
  const data = new Map<string, { version: number; data: Record<string, string> }>();
  return {
    async read(owner, id) {
      return data.get(`${owner}:${id}`) ?? null;
    },
    async write(owner, id, value, version) {
      data.set(`${owner}:${id}`, { version: version + 1, data: value });
      return version + 1;
    },
    async delete(owner, id) {
      data.delete(`${owner}:${id}`);
    },
  };
}
function task(threadId: string): AgentTask {
  return {
    id: randomUUID(),
    title: "Read account",
    kind: "agent",
    status: "waiting_input",
    attempts: 1,
    prompt: "Read account",
    originThreadId: threadId,
    state: {},
    input: {},
    plan: [],
    evidence: [],
    artifactIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as AgentTask;
}

test("the global queue returns only current owner forms and never creates an additional questionnaire", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const secrets = vault();
  const browser = new CredentialBroker(db, secrets, []);
  const api = new GenericCredentials(db, secrets, {
    available: true,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  const legacy = new IntegrationService(db, secrets, { available: true });
  const app = new Hono<{ Variables: { owner: string } }>();
  app.use("*", async (c, next) => {
    c.set("owner", c.req.header("x-owner") ?? "owner");
    await next();
  });
  app.route("/api", credentialPromptRoutes(db, browser, api, legacy));
  const threadId = randomUUID();
  await db.put("owner", "threads", { id: threadId });
  const current = task(threadId);
  await db.put("owner", "tasks", current);
  const request = await api.request("owner", apiSpec, { taskId: current.id, revision: 1 });
  await db.compareAndSwap(
    "owner",
    "tasks",
    current.id,
    {},
    { state: { interactionRequestId: request.id } },
  );
  const bound = await db.get<AgentTask>("owner", "tasks", current.id);
  assert.ok(bound);
  assert.equal((await new InteractionRequests(db).forTask("owner", bound)).id, request.id);
  assert.equal((await db.list("owner", "interaction-requests")).length, 1);
  const pending = await (await app.request("/api/credential-prompts")).json();
  assert.equal(pending.requests.length, 1);
  assert.equal(pending.requests[0].id, request.id);
  assert.deepEqual(
    await (
      await app.request("/api/credential-prompts", { headers: { "x-owner": "other" } })
    ).json(),
    { requests: [] },
  );
  await api.cancel("owner", request.id);
  assert.deepEqual(await (await app.request("/api/credential-prompts")).json(), { requests: [] });
  assert.equal((await db.get<AgentTask>("owner", "tasks", current.id))?.status, "cancelled");
  await db.compareAndSwap("owner", "tasks", current.id, {}, { status: "cancelled" });
  assert.equal((await db.deleteThread("owner", threadId, randomUUID())).status, "deleted");
  assert.deepEqual(await db.list("owner", "service-credential-requests"), []);
});

test("runtime site forms persist without server configuration and cancel both initial login and later OTP", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const secrets = vault();
  const broker = new CredentialBroker(db, secrets, []);
  await assert.rejects(
    broker.registerAdapter("owner", { ...site, selectors: { username: "input[name=email]" } }),
  );
  await assert.rejects(
    broker.registerAdapter("owner", { ...site, loginUrl: "https://other.example.com/login" }),
  );
  const adapter = await broker.registerAdapter("owner", site);
  assert.equal(broker.catalog().length, 0);
  const restarted = new CredentialBroker(db, secrets, []);
  assert.deepEqual(await restarted.resolveAdapter("owner", adapter.id), adapter);
  await assert.rejects(restarted.resolveAdapter("other", adapter.id), /not found/);
  assert.match(adapter.selectors.password, /input\[type="password"\]/);
  await assert.rejects(
    broker.registerAdapter("owner", {
      ...site,
      selectors: { ...site.selectors, password: ") , textarea, :is(" },
    }),
    /simple CSS/,
  );
  const threadId = randomUUID();
  await db.put("owner", "threads", { id: threadId });
  const current = task(threadId);
  await db.put("owner", "tasks", current);
  const request = await broker.request("owner", {
    taskId: current.id,
    revision: 1,
    adapterId: adapter.id,
    purpose: "Read account",
  });
  await db.compareAndSwap(
    "owner",
    "tasks",
    current.id,
    {},
    { state: { interactionRequestId: request.id } },
  );
  const saved = await broker.submit("owner", request.id, {
    clientResponseId: "private-response",
    values: { username: "example@example.com", password: "synthetic-key" },
  });
  assert.equal(saved.kind, "credential");
  if (saved.kind !== "credential") throw new Error("Expected credential form");
  assert.ok(saved.credentialRef);
  const challengeId = randomUUID();
  await db.put("owner", "credential-challenges", {
    id: challengeId,
    taskId: current.id,
    status: "waiting",
  });
  await broker.setConnectionStatus("owner", saved.credentialRef.id, "needs_challenge", {
    challengeId,
    challengeKind: "otp",
  });
  await db.compareAndSwap(
    "owner",
    "tasks",
    current.id,
    {},
    {
      status: "waiting_input",
      attempts: 2,
      state: {
        interactionRequestId: request.id,
        credentialChallengeId: challengeId,
        credentialRef: saved.credentialRef,
      },
    },
  );
  const bound = await db.get<AgentTask>("owner", "tasks", current.id);
  assert.ok(bound);
  assert.equal((await new InteractionRequests(db).forTask("owner", bound)).id, request.id);
  let revoked = false;
  broker.configureGrantInvalidator(() => {
    revoked = true;
  });
  assert.equal((await broker.cancel("owner", request.id)).status, "cancelled");
  assert.equal(revoked, true);
  assert.equal((await db.get("owner", "credential-challenges", challengeId))?.status, "superseded");
  assert.equal((await db.get("owner", "tasks", current.id))?.status, "cancelled");
  assert.equal((await broker.cancel("owner", request.id)).status, "cancelled");
});
