import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { EventType, type RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import type {
  ComposioExecutionContext,
  ComposioExecutionInput,
  ComposioTool,
} from "../apps/server/src/composio/contracts.ts";
import { ComposioService } from "../apps/server/src/composio/service.ts";
import type { SecretStore } from "../apps/server/src/credentials/contracts.ts";
import type { Store } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { AppError } from "../apps/server/src/errors.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";
import type { CredentialInteractionRequest } from "../packages/domain/src/runtime.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

function provider(initial: Partial<ComposioTool> = {}) {
  let metadata: ComposioTool = {
    slug: "ATLAS_READ_OBSERVATION",
    toolkit: "atlas",
    name: "Read an observation",
    description: "Read the current observation",
    tags: ["readOnlyHint"],
    noAuth: false,
    version: "20261003_01",
    inputSchema: {
      type: "object",
      properties: { target: { type: "string" } },
      required: ["target"],
      additionalProperties: false,
    },
    ...initial,
  };
  const calls: ComposioExecutionInput[] = [];
  let dispatchError: Error | undefined;
  const backend = {
    async status() {
      return { configured: true };
    },
    async search() {
      return {
        sessionId: "server-private-session",
        tools: [metadata],
        connections: [{ id: "ca-atlas", toolkit: "atlas", serviceName: "Atlas", status: "ACTIVE" }],
      };
    },
    async rawTool() {
      return metadata;
    },
    async findConnection(owner: string, toolkit: string, accountId?: string) {
      if (accountId && accountId !== "ca-atlas")
        throw new AppError("Account belongs to another user", 403);
      assert.equal(owner, "owner");
      return { id: "ca-atlas", toolkit, serviceName: "Atlas", status: "ACTIVE" };
    },
    async connections() {
      return [{ id: "ca-atlas", toolkit: "atlas", serviceName: "Atlas", status: "ACTIVE" }];
    },
    async executeSingle(
      _owner: string,
      input: ComposioExecutionInput,
      context: ComposioExecutionContext,
    ) {
      await context.beforeDispatch?.();
      calls.push(input);
      if (dispatchError) throw dispatchError;
      return {
        data: { observation: "Aurora boreal às 22h", receipt: "provider-confirmed-123" },
        error: null,
        logId: "execution-123",
      };
    },
  };
  return {
    backend: backend as unknown as ComposioService,
    calls,
    update(value: Partial<ComposioTool>) {
      metadata = { ...metadata, ...value };
    },
    fail(error: Error) {
      dispatchError = error;
    },
  };
}

function hosted(db: Store, financial = false) {
  const canary = "composio-project-private-canary";
  const accounts: { id: string; status: string }[] = [];
  const values = new Map<string, { version: number; data: Record<string, string> }>();
  const vault: SecretStore = {
    async read(owner, id) {
      return values.get(`${owner}:${id}`) ?? null;
    },
    async write(owner, id, data, expected) {
      values.set(`${owner}:${id}`, { version: expected + 1, data });
      return expected + 1;
    },
    async delete(owner, id) {
      values.delete(`${owner}:${id}`);
    },
  };
  let links = 0,
    dispatches = 0,
    rejectNext = false;
  const slug = financial ? "ATLAS_PURCHASE_TICKET" : "ATLAS_READ_OBSERVATION";
  const service = new ComposioService(db, vault, {
    available: true,
    request: async (input) => {
      assert.equal(input.apiKey, canary);
      await input.beforeDispatch?.();
      if (input.path === "/toolkits") return { items: [{ slug: "atlas", name: "Atlas" }] };
      if (input.path === "/toolkits/atlas")
        return { slug: "atlas", name: "Atlas", auth_schemes: ["OAUTH2"] };
      if (input.path === "/tool_router/session") return { session_id: "session_atlas" };
      if (input.path.endsWith("/search"))
        return { tool_schemas: { [slug]: {} }, results: [{ primary_tool_slugs: [slug] }] };
      if (input.path === `/tools/${slug}`)
        return {
          slug,
          toolkit: { slug: "atlas" },
          name: financial ? "Purchase ticket" : "Read observation",
          description: financial ? "Purchase the ticket" : "Read the observation",
          tags: [financial ? "createHint" : "readOnlyHint"],
          version: "20261003_01",
          input_parameters: {
            type: "object",
            properties: { target: { type: "string" } },
            required: ["target"],
          },
        };
      if (input.path === "/connected_accounts")
        return {
          items: accounts.map((account) => ({
            ...account,
            toolkit: { slug: "atlas", name: "Atlas" },
            user_id: input.query?.get("user_ids"),
          })),
        };
      if (input.path.endsWith("/link")) {
        links++;
        const id = `ca_atlas_${links}`;
        accounts.push({ id, status: "INITIATED" });
        return {
          connected_account_id: id,
          redirect_url: `https://connect.composio.dev/link/atlas_${links}`,
        };
      }
      if (input.path.endsWith("/execute")) {
        dispatches++;
        if (rejectNext) {
          rejectNext = false;
          accounts[0].status = "EXPIRED";
          return {
            error: "Authentication failed: invalid token",
            data: {},
            log_id: `log_${dispatches}`,
          };
        }
        return {
          data: { observation: "Aurora boreal às 22h", api_key: canary },
          error: null,
          log_id: `log_${dispatches}`,
        };
      }
      throw new Error(`Unexpected Composio request ${input.path}`);
    },
  });
  return {
    service,
    canary,
    accounts,
    get links() {
      return links;
    },
    get dispatches() {
      return dispatches;
    },
    reject() {
      rejectNext = true;
    },
  };
}

test("chat connects an unseen app in its native sheet, resumes the original request and reuses the account in a second task", async (t) => {
  let bindingId = "";
  const original = "Leia a observação atual da minha conta Atlas";
  const { requests } = await modelFixture(t, async (index) => {
    if (index === 0)
      return { name: "delegate_task", arguments: { kind: "agent", prompt: original } };
    if (index === 2 || index === 6)
      return {
        name: "connect_app",
        arguments: { toolkit: "atlas", purpose: "Read my current account observation" },
      };
    if (index === 3 || index === 7)
      return { name: "search_app_tools", arguments: { query: "Read Atlas observation" } };
    if (index === 4 || index === 8) {
      const task = (await server.db.list<AgentTask>("owner", "tasks")).find(
        (candidate) => candidate.status === "running",
      )!;
      bindingId = (
        await server.db.list<{ id: string; scope: string }>("owner", "composio-discoveries")
      ).find((discovery) => discovery.scope === `task:${task.id}`)!.id;
      return {
        name: "execute_app_tool",
        arguments: { bindingId, arguments: { target: "aurora" } },
      };
    }
    if (index === 5 || index === 9)
      return {
        name: "finish_task",
        arguments: { summary: "A observação da conta é Aurora boreal às 22h." },
      };
  });
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const fixture = hosted(server.db);
  await fixture.service.setup("owner", fixture.canary);
  server.agent.configureComposio(fixture.service);
  const threadId = randomUUID();
  await server.db.put("owner", "threads", { id: threadId });
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
  assert.equal(requests.length, 2, "chat finishes after the durable handoff");
  const first = (await server.db.list<AgentTask>("owner", "tasks"))[0];
  assert.equal(first.prompt, original);
  assert.equal(first.originThreadId, threadId);
  assert.equal(first.status, "queued");
  assert.equal(fixture.links, 0, "chat does not start remote account setup");
  assert.equal((await server.db.list("owner", "interaction-requests")).length, 0);
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask("owner", first.id)).status, "waiting_input");
  assert.equal(requests.length, 3);
  const interaction = (
    await server.db.list<CredentialInteractionRequest>("owner", "interaction-requests")
  )[0];
  assert.equal(interaction.schema.credentialKind, "composio");
  fixture.accounts[0].status = "ACTIVE";
  assert.equal((await fixture.service.flow("owner", interaction.id)).status, "connected");
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask("owner", first.id)).status, "succeeded");
  const second = await server.agent.createTask("owner", { prompt: original });
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask("owner", second.id)).status, "succeeded");
  assert.equal(fixture.links, 1, "the second task uses the saved account without another modal");
  assert.equal(fixture.dispatches, 2);
  assert.equal(requests.length, 10);
  const recorded = await Promise.all(
    [
      "tasks",
      "task-operations",
      "task-checkpoints",
      "interaction-requests",
      "composio-discoveries",
      "composio-flows",
    ].map((kind) => server.db.list("owner", kind)),
  );
  assert.equal(JSON.stringify({ requests, events, recorded }).includes(fixture.canary), false);
});

