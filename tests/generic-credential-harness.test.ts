import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { EventType, type RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import type { SecretStore } from "../apps/server/src/credentials/contracts.ts";
import { GenericCredentials } from "../apps/server/src/credentials/generic.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";
import type { CredentialInteractionRequest } from "../packages/domain/src/runtime.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const specification = {
  serviceName: "Atlas Observatory",
  origin: "https://api.atlas-observatory.example",
  purpose: "Read the requested observation from your account",
  fields: [{ id: "access", label: "Access key", type: "password" as const, required: true }],
  authentication: { type: "bearer" as const, fieldId: "access" },
};

function vault() {
  const values = new Map<string, { version: number; data: Record<string, string> }>();
  const store: SecretStore = {
    async write(owner, id, data, expected) {
      assert.equal(values.get(`${owner}:${id}`)?.version ?? 0, expected);
      values.set(`${owner}:${id}`, { version: expected + 1, data });
      return expected + 1;
    },
    async read(owner, id) {
      return values.get(`${owner}:${id}`) ?? null;
    },
    async delete(owner, id) {
      values.delete(`${owner}:${id}`);
    },
  };
  return store;
}

test("an unseen service opens a private modal in chat and resumes the original task through its API", async (t) => {
  const canary = "atlas-private-credential-627adf";
  let credentialId = "";
  const { requests } = await modelFixture(t, (index) => {
    if (index === 0) return { name: "request_credentials", arguments: specification };
    if (index === 1)
      return {
        name: "credential_http_request",
        arguments: { credentialId, path: "/observations/latest" },
      };
    if (index === 2)
      return {
        name: "finish_task",
        arguments: { summary: "A observação atual da sua conta é Aurora boreal às 22h." },
      };
    return undefined;
  });
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  let dispatches = 0;
  const credentials = new GenericCredentials(server.db, vault(), {
    available: true,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async (target, input) => {
      dispatches++;
      assert.equal(target.url.href, `${specification.origin}/observations/latest`);
      assert.equal(input.headers.Authorization, `Bearer ${canary}`);
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ observation: "Aurora boreal às 22h", echo: canary }),
      };
    },
  });
  server.agent.configureGenericCredentials(credentials);
  const threadId = randomUUID();
  await server.db.put("owner", "threads", { id: threadId });
  const original = "Leia a observação atual da minha conta Atlas Observatory";
  const input: RunAgentInput = {
    threadId,
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: "user", content: original }],
    tools: [],
    context: [],
    state: {},
  };
  const conversation = new ConversationAgent(server.agent.config, server.agent, "owner");
  const events = await lastValueFrom(conversation.run(input).pipe(toArray()));
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  assert.equal(
    requests.length,
    1,
    "opening the modal stops the model instead of asking another question",
  );
  const tasks = await server.db.list<AgentTask>("owner", "tasks");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].prompt, original);
  assert.equal(tasks[0].status, "waiting_input");
  const cards = await server.db.list<CredentialInteractionRequest>("owner", "interaction-requests");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, "credential");
  assert.equal(cards[0].schema.credentialKind, "api");
  assert.equal(cards[0].threadId, threadId);
  const saved = await credentials.submit("owner", cards[0].id, {
    clientResponseId: "private-save-627adf",
    values: { access: canary },
  });
  assert.ok(saved.credentialRef);
  credentialId = saved.credentialRef.id;
  assert.equal((await server.agent.getTask("owner", tasks[0].id)).status, "queued");
  await server.agent.worker.tick();
  const finished = await server.agent.getTask("owner", tasks[0].id);
  assert.equal(
    finished.status,
    "succeeded",
    JSON.stringify({ error: finished.error, completion: finished.completion }),
  );
  assert.equal(dispatches, 1);
  assert.match(finished.result ?? "", /Aurora boreal/);
  assert.equal((await server.db.list("owner", "tasks")).length, 1);
  assert.equal((await server.db.list("owner", "interaction-requests")).length, 1);
  const recorded = await Promise.all(
    [
      "tasks",
      "task-operations",
      "task-checkpoints",
      "interaction-requests",
      "service-credentials",
      "service-credential-requests",
      "mutation-receipts",
    ].map((kind) => server.db.list("owner", kind)),
  );
  assert.equal(JSON.stringify({ requests, recorded, events }).includes(canary), false);
});

