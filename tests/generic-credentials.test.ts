import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { SecretStore } from "../apps/server/src/credentials/contracts.ts";
import {
  GenericCredentials,
  genericCredentialRoutes,
} from "../apps/server/src/credentials/generic.ts";
import {
  type GenericCredentialInput,
  genericCredentialRequestSchema,
} from "../apps/server/src/credentials/generic-contracts.ts";
import type { CredentialTransportInput } from "../apps/server/src/credentials/generic-transport.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";

const owner = "generic-owner";
const canary = "generic-CREDENTIAL-canary+/91";
const specification: GenericCredentialInput = {
  serviceName: "Unseen Observatory",
  origin: "https://observatory.example.test",
  purpose: "Read the sky survey requested in this conversation",
  fields: [{ id: "accessKey", label: "Access key", type: "password", required: true }],
  authentication: { type: "bearer", fieldId: "accessKey" },
};
const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
function secretFixture() {
  const values = new Map<string, { version: number; data: Record<string, string> }>();
  let writes = 0;
  const vault: SecretStore = {
    async read(account, id) {
      return values.get(`${account}:${id}`) ?? null;
    },
    async write(account, id, data, expected) {
      assert.equal(values.get(`${account}:${id}`)?.version ?? 0, expected);
      const version = expected + 1;
      values.set(`${account}:${id}`, { version, data });
      writes++;
      return version;
    },
    async delete(account, id) {
      values.delete(`${account}:${id}`);
    },
  };
  return {
    vault,
    values,
    get writes() {
      return writes;
    },
  };
}
async function seed(db: Store): Promise<AgentTask> {
  const threadId = randomUUID();
  await db.put(owner, "threads", { id: threadId });
  return {
    id: randomUUID(),
    title: "Read the observatory",
    prompt: "Read my latest sky survey",
    kind: "agent",
    status: "waiting_input",
    originThreadId: threadId,
    attempts: 0,
    plan: [],
    evidence: [],
    artifactIds: [],
    input: {},
    state: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
async function running(db: Store, taskId: string) {
  await db.compareAndSwap(owner, "tasks", taskId, { status: "queued" }, { status: "running" });
}

test("an unseen service opens a durable generic form, stores only in the vault, and resumes its original task once", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const secrets = secretFixture();
  const service = new GenericCredentials(db, secrets.vault, { available: true, resolve });
  const task = await seed(db);
  const request = await service.request(owner, specification, { taskSeed: task });
  assert.equal(request.schema.credentialKind, "api");
  assert.equal(request.taskId, task.id);
  assert.equal(
    (await db.get<AgentTask>(owner, "tasks", task.id))?.state.interactionRequestId,
    request.id,
  );
  assert.equal(
    (
      await service.request(
        owner,
        { ...specification, purpose: "A paraphrased same purpose" },
        { taskId: task.id, revision: 0 },
      )
    ).id,
    request.id,
  );
  assert.equal((await service.pending(owner)).length, 1);
  const saved = await service.submit(owner, request.id, {
    clientResponseId: "secure-response-123",
    values: { accessKey: canary },
  });
  assert.equal(saved.status, "saved");
  assert.equal(secrets.writes, 1);
  assert.equal((await db.get<AgentTask>(owner, "tasks", task.id))?.status, "queued");
  assert.deepEqual(
    (await db.get<AgentTask>(owner, "tasks", task.id))?.state.serviceCredentialRef,
    saved.credentialRef,
  );
  await service.submit(owner, request.id, {
    clientResponseId: "secure-response-123",
    values: { accessKey: canary },
  });
  assert.equal(secrets.writes, 1);
  assert.equal((await service.findReusable(owner, specification))?.id, saved.credentialRef?.id);
  assert.equal(
    await service.findReusable(owner, {
      ...specification,
      authentication: { type: "header", fieldId: "accessKey", headerName: "X-Service-Key" },
    }),
    undefined,
  );
  assert.equal((await service.pending(owner)).length, 0);
  const records = await Promise.all(
    [
      "service-credential-requests",
      "service-credentials",
      "interaction-requests",
      "tasks",
      "mutation-receipts",
    ].map((kind) => db.list(owner, kind)),
  );
  assert.equal(
    JSON.stringify({
      records,
      events: await db.conversationEvents(owner, task.originThreadId!, 0),
      saved,
    }).includes(canary),
    false,
  );
  await assert.rejects(service.status("another-owner", request.id), /not found/i);
  await assert.rejects(service.metadata("another-owner", saved.credentialRef!.id), /not found/i);
});

test("authenticated requests pin the public address, enforce the approved origin, and redact echoed credential encodings", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const secrets = secretFixture();
  let calls = 0,
    fenced = false;
  const service = new GenericCredentials(db, secrets.vault, {
    available: true,
    resolve,
    request: async (target, input) => {
      calls++;
      assert.equal(fenced, true);
      assert.equal(target.address, "93.184.216.34");
      assert.equal(target.url.origin, specification.origin);
      assert.equal(input.headers.Authorization, `Bearer ${canary}`);
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          result: "survey ready",
          echo: canary,
          encoded: encodeURIComponent(canary),
          base64: Buffer.from(canary).toString("base64"),
        }),
      };
    },
  });
  const task = await seed(db),
    request = await service.request(owner, specification, { taskSeed: task });
  const saved = await service.submit(owner, request.id, {
    clientResponseId: "secure-response-123",
    values: { accessKey: canary },
  });
  await running(db, task.id);
  const result = await service.httpRequest(
    owner,
    { credentialId: saved.credentialRef!.id, path: "/survey?date=today" },
    {
      taskId: task.id,
      beforeDispatch: async () => {
        fenced = true;
      },
    },
  );
  assert.equal(result.status, 200);
  assert.match(result.body, /survey ready/);
  assert.match(result.body, /\[redacted\]/);
  assert.equal(JSON.stringify(result).includes(canary), false);
  await assert.rejects(
    service.httpRequest(
      owner,
      { credentialId: saved.credentialRef!.id, path: "https://evil.example.test/steal" },
      { taskId: task.id },
    ),
    /destination/,
  );
  await assert.rejects(
    service.httpRequest(
      owner,
      {
        credentialId: saved.credentialRef!.id,
        path: "/survey",
        headers: { Authorization: "model-supplied" },
      },
      { taskId: task.id },
    ),
    /vault/,
  );
  await assert.rejects(
    service.httpRequest(
      owner,
      { credentialId: saved.credentialRef!.id, path: "/survey" },
      { taskId: randomUUID() },
    ),
    /not authorized/,
  );
  assert.equal(calls, 1);
});