test("rejected app authentication pauses the same task and reconnects through the private sheet", async (t) => {
  let bindingId = "";
  const { requests } = await modelFixture(t, async (index) => {
    if (index === 0)
      return { name: "search_app_tools", arguments: { query: "Read Atlas observation" } };
    if (index === 1 || index === 2) {
      bindingId = (await server.db.list<{ id: string }>("owner", "composio-discoveries"))[0].id;
      return {
        name: "execute_app_tool",
        arguments: { bindingId, arguments: { target: "aurora" } },
      };
    }
    if (index === 3)
      return {
        name: "finish_task",
        arguments: { summary: "A observação confirmada é Aurora boreal às 22h." },
      };
  });
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const fixture = hosted(server.db);
  await fixture.service.setup("owner", fixture.canary);
  fixture.accounts.push({ id: "ca_previous", status: "ACTIVE" });
  fixture.reject();
  server.agent.configureComposio(fixture.service);
  const task = await server.agent.createTask("owner", {
    prompt: "Leia a observação da minha conta Atlas",
  });
  await server.agent.worker.tick();
  const current = await server.agent.getTask("owner", task.id);
  assert.equal(current.status, "waiting_input", JSON.stringify(current));
  assert.equal(requests.length, 2, "rejected authentication does not become a questionnaire");
  const interaction = (
    await server.db.list<CredentialInteractionRequest>("owner", "interaction-requests")
  )[0];
  assert.equal(interaction.taskId, task.id);
  fixture.accounts.at(-1)!.status = "ACTIVE";
  await fixture.service.flow("owner", interaction.id);
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask("owner", task.id)).status, "succeeded");
  assert.equal(fixture.dispatches, 2);
  assert.equal((await server.db.list("owner", "tasks")).length, 1);
});