test("a background task pauses for missing credentials and a rejected key reopens the secure form without questionnaires", async (t) => {
  let credentialId = "";
  const { requests } = await modelFixture(t, (index) => {
    if (index === 0) return { name: "request_credentials", arguments: specification };
    if (index === 1 || index === 2)
      return {
        name: "credential_http_request",
        arguments: { credentialId, path: "/observations/latest" },
      };
    if (index === 3)
      return {
        name: "finish_task",
        arguments: { summary: "A observação atual confirmada é Aurora boreal." },
      };
    return undefined;
  });
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  let dispatches = 0;
  const credentials = new GenericCredentials(server.db, vault(), {
    available: true,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async () => ({
      status: ++dispatches === 1 ? 401 : 200,
      contentType: "application/json",
      body: JSON.stringify({ observation: "Aurora boreal" }),
    }),
  });
  server.agent.configureGenericCredentials(credentials);
  const task = await server.agent.createTask("owner", {
    prompt: "Leia a observação atual da minha conta Atlas Observatory",
  });
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask("owner", task.id)).status, "waiting_input");
  const first = (
    await server.db.list<CredentialInteractionRequest>("owner", "interaction-requests")
  )[0];
  assert.equal(first.kind, "credential");
  const saved = await credentials.submit("owner", first.id, {
    clientResponseId: "rejected-save-884fcf",
    values: { access: "rejected-private-884fcf" },
  });
  assert.ok(saved.credentialRef);
  credentialId = saved.credentialRef.id;
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask("owner", task.id)).status, "waiting_input");
  const cards = await server.db.list<CredentialInteractionRequest>("owner", "interaction-requests");
  assert.equal(cards.length, 2);
  assert.equal(
    cards.every((card) => card.kind === "credential"),
    true,
  );
  const retry = cards.find((card) => card.status === "waiting");
  assert.ok(retry);
  assert.equal(retry.taskId, task.id);
  const replaced = await credentials.submit("owner", retry.id, {
    clientResponseId: "corrected-save-884fcf",
    values: { access: "corrected-private-884fcf" },
  });
  assert.ok(replaced.credentialRef);
  credentialId = replaced.credentialRef.id;
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask("owner", task.id)).status, "succeeded");
  assert.equal(dispatches, 2);
  assert.equal(requests.length, 4);
  assert.equal(JSON.stringify(requests).includes("private-884fcf"), false);
});

test("a site with no configured adapter still exposes a secure login modal to the task agent", async (t) => {
  const site = {
    serviceName: "New Observatory Portal",
    origin: "https://portal.atlas-observatory.example",
    loginUrl: "https://portal.atlas-observatory.example/login",
    fields: [
      { id: "username", label: "Email", type: "text", required: true },
      { id: "password", label: "Password", type: "password", required: true },
    ],
    selectors: { username: "input[name=email]", password: "input[name=password]" },
    submitSelector: "button[type=submit]",
    authenticatedSelector: "[data-account-menu]",
  };
  const { requests } = await modelFixture(t, (index) =>
    index === 0
      ? {
          name: "request_site_connection",
          arguments: { site, purpose: "Read your saved observation" },
        }
      : undefined,
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  assert.equal(server.agent.credentials?.catalog().length, 0);
  const task = await server.agent.createTask("owner", {
    prompt: "Leia a observação salva no meu portal Atlas Observatory",
  });
  await server.agent.worker.tick();
  const waiting = await server.agent.getTask("owner", task.id);
  assert.equal(waiting.status, "waiting_input");
  const cards = await server.db.list<CredentialInteractionRequest>("owner", "interaction-requests");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, "credential");
  assert.equal(cards[0].schema.origin, site.origin);
  assert.equal(requests.length, 1);
  assert.match(requests[0].body, /request_site_connection/);
  assert.match(requests[0].body, /authenticate_connection/);
});