test("multiple custom headers, query keys, JSON body secrets and basic passwords use the same service-independent injection", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const secrets = secretFixture();
  const captured: { url: string; input: CredentialTransportInput }[] = [];
  const service = new GenericCredentials(db, secrets.vault, {
    available: true,
    resolve,
    request: async (target, input) => {
      captured.push({ url: target.url.href, input });
      return { status: 200, contentType: "application/json", body: "{}" };
    },
  });
  const bindings: GenericCredentialInput = {
    ...specification,
    fields: [
      { id: "client", label: "Client key", type: "password", required: true },
      { id: "secret", label: "Client secret", type: "password", required: true },
    ],
    authentication: {
      type: "bindings",
      bindings: [
        { type: "header", fieldId: "client", headerName: "X-Client-Key" },
        { type: "header", fieldId: "secret", headerName: "X-Client-Secret" },
      ],
    },
  };
  const cases: {
    spec: GenericCredentialInput;
    values: Record<string, string>;
    method?: "GET" | "POST";
    body?: unknown;
  }[] = [
    { spec: bindings, values: { client: "client-canary", secret: canary } },
    {
      spec: {
        ...specification,
        authentication: { type: "query", fieldId: "accessKey", parameterName: "api_key" },
      },
      values: { accessKey: canary },
    },
    {
      spec: {
        ...specification,
        authentication: { type: "json_body", fieldId: "accessKey", propertyName: "api_key" },
      },
      values: { accessKey: canary },
      method: "POST",
      body: { query: "stars" },
    },
    {
      spec: {
        ...specification,
        fields: [
          { id: "user", label: "Username", type: "text", required: true },
          { id: "pass", label: "Password", type: "password", required: true },
        ],
        authentication: { type: "basic", usernameFieldId: "user", passwordFieldId: "pass" },
      },
      values: { user: "account-canary", pass: canary },
    },
  ];
  for (const scenario of cases) {
    const task = await seed(db),
      request = await service.request(owner, scenario.spec, { taskSeed: task });
    const saved = await service.submit(owner, request.id, {
      clientResponseId: `case-${task.id}`,
      values: scenario.values,
    });
    await running(db, task.id);
    const result = await service.httpRequest(
      owner,
      {
        credentialId: saved.credentialRef!.id,
        path: "/search",
        method: scenario.method,
        body: scenario.body,
      },
      { taskId: task.id },
    );
    assert.equal(JSON.stringify(result).includes(canary), false);
  }
  assert.equal(captured[0].input.headers["X-Client-Secret"], canary);
  assert.equal(captured[0].input.headers["X-Client-Key"], "client-canary");
  assert.equal(new URL(captured[1].url).searchParams.get("api_key"), canary);
  assert.deepEqual(JSON.parse(captured[2].input.body!), { query: "stars", api_key: canary });
  assert.equal(
    captured[3].input.headers.Authorization,
    `Basic ${Buffer.from(`account-canary:${canary}`).toString("base64")}`,
  );
});