test("an app account that expires during native review opens a task-bound reconnect sheet before dispatch", async (t) => {
  const { requests } = await modelFixture(t, async (index) => {
    if (index === 0)
      return { name: "search_app_tools", arguments: { query: "Purchase Atlas ticket" } };
    if (index === 1)
      return {
        name: "execute_app_tool",
        arguments: {
          bindingId: (await server.db.list<{ id: string }>("owner", "composio-discoveries"))[0].id,
          arguments: { target: "ticket" },
        },
      };
  });
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const fixture = hosted(server.db, true);
  await fixture.service.setup("owner", fixture.canary);
  fixture.accounts.push({ id: "ca_previous", status: "ACTIVE" });
  server.agent.configureComposio(fixture.service);
  const task = await server.agent.createTask("owner", { prompt: "Purchase my Atlas ticket" });
  await server.agent.worker.tick();
  const action = (await server.db.list<ActionProposal>("owner", "actions"))[0];
  fixture.accounts[0].status = "EXPIRED";
  const rejected = await server.agent.actions.decide("owner", action.id, action.hash, "approve");
  assert.equal(rejected.status, "failed");
  await server.agent.worker.tick();
  const current = await server.agent.getTask("owner", task.id);
  assert.equal(current.status, "waiting_input", JSON.stringify(current));
  assert.equal(requests.length, 2);
  assert.equal(fixture.dispatches, 0);
  const interaction = (
    await server.db.list<CredentialInteractionRequest>("owner", "interaction-requests")
  )[0];
  assert.equal(interaction.taskId, task.id);
  assert.equal(current.state.interactionRequestId, interaction.id);
  assert.equal(interaction.schema.credentialKind, "composio");
});

test("an unconfigured catalog does not offer app tools or request a platform key", async (t) => {
  const { requests } = await modelFixture(t, () => undefined);
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const fixture = provider();
  t.mock.method(fixture.backend, "status", async () => ({ configured: false }));
  server.agent.configureComposio(fixture.backend);
  await server.agent.createTask("owner", { prompt: "Write a short welcome message." });
  await server.agent.worker.tick();
  assert.ok(requests.length);
  assert.doesNotMatch(
    requests[0].body,
    /"name":"(?:search_app_tools|connect_app|execute_app_tool)"/,
  );
  assert.match(requests[0].body, /Never request a Composio platform API key/);
  assert.equal((await server.db.list("owner", "interaction-requests")).length, 0);
  assert.equal(fixture.calls.length, 0);
});