test("authenticated financial writes retain native review and inject credentials only after approval", async (t) => {
  let credentialId = "";
  await modelFixture(t, (index) =>
    index === 0
      ? {
          name: "credential_http_request",
          arguments: {
            credentialId,
            path: "/payments",
            method: "POST",
            intent: "money",
            summary: "Pay the requested invoice",
            body: { invoice: "test-invoice" },
          },
        }
      : undefined,
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  let dispatches = 0;
  const credentials = new GenericCredentials(server.db, vault(), {
    available: true,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async (_target, input) => {
      dispatches++;
      assert.equal(input.headers.Authorization, "Bearer payment-private-453a");
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ receipt: "paid-test-invoice" }),
      };
    },
  });
  server.agent.configureGenericCredentials(credentials);
  const seed = await server.agent.taskRecord(
    "owner",
    { prompt: "Pay my Atlas invoice", kind: "agent" },
    randomUUID(),
  );
  seed.status = "waiting_input";
  const card = await credentials.request("owner", specification, { taskSeed: seed });
  const saved = await credentials.submit("owner", card.id, {
    clientResponseId: "payment-save-453a",
    values: { access: "payment-private-453a" },
  });
  assert.ok(saved.credentialRef);
  credentialId = saved.credentialRef.id;
  await server.agent.worker.tick();
  const waiting = await server.agent.getTask("owner", seed.id);
  assert.equal(waiting.status, "waiting_approval");
  assert.equal(dispatches, 0);
  assert.ok(waiting.actionId);
  const action = await server.db.get<ActionProposal>("owner", "actions", waiting.actionId);
  assert.ok(action);
  const approved = await server.actions.decide("owner", action.id, action.hash, "approve");
  assert.equal(approved.status, "succeeded", approved.error);
  assert.equal(dispatches, 1);
  assert.equal(JSON.stringify(approved).includes("payment-private-453a"), false);
});

test("a documented read-only POST query uses the saved credential without an unrelated approval form", async (t) => {
  let credentialId = "";
  await modelFixture(t, (index) =>
    index === 0
      ? {
          name: "credential_http_request",
          arguments: {
            credentialId,
            path: "/search",
            method: "POST",
            intent: "read",
            body: { query: "aurora" },
          },
        }
      : index === 1
        ? { name: "finish_task", arguments: { summary: "O resultado confirmado é Aurora boreal." } }
        : undefined,
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  let dispatches = 0;
  const credentials = new GenericCredentials(server.db, vault(), {
    available: true,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async (_target, input) => {
      dispatches++;
      assert.equal(input.method, "POST");
      assert.equal(input.body, JSON.stringify({ query: "aurora" }));
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ results: ["Aurora boreal"] }),
      };
    },
  });
  server.agent.configureGenericCredentials(credentials);
  const seed = await server.agent.taskRecord(
    "owner",
    { prompt: "Consulte aurora na API Atlas Observatory", kind: "agent" },
    randomUUID(),
  );
  seed.status = "waiting_input";
  const card = await credentials.request("owner", specification, { taskSeed: seed });
  const saved = await credentials.submit("owner", card.id, {
    clientResponseId: "query-save-83ff",
    values: { access: "query-private-83ff" },
  });
  assert.ok(saved.credentialRef);
  credentialId = saved.credentialRef.id;
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask("owner", seed.id)).status, "succeeded");
  assert.equal(dispatches, 1);
  assert.equal((await server.db.list("owner", "actions")).length, 0);
});

for (const manualApproval of [false, true]) {
  test(`an authenticated write rejected with 401 opens a fresh secure form after ${manualApproval ? "native review" : "automatic policy execution"}`, async (t) => {
    let credentialId = "";
    await modelFixture(t, (index) =>
      index === 0
        ? {
            name: "credential_http_request",
            arguments: {
              credentialId,
              path: "/notes",
              method: "POST",
              intent: "write",
              summary: "Save the requested note",
              body: { text: "Observation note" },
            },
          }
        : undefined,
    );
    const server = await taskRuntime(t, {
      mode: manualApproval ? "sample" : "live",
      agentBackend: "model",
      model: "openai/fixture",
    });
    let dispatches = 0;
    const credentials = new GenericCredentials(server.db, vault(), {
      available: true,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async () => {
        dispatches++;
        return {
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "wrong key" }),
        };
      },
    });
    server.agent.configureGenericCredentials(credentials);
    const seed = await server.agent.taskRecord(
      "owner",
      { prompt: "Create a note in my Atlas Observatory account", kind: "agent" },
      randomUUID(),
    );
    seed.status = "waiting_input";
    const card = await credentials.request("owner", specification, { taskSeed: seed });
    const saved = await credentials.submit("owner", card.id, {
      clientResponseId: `note-save-83ff-${manualApproval}`,
      values: { access: "note-private-83ff" },
    });
    assert.ok(saved.credentialRef);
    credentialId = saved.credentialRef.id;
    await server.agent.worker.tick();
    if (manualApproval) {
      const waiting = await server.agent.getTask("owner", seed.id);
      assert.equal(waiting.status, "waiting_approval");
      assert.ok(waiting.actionId);
      const action = await server.db.get<ActionProposal>("owner", "actions", waiting.actionId);
      assert.ok(action);
      const failed = await server.actions.decide("owner", action.id, action.hash, "approve");
      assert.equal(failed.status, "failed");
      await server.agent.worker.tick();
    }
    const waiting = await server.agent.getTask("owner", seed.id);
    assert.equal(waiting.status, "waiting_input", waiting.error ?? undefined);
    assert.equal(waiting.actionId ?? null, null);
    const interactions = await server.db.list<CredentialInteractionRequest>(
      "owner",
      "interaction-requests",
    );
    assert.equal(interactions.length, 2);
    assert.equal(
      interactions.every((interaction) => interaction.kind === "credential"),
      true,
    );
    assert.equal(interactions.filter((interaction) => interaction.status === "waiting").length, 1);
    assert.equal(dispatches, 1);
    assert.equal(
      (await server.db.list<ActionProposal>("owner", "actions")).some(
        (action) => action.status === "succeeded",
      ),
      false,
    );
    assert.notEqual(waiting.completion?.status, "verified");
  });
}