test("a rejected credential can reopen the same generic form, replace the vault entry and revoke every old version", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const secrets = secretFixture();
  const service = new GenericCredentials(db, secrets.vault, {
    available: true,
    resolve,
    request: async () => ({ status: 401, contentType: "application/json", body: canary }),
  });
  const task = await seed(db),
    request = await service.request(owner, specification, { taskSeed: task });
  const saved = await service.submit(owner, request.id, {
    clientResponseId: "first-save-123",
    values: { accessKey: canary },
  });
  await running(db, task.id);
  const result = await service.httpRequest(
    owner,
    { credentialId: saved.credentialRef!.id, path: "/survey" },
    { taskId: task.id },
  );
  assert.equal(result.status, 401);
  assert.equal(result.body.includes(canary), false);
  assert.equal(
    (await service.metadata(owner, saved.credentialRef!.id)).status,
    "invalid_credentials",
  );
  const retry = await service.reconnect(owner, saved.credentialRef!.id, {
    taskId: task.id,
    revision: 0,
  });
  assert.deepEqual(retry.schema.fields, request.schema.fields);
  await db.compareAndSwap(
    owner,
    "tasks",
    task.id,
    { status: "running" },
    { status: "waiting_input", state: { interactionRequestId: retry.id } },
  );
  const replaced = await service.submit(owner, retry.id, {
    clientResponseId: "second-save-123",
    values: { accessKey: "new-secret-canary" },
  });
  assert.notEqual(replaced.credentialRef!.id, saved.credentialRef!.id);
  assert.equal(secrets.values.has(`${owner}:${saved.credentialRef!.id}`), false);
  assert.equal((await service.metadata(owner, saved.credentialRef!.id)).status, "revoked");
  await service.revoke(owner, replaced.credentialRef!.id);
  assert.equal(secrets.values.size, 0);
});

test("expired, cancelled, stale and cross-owner forms cannot save or restart tasks", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const secrets = secretFixture();
  let now = Date.now();
  const service = new GenericCredentials(db, secrets.vault, {
    available: true,
    resolve,
    now: () => now,
    requestTtlMs: 1000,
  });
  const task = await seed(db),
    request = await service.request(owner, specification, { taskSeed: task });
  await assert.rejects(
    service.submit("other", request.id, {
      clientResponseId: "cross-owner-123",
      values: { accessKey: canary },
    }),
    /not found/,
  );
  now += 1001;
  assert.equal((await service.status(owner, request.id)).status, "expired");
  await assert.rejects(
    service.submit(owner, request.id, {
      clientResponseId: "expired-save-123",
      values: { accessKey: canary },
    }),
    /expired/,
  );
  const task2 = await seed(db),
    request2 = await service.request(owner, specification, { taskSeed: task2 });
  assert.equal((await service.cancel(owner, request2.id)).status, "cancelled");
  assert.equal((await db.get<AgentTask>(owner, "tasks", task2.id))?.status, "cancelled");
  await assert.rejects(
    service.submit(owner, request2.id, {
      clientResponseId: "cancelled-save-123",
      values: { accessKey: canary },
    }),
    /completed/,
  );
  const task3 = await seed(db),
    request3 = await service.request(owner, specification, { taskSeed: task3 });
  await db.compareAndSwap(owner, "tasks", task3.id, { attempts: 0 }, { attempts: 1 });
  assert.equal((await service.status(owner, request3.id)).status, "superseded");
  assert.equal(secrets.writes, 0);
});

test("a submitted form waits for its worker's pause instead of overwriting an active lease", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const secrets = secretFixture();
  const service = new GenericCredentials(db, secrets.vault, { available: true, resolve });
  const task = await seed(db);
  task.status = "running";
  await db.put(owner, "tasks", task);
  const request = await service.request(owner, specification, { taskId: task.id, revision: 0 });
  const submit = service.submit(owner, request.id, {
    clientResponseId: "fast-save-123",
    values: { accessKey: canary },
  });
  await new Promise((resolve) => setTimeout(resolve, 70));
  await db.compareAndSwap(
    owner,
    "tasks",
    task.id,
    { status: "running" },
    { status: "waiting_input", state: { interactionRequestId: request.id } },
  );
  assert.equal((await submit).status, "saved");
  assert.equal((await db.get<AgentTask>(owner, "tasks", task.id))?.status, "queued");
});