test("discovered app reads run through task journal and only observed execution satisfies completion", async (t) => {
  let bindingId = "";
  const { requests } = await modelFixture(t, async (index) => {
    if (index === 0)
      return { name: "search_app_tools", arguments: { query: "Read current Atlas observation" } };
    if (index === 1) {
      bindingId = (await server.db.list<{ id: string }>("owner", "composio-discoveries"))[0].id;
      return {
        name: "execute_app_tool",
        arguments: { bindingId, arguments: { target: "aurora" } },
      };
    }
    if (index === 2)
      return {
        name: "finish_task",
        arguments: { summary: "A observação confirmada é Aurora boreal às 22h." },
      };
  });
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const fixture = provider();
  server.agent.configureComposio(fixture.backend);
  const task = await server.agent.createTask("owner", {
    prompt: "Leia a observação atual da minha conta Atlas",
  });
  await server.agent.worker.tick();
  const current = await server.agent.getTask("owner", task.id);
  assert.equal(current.status, "succeeded", JSON.stringify(current));
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].accountId, "ca-atlas");
  assert.equal((await server.db.list("owner", "actions")).length, 0);
  assert.equal(
    requests.some((request) => request.body.includes("server-private-session")),
    false,
  );
  const operations = await server.agent.journal.operations("owner", task.id);
  assert.equal(operations.find((op) => op.toolName === "search_app_tools")?.effect, false);
  assert.equal(operations.find((op) => op.toolName === "execute_app_tool")?.status, "succeeded");
  await assert.rejects(
    () =>
      server.agent.composio!.run(
        "other-owner",
        { bindingId, arguments: { target: "aurora" } },
        { taskId: task.id, approval: async () => {}, connect: async () => undefined },
      ),
    /Discover/,
  );
});

test("app discovery filters meta tools and custom HTTP executors without bypassing policy", async (t) => {
  const server = await taskRuntime(t);
  const fixture = provider({ slug: "ATLAS_CUSTOM_API_REQUEST" });
  server.agent.configureComposio(fixture.backend);
  assert.deepEqual(
    (await server.agent.composio!.search("owner", "chat:thread", { query: "Anything" })).tools,
    [],
  );
  fixture.update({
    slug: "ATLAS_UNRESTRICTED",
    inputSchema: {
      type: "object",
      properties: { endpoint: { type: "string" }, method: { type: "string" } },
    },
  });
  assert.deepEqual(
    (await server.agent.composio!.search("owner", "chat:thread", { query: "Anything" })).tools,
    [],
  );
  fixture.update({ slug: "COMPOSIO_MULTI_EXECUTE_TOOL" });
  assert.deepEqual(
    (await server.agent.composio!.search("owner", "chat:thread", { query: "Anything" })).tools,
    [],
  );
  assert.equal(fixture.calls.length, 0);
});

test("financial app operations bind review to schema and account and do not replay a confirmed write", async (t) => {
  let bindingId = "";
  await modelFixture(t, async (index) => {
    if (index === 0)
      return { name: "search_app_tools", arguments: { query: "Purchase Atlas ticket" } };
    if (index === 1) {
      bindingId = (await server.db.list<{ id: string }>("owner", "composio-discoveries"))[0].id;
      return {
        name: "execute_app_tool",
        arguments: { bindingId, arguments: { target: "ticket" } },
      };
    }
  });
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const fixture = provider({
    slug: "ATLAS_PURCHASE_TICKET",
    tags: ["createHint"],
    name: "Purchase ticket",
    description: "Purchase the requested ticket",
  });
  server.agent.configureComposio(fixture.backend);
  const task = await server.agent.createTask("owner", { prompt: "Purchase the Atlas ticket" });
  await server.agent.worker.tick();
  const pending = await server.agent.getTask("owner", task.id);
  assert.equal(pending.status, "waiting_approval");
  assert.equal(fixture.calls.length, 0);
  const action = (await server.db.list<ActionProposal>("owner", "actions"))[0];
  assert.equal(action.data.tool, "composio.execute");
  assert.equal(action.status, "awaiting_review");
  const result = await server.agent.actions.decide("owner", action.id, action.hash, "approve");
  assert.equal(result.status, "succeeded", result.error);
  assert.equal(fixture.calls.length, 1);
  const replay = await server.agent.actions.decide("owner", action.id, action.hash, "approve");
  assert.equal(replay.status, "succeeded");
  assert.equal(fixture.calls.length, 1);
  assert.equal((await server.db.list("owner", "composio-receipts")).length, 1);
  const original = (await server.db.get<AgentTask>("owner", "tasks", task.id))!;
  await server.db.put("owner", "tasks", {
    ...original,
    criteria: [
      {
        id: "external",
        kind: "receipt",
        effect: "external",
        description: "Confirmed app receipt",
        requiredItems: [],
      },
    ],
  });
  assert.equal((await server.agent.verification.assess("owner", task.id, 0)).status, "verified");
  await server.db.remove("owner", "composio-receipts", action.id);
  assert.equal((await server.agent.verification.assess("owner", task.id, 0)).status, "unverified");
});