for (const manualWrite of [false, true]) {
  test(`a credential missing from the vault opens its modal automatically for ${manualWrite ? "an approved write" : "a read"}`, async (t) => {
    let credentialId = "";
    await modelFixture(t, (index) =>
      index === 0
        ? {
            name: "credential_http_request",
            arguments: {
              credentialId,
              path: manualWrite ? "/notes" : "/observations",
              ...(manualWrite
                ? {
                    method: "POST",
                    intent: "write",
                    summary: "Save observation note",
                    body: { text: "Aurora" },
                  }
                : {}),
            },
          }
        : undefined,
    );
    const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
    const privateStore = vault();
    let dispatches = 0;
    const credentials = new GenericCredentials(server.db, privateStore, {
      available: true,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async () => {
        dispatches++;
        return {
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ observation: "Aurora" }),
        };
      },
    });
    server.agent.configureGenericCredentials(credentials);
    const seed = await server.agent.taskRecord(
      "owner",
      {
        prompt: manualWrite ? "Create a note in Atlas" : "Read my observation from Atlas",
        kind: "agent",
      },
      randomUUID(),
    );
    seed.status = "waiting_input";
    const card = await credentials.request("owner", specification, { taskSeed: seed });
    const saved = await credentials.submit("owner", card.id, {
      clientResponseId: `missing-save-84ff-${manualWrite}`,
      values: { access: "missing-private-84ff" },
    });
    assert.ok(saved.credentialRef);
    credentialId = saved.credentialRef.id;
    if (!manualWrite) await privateStore.delete("owner", credentialId);
    await server.agent.worker.tick();
    if (manualWrite) {
      const waiting = await server.agent.getTask("owner", seed.id);
      assert.equal(waiting.status, "waiting_approval");
      assert.ok(waiting.actionId);
      const action = await server.db.get<ActionProposal>("owner", "actions", waiting.actionId);
      assert.ok(action);
      await privateStore.delete("owner", credentialId);
      const failed = await server.actions.decide("owner", action.id, action.hash, "approve");
      assert.equal(failed.status, "failed");
      await server.agent.worker.tick();
    }
    const waiting = await server.agent.getTask("owner", seed.id);
    assert.equal(waiting.status, "waiting_input", waiting.error ?? undefined);
    assert.equal(dispatches, 0);
    const requests = await server.db.list<CredentialInteractionRequest>(
      "owner",
      "interaction-requests",
    );
    assert.equal(requests.length, 2);
    assert.equal(
      requests.every((request) => request.kind === "credential"),
      true,
    );
    assert.equal(requests.filter((request) => request.status === "waiting").length, 1);
    assert.notEqual(waiting.completion?.status, "verified");
  });
}