test("private DNS, changed DNS, redirects and unsupported authentication bindings cannot leak vault credentials", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const secrets = secretFixture();
  let privateDns = false,
    calls = 0;
  const service = new GenericCredentials(db, secrets.vault, {
    available: true,
    resolve: async () => (privateDns ? [{ address: "127.0.0.1", family: 4 }] : resolve()),
    request: async () => {
      calls++;
      return { status: 302, contentType: "text/plain", body: canary };
    },
  });
  const task = await seed(db),
    request = await service.request(owner, specification, { taskSeed: task });
  const saved = await service.submit(owner, request.id, {
    clientResponseId: "dns-save-123",
    values: { accessKey: canary },
  });
  await running(db, task.id);
  privateDns = true;
  await assert.rejects(
    service.httpRequest(
      owner,
      { credentialId: saved.credentialRef!.id, path: "/survey" },
      { taskId: task.id },
    ),
    /public HTTP/,
  );
  assert.equal(calls, 0);
  privateDns = false;
  await assert.rejects(
    service.httpRequest(
      owner,
      { credentialId: saved.credentialRef!.id, path: "/survey" },
      { taskId: task.id },
    ),
    /redirected/,
  );
  assert.equal(calls, 1);
  assert.equal(
    genericCredentialRequestSchema.safeParse({
      ...specification,
      origin: "https://api.example.test/extra",
    }).success,
    false,
  );
  assert.equal(
    genericCredentialRequestSchema.safeParse({
      ...specification,
      authentication: { type: "header", fieldId: "accessKey", headerName: "Host" },
    }).success,
    false,
  );
  assert.equal(
    genericCredentialRequestSchema.safeParse({
      ...specification,
      authentication: {
        type: "bindings",
        bindings: [
          { type: "bearer", fieldId: "accessKey" },
          { type: "header", fieldId: "accessKey", headerName: "Authorization" },
        ],
      },
    }).success,
    false,
  );
});