test("schema changes after native review prevent dispatch", async (t) => {
  await modelFixture(t, async (index) => {
    if (index === 0) return { name: "search_app_tools", arguments: { query: "Buy ticket" } };
    if (index === 1)
      return {
        name: "execute_app_tool",
        arguments: {
          bindingId: (await server.db.list<{ id: string }>("owner", "composio-discoveries"))[0].id,
          arguments: { target: "ticket" },
        },
      };
  });
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const fixture = provider({ slug: "ATLAS_BUY_TICKET", tags: ["createHint"] });
  server.agent.configureComposio(fixture.backend);
  await server.agent.createTask("owner", { prompt: "Buy the Atlas ticket" });
  await server.agent.worker.tick();
  const action = (await server.db.list<ActionProposal>("owner", "actions"))[0];
  fixture.update({ version: "20261003_02" });
  const result = await server.agent.actions.decide("owner", action.id, action.hash, "approve");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /definition changed/);
  assert.equal(fixture.calls.length, 0);
});

for (const uncertain of [false, true]) {
  test(`unclassified app writes respect the automatic policy and ${uncertain ? "stop after an uncertain dispatch" : "save a confirmed receipt"}`, async (t) => {
    const { requests } = await modelFixture(t, async (index) => {
      if (index === 0)
        return { name: "search_app_tools", arguments: { query: "Create item in Atlas" } };
      if (index === 1)
        return {
          name: "execute_app_tool",
          arguments: {
            bindingId: (await server.db.list<{ id: string }>("owner", "composio-discoveries"))[0]
              .id,
            arguments: { target: "observation" },
          },
        };
      if (index === 2)
        return {
          name: "finish_task",
          arguments: { summary: "O item solicitado foi criado e confirmado pelo serviço Atlas." },
        };
    });
    const server = await taskRuntime(t, {
      mode: "live",
      approvalPolicy: "money",
      agentBackend: "model",
      model: "openai/fixture",
    });
    const fixture = provider({
      slug: "ATLAS_CREATE_ITEM",
      tags: [],
      name: "Create item",
      description: "Create an item in Atlas",
    });
    if (uncertain)
      fixture.fail(
        Object.assign(new Error("Connection ended after dispatch"), { outcomeUnknown: true }),
      );
    server.agent.configureComposio(fixture.backend);
    const task = await server.agent.createTask("owner", {
      prompt: "Create an item in my Atlas account",
    });
    await server.agent.worker.tick();
    const current = await server.agent.getTask("owner", task.id);
    const action = (await server.db.list<ActionProposal>("owner", "actions"))[0];
    assert.equal(
      action.status,
      uncertain ? "outcome_unknown" : "succeeded",
      JSON.stringify(action),
    );
    assert.equal(fixture.calls.length, 1);
    assert.equal(
      current.status,
      uncertain ? "waiting_input" : "succeeded",
      JSON.stringify(current),
    );
    if (uncertain) {
      assert.equal(requests.length, 2, "the agent stops before it can retry an uncertain write");
      await server.agent.worker.tick();
      assert.equal(fixture.calls.length, 1);
    }
  });
}