test("another task reuses a saved dynamic site connection without opening another credential modal", async (t) => {
  const site = {
    serviceName: "Atlas Portal",
    origin: "https://portal.atlas-observatory.example",
    fields: [
      { id: "username", label: "Email", type: "text", required: true },
      { id: "password", label: "Password", type: "password", required: true },
    ],
    selectors: { username: "input[name=email]", password: "input[name=password]" },
    submitSelector: "button[type=submit]",
    authenticatedSelector: "[data-account-menu]",
  };
  const { requests } = await modelFixture(t, (index) => {
    if (index === 0 || index === 3)
      return {
        name: "request_site_connection",
        arguments: { site, purpose: "Use my portal connection" },
      };
    if (index === 2) return { name: "list_site_connections", arguments: {} };
    if (index === 1 || index === 4)
      return {
        name: "finish_task",
        arguments: { summary: "Seja bem-vindo ao seu observatório! É um prazer receber você." },
      };
    return undefined;
  });
  const server = await taskRuntime(
    t,
    { agentBackend: "model", model: "openai/fixture" },
    { credentialSecretStore: vault() },
  );
  const first = await server.agent.createTask("owner", {
    prompt: "Escreva uma breve saudação para minha conta do observatório",
  });
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask("owner", first.id)).status, "waiting_input");
  const card = (
    await server.db.list<CredentialInteractionRequest>("owner", "interaction-requests")
  )[0];
  const saved = await server.credentials.submit("owner", card.id, {
    clientResponseId: "site-save-626fa",
    values: { username: "owner@example.org", password: "site-private-626fa" },
  });
  assert.equal(saved.kind, "credential");
  if (saved.kind !== "credential") throw new Error("Expected the saved secure form");
  assert.ok(saved.credentialRef);
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask("owner", first.id)).status, "succeeded");
  const second = await server.agent.createTask("owner", {
    prompt: "Escreva outra breve saudação para minha conta do observatório",
  });
  await server.agent.worker.tick();
  const reused = await server.agent.getTask("owner", second.id);
  assert.equal(reused.status, "succeeded");
  assert.deepEqual(reused.state.credentialRef, saved.credentialRef);
  assert.equal((await server.db.list("owner", "interaction-requests")).length, 1);
  assert.equal(requests.length, 5);
  assert.equal(JSON.stringify(requests).includes("site-private-626fa"), false);
});

test("a rejected browser login reopens its secure modal on the original task", async (t) => {
  let credentialRefId = "";
  const site = {
    serviceName: "Atlas Portal",
    origin: "https://portal.atlas-observatory.example",
    fields: [{ id: "password", label: "Password", type: "password", required: true }],
    selectors: { password: "input[name=password]" },
    submitSelector: "button[type=submit]",
    authenticatedSelector: "[data-account-menu]",
  };
  await modelFixture(t, (index) =>
    index === 0
      ? { name: "request_site_connection", arguments: { site, purpose: "Read my observation" } }
      : index === 1
        ? { name: "authenticate_connection", arguments: { credentialRefId } }
        : undefined,
  );
  const server = await taskRuntime(
    t,
    { agentBackend: "model", model: "openai/fixture" },
    { credentialSecretStore: vault() },
  );
  assert.ok(server.agent.credentialLogin);
  server.agent.credentialLogin.authenticate = async (owner, taskId, id) => {
    const authorized = await server.credentials.authorizeForTask(owner, taskId, id);
    await server.credentials.setConnectionStatus(owner, id, "invalid_credentials");
    return {
      status: "invalid_credentials",
      credentialRef: authorized.connection.credentialRef,
      serviceName: site.serviceName,
      origin: site.origin,
    };
  };
  const task = await server.agent.createTask("owner", {
    prompt: "Leia a observação salva no meu Atlas Portal",
  });
  await server.agent.worker.tick();
  const card = (
    await server.db.list<CredentialInteractionRequest>("owner", "interaction-requests")
  )[0];
  const saved = await server.credentials.submit("owner", card.id, {
    clientResponseId: "browser-invalid-826",
    values: { password: "browser-private-826" },
  });
  assert.equal(saved.kind, "credential");
  if (saved.kind !== "credential") throw new Error("Expected the saved secure form");
  assert.ok(saved.credentialRef);
  credentialRefId = saved.credentialRef.id;
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask("owner", task.id)).status, "waiting_input");
  const cards = await server.db.list<CredentialInteractionRequest>("owner", "interaction-requests");
  assert.equal(cards.length, 2);
  assert.equal(
    cards.every((request) => request.kind === "credential" && request.taskId === task.id),
    true,
  );
  assert.equal(cards.filter((request) => request.status === "waiting").length, 1);
});

