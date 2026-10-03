import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import { CredentialBroker } from "../apps/server/src/credentials/broker.ts";
import type { SecretStore } from "../apps/server/src/credentials/contracts.ts";
import { GenericCredentials } from "../apps/server/src/credentials/generic.ts";
import { credentialPromptRoutes } from "../apps/server/src/credentials/prompts.ts";
import { createStore } from "../apps/server/src/db.ts";
import { IntegrationService } from "../apps/server/src/integrations.ts";
import { InteractionRequests } from "../apps/server/src/interaction-requests.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { CredentialInteractionRequest } from "../packages/domain/src/runtime.ts";

const vault: SecretStore = {
  async read() {
    return null;
  },
  async write() {
    throw new Error("This queue must never handle a secret");
  },
  async delete() {},
};
function request(taskId: string, threadId?: string): CredentialInteractionRequest {
  const id = randomUUID();
  return {
    id,
    taskId,
    threadId,
    revision: 1,
    kind: "credential",
    status: "waiting",
    createdAt: new Date().toISOString(),
    schema: {
      credentialKind: "composio",
      title: "Connect service",
      serviceName: "A new service",
      origin: "https://connect.composio.dev",
      purpose: "Continue the requested task",
      fields: [],
      composio: {
        flowId: id,
        toolkitSlug: "new-service",
        authorizationUrl: `https://connect.composio.dev/link/${id}`,
      },
    },
  };
}

test("the global queue keeps Settings authorization across polls and excludes stale task flows", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const settings = request(`composio-settings:${randomUUID()}`);
  settings.status = "expired";
  const threadId = randomUUID();
  await db.put("owner", "threads", { id: threadId });
  const active = request(randomUUID(), threadId);
  const stale = request(randomUUID(), threadId);
  const other = request(`composio-settings:${randomUUID()}`);
  for (const item of [settings, active, stale]) await db.put("owner", "interaction-requests", item);
  await db.put("other", "interaction-requests", other);
  await db.put("owner", "tasks", {
    id: active.taskId,
    status: "waiting_input",
    attempts: 1,
    state: { interactionRequestId: active.id },
  });
  await db.put("owner", "tasks", {
    id: stale.taskId,
    status: "waiting_input",
    attempts: 2,
    state: { interactionRequestId: stale.id },
  });
  const seen: string[] = [];
  const settled = new Set<string>();
  const composio = {
    async statusInteraction(owner: string, id: string) {
      seen.push(id);
      const current = await db.get<CredentialInteractionRequest>(owner, "interaction-requests", id);
      assert.ok(current);
      return settled.has(id) ? { ...current, status: "connected" as const } : current;
    },
  };
  const app = new Hono<{ Variables: { owner: string } }>();
  app.use("*", async (c, next) => {
    c.set("owner", c.req.header("x-owner") ?? "owner");
    await next();
  });
  app.route(
    "/api",
    credentialPromptRoutes(
      db,
      new CredentialBroker(db, vault, []),
      new GenericCredentials(db, vault, { available: true }),
      new IntegrationService(db, vault, { available: true }),
      composio,
    ),
  );
  const pending = async () =>
    (await (await app.request("/api/credential-prompts")).json())
      .requests as CredentialInteractionRequest[];
  assert.deepEqual(
    new Set((await pending()).map((item) => item.id)),
    new Set([settings.id, active.id]),
  );
  assert.equal(seen.includes(stale.id), false);
  assert.equal((await new InteractionRequests(db).status("owner", settings.id)).status, "expired");
  settled.add(active.id);
  assert.deepEqual(
    (await pending()).map((item) => item.id),
    [settings.id],
  );
  const isolated = await (
    await app.request("/api/credential-prompts", { headers: { "x-owner": "other" } })
  ).json();
  assert.deepEqual(
    isolated.requests.map((item: CredentialInteractionRequest) => item.id),
    [other.id],
  );
});

test("deleting a finished chat removes its Composio flows and bindings but preserves unrelated connections", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const threadId = randomUUID();
  await db.put("owner", "threads", { id: threadId });
  const flow = request(randomUUID(), threadId);
  await db.put("owner", "tasks", {
    id: flow.taskId,
    originThreadId: threadId,
    status: "cancelled",
  } as AgentTask);
  await db.put("owner", "interaction-requests", { ...flow, status: "cancelled" });
  await db.put("owner", "composio-flows", { id: flow.id, interaction: flow });
  await db.put("owner", "composio-discoveries", { id: randomUUID(), threadId });
  const savedSession = { id: "session", userId: "stable-user" };
  await db.put("owner", "composio-sessions", savedSession);
  const otherBinding = { id: randomUUID(), threadId: "other-chat" };
  await db.put("owner", "composio-discoveries", otherBinding);
  assert.equal((await db.deleteThread("owner", threadId, randomUUID())).status, "deleted");
  assert.deepEqual(await db.list("owner", "composio-flows"), []);
  assert.deepEqual(await db.list("owner", "composio-discoveries"), [otherBinding]);
  assert.deepEqual(await db.get("owner", "composio-sessions", "session"), savedSession);
});
