import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { ComposioService } from "../apps/server/src/composio/service.ts";
import {
  type ComposioTransportInput,
  composioTransport,
} from "../apps/server/src/composio/transport.ts";
import type { SecretStore } from "../apps/server/src/credentials/contracts.ts";
import { createStore } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";

async function fixture(t: TestContext) {
  const db = await createStore();
  t.after(() => db.close());
  let now = Date.now();
  const values = new Map<string, { version: number; data: Record<string, string> }>();
  const vault: SecretStore = {
    async read(owner, id) {
      return values.get(`${owner}:${id}`) ?? null;
    },
    async write(owner, id, data, version) {
      values.set(`${owner}:${id}`, { version: version + 1, data });
      return version + 1;
    },
    async delete(owner, id) {
      values.delete(`${owner}:${id}`);
    },
  };
  const calls: ComposioTransportInput[] = [];
  const accounts: Record<string, unknown>[] = [];
  let userId = "",
    session = 0,
    failRevoke = false,
    noAuth = false;
  let execution: unknown = {
    data: { answer: 42, access_token: "provider-private" },
    error: null,
    log_id: "log_1",
  };
  const service = new ComposioService(db, vault, {
    available: true,
    now: () => now,
    request: async (input) => {
      calls.push(input);
      await input.beforeDispatch?.();
      if (input.path === "/toolkits")
        return {
          items: [
            {
              slug: "atlas",
              name: "Atlas",
              meta: { categories: [{ id: "analytics", name: "Analytics" }] },
            },
          ],
          next_cursor: "opaque+/=",
          total_items: 3000,
        };
      if (input.path === "/toolkits/categories")
        return { items: [{ id: "analytics", name: "Analytics" }] };
      if (input.path === "/toolkits/atlas")
        return { slug: "atlas", name: "Atlas", no_auth: noAuth };
      if (input.path === "/tool_router/session") {
        const body = input.body as {
          user_id: string;
          instant: boolean;
          workbench: { enable: boolean };
        };
        assert.equal(body.instant, false);
        assert.equal(body.workbench.enable, false);
        userId = body.user_id;
        return { session_id: `session_${++session}` };
      }
      if (input.path.endsWith("/link")) {
        const id = `ca_${accounts.length + 1}`;
        accounts.push({
          id,
          user_id: userId,
          toolkit: { slug: "atlas" },
          status: "INITIATED",
          state: { access_token: "provider-private" },
        });
        return {
          connected_account_id: id,
          redirect_url: `https://connect.composio.dev/link/${id}`,
        };
      }
      if (input.path === "/connected_accounts") return { items: accounts };
      if (input.path.endsWith("/revoke")) {
        if (failRevoke) throw new AppError("Unavailable", 502);
        return {};
      }
      if (input.method === "DELETE") return {};
      if (input.path.endsWith("/search")) return { tool_schemas: { ATLAS_READ: {} } };
      if (input.path === "/tools/ATLAS_READ")
        return {
          slug: "ATLAS_READ",
          toolkit: { slug: "atlas" },
          input_parameters: { type: "object", properties: {} },
          version: "1",
          tags: ["readOnlyHint"],
        };
      if (input.path.endsWith("/execute")) return execution;
      throw new Error(`Unexpected path ${input.path}`);
    },
  });
  await service.setup("owner", "synthetic-project-key");
  const seed = (): AgentTask => ({
    id: randomUUID(),
    kind: "agent",
    title: "Read Atlas",
    prompt: "Read my Atlas report",
    status: "waiting_input",
    attempts: 1,
    plan: [],
    evidence: [],
    artifactIds: [],
    state: {},
    input: {},
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
  return {
    db,
    service,
    calls,
    accounts,
    seed,
    advance() {
      now += 31 * 60_000;
    },
    noAuth() {
      noAuth = true;
    },
    failRevoke(value: boolean) {
      failRevoke = value;
    },
    execution(value: unknown) {
      execution = value;
    },
  };
}

test("catalog forwards filters and opaque pagination; account metadata is private and owner scoped", async (t) => {
  const f = await fixture(t);
  const catalog = await f.service.catalog("owner", {
    search: "report & docs",
    category: "analytics",
    cursor: "page+/=",
  });
  assert.equal(catalog.nextCursor, "opaque+/=");
  assert.equal(catalog.totalItems, 3000);
  assert.equal(
    f.calls.find((call) => call.query?.has("cursor"))?.query?.get("search"),
    "report & docs",
  );
  const connected = await f.service.connect("owner", { toolkit: "atlas", purpose: "Read report" });
  f.accounts[0].status = "ACTIVE";
  f.accounts.push(
    { ...f.accounts[0], id: "foreign", user_id: "another-owner" },
    { ...f.accounts[0], id: "shared", account_type: "SHARED" },
  );
  const accounts = await f.service.connections("owner");
  assert.deepEqual(
    accounts.map((account) => account.id),
    [connected.flow.connectionId],
  );
  assert.equal(JSON.stringify(accounts).includes("provider-private"), false);
  assert.equal((await f.service.catalog("other")).configured, false);
  await assert.rejects(f.service.flow("other", connected.flow.id), /not found/);
  assert.equal(
    JSON.stringify(await f.db.list("owner", "composio-config")).includes("synthetic-project-key"),
    false,
  );
});

test("expired authorization survives reload, retries the same task and resumes only after confirmation", async (t) => {
  const f = await fixture(t);
  const task = f.seed();
  const request = await f.service.request(
    "owner",
    { toolkit: "atlas", purpose: task.prompt },
    { taskSeed: task },
  );
  f.advance();
  assert.equal((await f.service.statusInteraction("owner", request.id)).status, "expired");
  assert.deepEqual(
    (await f.service.overview("owner")).pendingRequests.map((r) => r.id),
    [request.id],
  );
  const retried = await f.service.retry("owner", request.id);
  assert.equal(retried.id, request.id);
  assert.equal(retried.status, "waiting");
  assert.equal(retried.answeredAt, undefined);
  f.accounts[0].status = "ACTIVE"; // A late callback from the abandoned link cannot resume the task.
  assert.equal((await f.service.flow("owner", request.id)).status, "waiting");
  f.accounts[1].status = "ACTIVE";
  assert.equal((await f.service.flow("owner", request.id)).status, "connected");
  const resumed = await f.db.get<AgentTask>("owner", "tasks", task.id);
  assert.equal(resumed?.status, "queued");
  assert.equal(resumed?.attempts, task.attempts);
  assert.equal((await f.db.list("owner", "tasks")).length, 1);
});

test("failed authorization can be cancelled without leaving the original task waiting", async (t) => {
  const f = await fixture(t);
  const task = f.seed();
  const request = await f.service.request(
    "owner",
    { toolkit: "atlas", purpose: task.prompt },
    { taskSeed: task },
  );
  f.accounts[0].status = "FAILED";
  assert.equal((await f.service.flow("owner", request.id)).status, "error");
  assert.equal((await f.service.pending("owner")).length, 1);
  assert.equal((await f.service.cancel("owner", request.id)).status, "cancelled");
  assert.equal((await f.db.get<AgentTask>("owner", "tasks", task.id))?.status, "cancelled");
  assert.equal((await f.service.pending("owner")).length, 0);
});

test("changed task revisions never resume or cancel from old connection requests", async (t) => {
  const f = await fixture(t);
  const task = f.seed();
  const request = await f.service.request(
    "owner",
    { toolkit: "atlas", purpose: task.prompt },
    { taskSeed: task },
  );
  const current = { ...task, attempts: 2, state: { interactionRequestId: request.id } };
  await f.db.put("owner", "tasks", current);
  f.accounts[0].status = "ACTIVE";
  assert.equal((await f.service.flow("owner", request.id)).status, "superseded");
  await f.service.cancel("owner", request.id);
  assert.deepEqual(await f.db.get("owner", "tasks", task.id), current);
});

test("project key rotation provisions a fresh link without abandoning the waiting task", async (t) => {
  const f = await fixture(t);
  const task = f.seed();
  const request = await f.service.request(
    "owner",
    { toolkit: "atlas", purpose: task.prompt },
    { taskSeed: task },
  );
  await f.service.setup("owner", "rotated-project-key");
  const current = await f.service.statusInteraction("owner", request.id);
  assert.equal(current.status, "waiting");
  assert.notEqual(
    current.schema.composio?.authorizationUrl,
    request.schema.composio?.authorizationUrl,
  );
  f.accounts[1].status = "ACTIVE";
  await f.service.flow("owner", request.id);
  assert.equal((await f.db.get<AgentTask>("owner", "tasks", task.id))?.status, "queued");
});

test("apps without authentication resume their original task without a hosted link", async (t) => {
  const f = await fixture(t);
  f.noAuth();
  const task = f.seed();
  const request = await f.service.request(
    "owner",
    { toolkit: "atlas", purpose: task.prompt },
    { taskSeed: task },
  );
  assert.equal(request.status, "connected");
  assert.equal((await f.db.get<AgentTask>("owner", "tasks", task.id))?.status, "queued");
  assert.equal(f.accounts.length, 0);
});

test("failed remote disconnect remains retryable while local dispatch stays disabled", async (t) => {
  const f = await fixture(t);
  const connected = await f.service.connect("owner", { toolkit: "atlas", purpose: "Read report" });
  f.accounts[0].status = "ACTIVE";
  f.failRevoke(true);
  await assert.rejects(f.service.disconnect("owner", connected.flow.connectionId!), /Unavailable/);
  assert.equal(await f.service.findConnection("owner", "atlas"), null);
  assert.equal((await f.service.connections("owner"))[0].status, "DISCONNECT_FAILED");
  f.failRevoke(false);
  await f.service.disconnect("owner", connected.flow.connectionId!);
  assert.deepEqual(await f.service.connections("owner"), []);
});

test("execution requires a confirmed receipt and redacts provider credentials", async (t) => {
  const f = await fixture(t);
  await f.service.connect("owner", { toolkit: "atlas", purpose: "Read report" });
  f.accounts[0].status = "ACTIVE";
  const discovery = await f.service.search("owner", { query: "Read Atlas" });
  const input = {
    sessionId: discovery.sessionId,
    toolSlug: "ATLAS_READ",
    toolkit: "atlas",
    arguments: {},
  };
  assert.deepEqual((await f.service.executeSingle("owner", input, { effect: "read" })).data, {
    answer: 42,
    access_token: "[redacted]",
  });
  f.execution({});
  await assert.rejects(
    f.service.executeSingle("owner", input, { effect: "write" }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { outcomeUnknown: boolean }).outcomeUnknown === true,
  );
});

test("transport does not retry an uncertain write or expose a provider error body", async () => {
  let calls = 0;
  const transport = composioTransport(async () => {
    calls++;
    throw new Error("provider-secret");
  });
  await assert.rejects(
    transport({ apiKey: "private", path: "/execute", method: "POST", effect: "write" }),
    (error: unknown) =>
      error instanceof Error &&
      !error.message.includes("provider-secret") &&
      (error as Error & { outcomeUnknown: boolean }).outcomeUnknown === true,
  );
  assert.equal(calls, 1);
  const rejected = composioTransport(
    async () => new Response("private-provider-response", { status: 401 }),
  );
  await assert.rejects(
    rejected({ apiKey: "private", path: "/toolkits" }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "COMPOSIO_SETUP_REQUIRED" &&
      !error.message.includes("private-provider-response"),
  );
});