test("OTP after reusing a site credential belongs to the new task and its conversation", async (t) => {
  const owner = "local-user";
  let credentialRefId = "";
  const site = {
    serviceName: "Atlas Portal",
    origin: "https://portal.atlas-observatory.example",
    fields: [{ id: "password", label: "Password", type: "password", required: true }],
    selectors: { password: "input[name=password]" },
    submitSelector: "button[type=submit]",
    authenticatedSelector: "[data-account-menu]",
    challengeSubmitSelector: "button[data-verify]",
    challengeSelectors: { otp: "input[name=otp]" },
  };
  const { requests } = await modelFixture(t, (index) => {
    if (index === 0 || index === 2)
      return {
        name: "request_site_connection",
        arguments: { site, purpose: "Read my observation" },
      };
    if (index === 1) return { name: "list_site_connections", arguments: {} };
    if (index === 3) return { name: "authenticate_connection", arguments: { credentialRefId } };
    return undefined;
  });
  const server = await taskRuntime(
    t,
    { agentBackend: "model", model: "openai/fixture" },
    { credentialSecretStore: vault() },
  );
  const oldThread = randomUUID(),
    newThread = randomUUID(),
    sessionId = randomUUID();
  await server.db.put(owner, "threads", { id: oldThread });
  await server.db.put(owner, "threads", { id: newThread });
  server.agent.browser.credentialTarget = async () => undefined;
  server.agent.browser.isNativeSession = async () => false;
  server.agent.browser.runAutomated = async (
    _owner,
    _task,
    _session,
    _url,
    _signal,
    _effect,
    operation,
  ) => operation(sessionId);
  server.agent.browser.credentials = async (_owner, _session, input) => {
    assert.ok("fields" in input);
    assert.equal(input.fields[0].value, "otp-password-canary-954");
    return {
      status: "challenge",
      origin: site.origin,
      sessionId,
      executorId: "fixture",
      profileId: "personal",
      sessionGeneration: "generation-one",
      challengeKind: "otp",
      challengeId: randomUUID(),
    };
  };
  const first = await server.agent.createTask(owner, {
    prompt: "Read my Atlas observation",
    originThreadId: oldThread,
  });
  await server.agent.worker.tick();
  const originalCard = (
    await server.db.list<CredentialInteractionRequest>(owner, "interaction-requests")
  )[0];
  const saved = await server.credentials.submit(owner, originalCard.id, {
    clientResponseId: "otp-first-save-954",
    values: { password: "otp-password-canary-954" },
  });
  assert.equal(saved.kind, "credential");
  if (saved.kind !== "credential") throw new Error("Expected saved credential");
  assert.ok(saved.credentialRef);
  credentialRefId = saved.credentialRef.id;
  await server.db.compareAndSwap(
    owner,
    "tasks",
    first.id,
    { status: "queued" },
    { status: "succeeded" },
  );
  const second = await server.agent.createTask(owner, {
    prompt: "Read my new Atlas observation",
    originThreadId: newThread,
  });
  await server.agent.worker.tick();
  const waiting = await server.agent.getTask(owner, second.id);
  assert.equal(waiting.status, "waiting_input");
  assert.ok(waiting.state.credentialChallengeId);
  const original = await server.credentials.status(owner, originalCard.id);
  assert.equal(
    original.status,
    "saved",
    "the old conversation must not receive the new login challenge",
  );
  const cards = await server.db.list<CredentialInteractionRequest>(owner, "interaction-requests");
  assert.equal(cards.length, 2);
  assert.equal(
    cards.every((card) => card.kind === "credential"),
    true,
  );
  const active = cards.find((card) => card.status === "needs_challenge");
  assert.ok(active);
  assert.equal(active.taskId, second.id);
  assert.equal(active.threadId, newThread);
  assert.equal(waiting.state.interactionRequestId, active.id);
  const { token } = await server.auth.session();
  const pendingResponse = await server.app.request("/api/credential-prompts", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(pendingResponse.status, 200);
  const pending = await pendingResponse.json();
  assert.deepEqual(
    pending.requests.map((request: { id: string }) => request.id),
    [active.id],
  );
  assert.equal(
    JSON.stringify({ cards, requests, pending }).includes("otp-password-canary-954"),
    false,
  );
  assert.equal((await server.agent.getTask(owner, first.id)).status, "succeeded");
});