test("generic HTTP routes accept values only in secure submission and expose only metadata", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const secrets = secretFixture();
  const service = new GenericCredentials(db, secrets.vault, { available: true, resolve });
  const task = await seed(db),
    request = await service.request(owner, specification, { taskSeed: task });
  const app = new Hono<{ Variables: { owner: string } }>();
  app.use("*", async (c, next) => {
    c.set("owner", owner);
    await next();
  });
  app.onError((error, c) =>
    c.json({ error: error.message }, error instanceof AppError ? error.status : 500),
  );
  app.route("/api", genericCredentialRoutes(service));
  const response = await app.request(`/api/service-credentials/requests/${request.id}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientResponseId: "http-save-123", values: { accessKey: canary } }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.text()).includes(canary), false);
  const list = await app.request("/api/service-credentials");
  const payload = (await list.json()) as { connections: { id: string }[] };
  assert.equal(payload.connections.length, 1);
  assert.equal(JSON.stringify(payload).includes(canary), false);
  assert.equal(
    (
      await app.request(`/api/service-credentials/${payload.connections[0].id}/revoke`, {
        method: "POST",
      })
    ).status,
    200,
  );
});

test("failed writes after dispatch remain outcome-unknown while blocked preflight and read-only failures stay ordinary errors", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const secrets = secretFixture();
  let redirect = false;
  const service = new GenericCredentials(db, secrets.vault, {
    available: true,
    resolve,
    request: async () => {
      if (redirect) return { status: 302, contentType: "text/plain", body: canary };
      throw new Error(`The upstream echoed ${canary}`);
    },
  });
  const task = await seed(db),
    request = await service.request(owner, specification, { taskSeed: task });
  const saved = await service.submit(owner, request.id, {
    clientResponseId: "uncertain-save-123",
    values: { accessKey: canary },
  });
  await running(db, task.id);
  const input = {
    credentialId: saved.credentialRef!.id,
    path: "/records",
    method: "POST" as const,
    intent: "write" as const,
    body: { name: "New record" },
  };
  await assert.rejects(
    service.httpRequest(owner, input, { taskId: task.id }),
    (error: unknown) =>
      error instanceof Error &&
      "outcomeUnknown" in error &&
      error.outcomeUnknown === true &&
      !error.message.includes(canary),
  );
  await assert.rejects(
    service.httpRequest(owner, { ...input, intent: "read" }, { taskId: task.id }),
    (error: unknown) => error instanceof Error && !("outcomeUnknown" in error),
  );
  await assert.rejects(
    service.httpRequest(
      owner,
      { ...input, path: "https://different.example.test" },
      { taskId: task.id },
    ),
    (error: unknown) => error instanceof Error && !("outcomeUnknown" in error),
  );
  redirect = true;
  await assert.rejects(
    service.httpRequest(owner, input, { taskId: task.id }),
    (error: unknown) =>
      error instanceof Error && "outcomeUnknown" in error && error.outcomeUnknown === true,
  );
});

test("trusted origin adapters can consume the same saved credential without weakening task tools", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const secrets = secretFixture();
  const service = new GenericCredentials(db, secrets.vault, {
    available: true,
    resolve,
    request: async (_target, input) => {
      assert.equal(input.headers.Authorization, `Bearer ${canary}`);
      return { status: 200, contentType: "application/json", body: '{"results":[]}' };
    },
  });
  assert.equal(await service.httpForOrigin(owner, specification.origin, { path: "/search" }), null);
  const task = await seed(db),
    request = await service.request(owner, specification, { taskSeed: task });
  const saved = await service.submit(owner, request.id, {
    clientResponseId: "origin-save-123",
    values: { accessKey: canary },
  });
  const result = await service.httpForOrigin(owner, specification.origin, {
    path: "/search",
    method: "POST",
    intent: "read",
    body: { query: "stars" },
  });
  assert.equal(result?.status, 200);
  await assert.rejects(
    service.httpRequest(
      owner,
      { credentialId: saved.credentialRef!.id, path: "/search" },
      { taskId: randomUUID() },
    ),
    /not authorized/,
  );
  await assert.rejects(
    service.httpForOrigin(owner, specification.origin, {
      path: "https://different.example.test/steal",
    }),
    /destination/,
  );
});

test("missing, changed or incomplete vault entries require reconnection, while outages and revocation during dispatch never send credentials", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const secrets = secretFixture();
  let calls = 0,
    outage = false;
  const service = new GenericCredentials(
    db,
    {
      ...secrets.vault,
      read: async (account, id) => {
        if (outage) throw new Error("vault offline");
        return secrets.vault.read(account, id);
      },
    },
    {
      available: true,
      resolve,
      request: async () => {
        calls++;
        return { status: 200, contentType: "application/json", body: "{}" };
      },
    },
  );
  async function connected() {
    const task = await seed(db),
      request = await service.request(owner, specification, { taskSeed: task });
    const saved = await service.submit(owner, request.id, {
      clientResponseId: `save-${task.id}`,
      values: { accessKey: canary },
    });
    assert.ok(saved.credentialRef);
    await running(db, task.id);
    return { task, id: saved.credentialRef.id };
  }
  for (const kind of ["missing", "changed", "incomplete"] as const) {
    const { task, id } = await connected();
    if (kind === "missing") secrets.values.delete(`${owner}:${id}`);
    else
      secrets.values.set(`${owner}:${id}`, {
        version: kind === "changed" ? 2 : 1,
        data: kind === "incomplete" ? {} : { accessKey: canary },
      });
    await assert.rejects(
      service.httpRequest(owner, { credentialId: id, path: "/survey" }, { taskId: task.id }),
      (error: unknown) =>
        error instanceof AppError && error.code === "CREDENTIAL_RECONNECT_REQUIRED",
    );
    assert.equal((await service.metadata(owner, id)).status, "invalid_credentials");
  }
  const current = await connected();
  outage = true;
  await assert.rejects(
    service.httpRequest(
      owner,
      { credentialId: current.id, path: "/survey" },
      { taskId: current.task.id },
    ),
    (error: unknown) => error instanceof AppError && error.code === "VAULT_UNAVAILABLE",
  );
  assert.equal((await service.metadata(owner, current.id)).status, "saved");
  outage = false;
  await assert.rejects(
    service.httpRequest(
      owner,
      { credentialId: current.id, path: "/survey" },
      {
        taskId: current.task.id,
        beforeDispatch: async () => {
          await service.revoke(owner, current.id);
        },
      },
    ),
    (error: unknown) => error instanceof AppError && error.code === "CREDENTIAL_RECONNECT_REQUIRED",
  );
  assert.equal(calls, 0);
});
