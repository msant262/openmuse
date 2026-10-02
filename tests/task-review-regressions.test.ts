import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { bindingHash } from "../apps/server/src/conversation-inbox.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { LostLeaseError, TaskWorker } from "../apps/server/src/engine/worker.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { ActionProposal, Artifact } from "../packages/domain/src/index.ts";
import type { TaskBudget } from "../packages/domain/src/runtime.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("model criteria cannot replace mandatory user file and send obligations", async (t) => {
  const prompt =
    "Create a DOCX document containing the agenda and send it by email to wife@example.test";
  await modelFixture(
    t,
    (index) =>
      [
        {
          name: "delegate_task",
          arguments: {
            prompt: "Save only a note",
            kind: "agent",
            criteria: [
              {
                id: "requested-file",
                kind: "artifact",
                description: "A saved note",
                requiredItems: [],
              },
            ],
          },
        },
        undefined,
        {
          name: "save_artifact",
          arguments: {
            kind: "report",
            title: "Complete",
            summary: "Everything requested is complete",
            data: { note: "Everything requested is complete" },
          },
        },
        { name: "finish_task", arguments: { summary: "The document was delivered and emailed" } },
      ][index],
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  await new Promise<void>((resolve, reject) => {
    new ConversationAgent(server.agent.config, server.agent, "owner")
      .run({
        threadId: "chat",
        runId: "rubric-review",
        messages: [{ id: "user1", role: "user", content: prompt }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      })
      .subscribe({ error: reject, complete: resolve });
  });
  const tasks = await server.db.list<AgentTask>("owner", "tasks");
  assert.equal(tasks.length, 1);
  await server.agent.worker.tick();
  const saved = await server.agent.getTask("owner", tasks[0].id);
  assert.equal(saved.prompt, prompt, "the accepted user request remains the task goal");
  assert.equal(saved.status, "waiting_input");
  assert.notEqual(saved.completion?.status, "verified");
  assert.ok(
    saved.criteria?.some(
      (criterion) =>
        criterion.id === "requested-file" &&
        criterion.kind === "file" &&
        criterion.format?.includes("wordprocessingml"),
    ),
  );
  assert.ok(
    saved.criteria?.some(
      (criterion) =>
        criterion.effect === "email.send" && criterion.requiredItems.includes("wife@example.test"),
    ),
  );
  assert.equal((await server.db.list("owner", "files")).length, 0);
  assert.equal((await server.db.list("owner", "actions")).length, 0);
});

test("literal required report sections must exist in the actual saved data", async (t) => {
  await modelFixture(
    t,
    (index) =>
      [
        {
          name: "save_artifact",
          arguments: {
            kind: "report",
            title: "Other subject",
            summary: "All requested sections are present",
            data: { unrelated: "Weather is sunny" },
          },
        },
        {
          name: "finish_task",
          arguments: { summary: "The report includes the agenda, costs and risks" },
        },
      ][index],
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await server.agent.createTask("owner", {
    prompt: "Prepare a report containing these required sections: agenda, costs, and risks",
  });
  await server.agent.worker.tick();
  const saved = await server.agent.getTask("owner", task.id);
  assert.equal(saved.status, "waiting_input");
  assert.notEqual(saved.completion?.status, "verified");
  assert.deepEqual(task.criteria?.[0].requiredItems, ["agenda", "costs", "risks"]);
});

test("confirmed MCP email is verified through its owned binding and receipt", async (t) => {
  let writes = 0;
  const remote = new McpServer({ name: "review-mail", version: "1" });
  remote.registerTool(
    "send_email",
    { inputSchema: { to: z.string(), body: z.string() } },
    async ({ to }) => {
      writes++;
      return { content: [{ type: "text", text: `Sent to ${to}; provider receipt message-1` }] };
    },
  );
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  await remote.connect(transport);
  const http = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    await transport.handleRequest(
      req,
      res,
      chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined,
    );
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  t.after(async () => {
    await remote.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  await modelFixture(
    t,
    (index) =>
      [
        {
          name: "mcp_mail_send_email",
          arguments: { to: "wife@example.test", body: "Requested exact message" },
        },
        { name: "finish_task", arguments: { summary: "The requested email was sent" } },
      ][index],
  );
  const server = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    mcpServers: [
      {
        id: "mail",
        url: `http://127.0.0.1:${address.port}/mcp`,
        account: "owner",
        transport: "http",
        headerEnv: {},
        tools: { send_email: "write" },
      },
    ],
  });
  const task = await server.agent.createTask("owner", {
    prompt: "Send an email to wife@example.test",
  });
  await server.agent.worker.tick();
  let saved = await server.agent.getTask("owner", task.id);
  assert.equal(saved.status, "waiting_approval");
  const proposal = await server.db.get<ActionProposal>("owner", "actions", String(saved.actionId));
  assert.ok(proposal);
  await server.actions.decide("owner", proposal.id, proposal.hash, "approve");
  await server.agent.worker.tick();
  saved = await server.agent.getTask("owner", task.id);
  assert.equal(writes, 1);
  assert.equal(saved.status, "succeeded");
  assert.equal(saved.completion?.status, "verified");
  const bound = await server.db.get<{ id: string; binding: { args: Record<string, unknown> } }>(
    "owner",
    "external-action-bindings",
    proposal.id,
  );
  assert.ok(bound);
  await server.db.put("owner", "external-action-bindings", {
    ...bound,
    binding: { ...bound.binding, args: { to: "wife@example.test.evil", body: "Other message" } },
  });
  assert.equal(
    (await server.agent.verification.assess("owner", task.id, 0)).status,
    "unverified",
    "display preview cannot substitute for the executed binding",
  );
  await server.db.put("owner", "external-action-bindings", bound);
  const physical = await server.db.get<{ id: string }>("owner", "mcp-receipts", proposal.id);
  assert.ok(physical);
  await server.db.put("owner", "mcp-receipts", { ...physical, status: "outcome_unknown" });
  assert.equal(
    (await server.agent.verification.assess("owner", task.id, 0)).status,
    "unverified",
    "action prose cannot substitute for a confirmed transport receipt",
  );
});

test("directed deterministic document publication has current journal evidence", async (t) => {
  const server = await taskRuntime(t);
  await server.workspace.ensureSample("owner", server.actions);
  const mail = (await server.workspace.snapshot("owner")).mail.find((m) => m.attachments.length);
  assert.ok(mail);
  const task = await server.agent.createTask("owner", {
    prompt: "Fill the school form and prepare a reply",
    kind: "document",
    input: {
      messageId: mail.id,
      fields: {
        participant_name: "Test Student",
        guardian_name: "Test Guardian",
        permission_granted: true,
      },
    },
  });
  await server.agent.mailbox.enqueue("owner", task.id, {
    clientMessageId: "same-instruction",
    text: "Use the same provided form values",
  });
  await server.agent.worker.tick();
  const pending = await server.agent.getTask("owner", task.id);
  assert.equal(pending.status, "waiting_approval", pending.error ?? pending.question);
  const proposal = await server.db.get<ActionProposal>(
    "owner",
    "actions",
    String(pending.actionId),
  );
  assert.ok(proposal);
  await server.actions.decide("owner", proposal.id, proposal.hash, "approve");
  await server.agent.worker.tick();
  const saved = await server.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded");
  assert.equal(
    saved.completion?.checks.find((c) => c.criterionId === "filled-document")?.passed,
    true,
  );
  assert.ok(
    (await server.agent.journal.operations("owner", task.id)).some(
      (op) => op.toolName === "fill_pdf" && op.status === "succeeded" && op.revision === 1,
    ),
  );
});

test("deterministic file publication reconciles once after a lost lease before checkpoint", async (t) => {
  const server = await taskRuntime(t);
  await server.workspace.ensureSample("owner", server.actions);
  const mail = (await server.workspace.snapshot("owner")).mail.find((m) => m.attachments.length);
  assert.ok(mail);
  const task = await server.agent.createTask("owner", {
    prompt: "Fill the school form and prepare a reply",
    kind: "document",
    input: {
      messageId: mail.id,
      fields: {
        participant_name: "Test Student",
        guardian_name: "Test Guardian",
        permission_granted: true,
      },
    },
  });
  const fill = server.files.fill.bind(server.files);
  let publications = 0;
  server.files.fill = async (...args) => {
    const file = await fill(...args);
    publications++;
    if (publications === 1) throw new LostLeaseError();
    return file;
  };
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask("owner", task.id)).status, "queued");
  await server.agent.worker.tick();
  const saved = await server.agent.getTask("owner", task.id);
  const filled = (await server.db.list<Artifact>("owner", "files")).filter(
    (f) => f.parentId === mail.attachments[0],
  );
  assert.equal(publications, 1);
  assert.equal(filled.length, 1);
  assert.equal(saved.status, "waiting_approval");
  assert.equal(
    (await server.agent.journal.operations("owner", task.id)).filter(
      (op) => op.toolName === "fill_pdf",
    ).length,
    1,
  );
});

test("current parent validity fences an existing child at dispatch", async (t) => {
  const server = await taskRuntime(t);
  const parent = await server.agent.createTask(
    "owner",
    {
      prompt: "Create the requested result",
      timing: { priority: "normal", validUntil: "2099-10-02T10:00:00Z" },
    },
    undefined,
    true,
  );
  const child = await server.agent.createChildTask(
    "owner",
    parent,
    { prompt: "Run the requested command" },
    "child-validity-review",
  );
  await server.agent.timing.update("owner", parent.id, {
    expectedRevision: 0,
    requestId: "expire-parent",
    validUntil: "2000-01-01T00:00:00Z",
  });
  let dispatched = 0;
  const worker = new TaskWorker(server.db, async (owner, running) => {
    await server.agent.journal.prepare(owner, {
      id: "child-effect",
      taskId: running.id,
      revision: 0,
      bindingHash: bindingHash({ value: 1 }),
      executorId: "vps",
      executorEpoch: 1,
      resourceFence: 0,
      status: "queued",
      toolName: "run_command",
      args: { value: 1 },
      effect: true,
      runToken: String(running.leaseId),
      resourceLeaseIds: [],
      createdAt: new Date().toISOString(),
    });
    await server.agent.journal.authorizeDispatch(owner, "child-effect", 0, String(running.leaseId));
    dispatched++;
    await server.agent.journal.recordReceipt(owner, "child-effect", {
      id: "command-1",
      status: "succeeded",
      exitCode: 0,
    });
    return { status: "waiting_input" };
  });
  t.after(() => worker.stop());
  await worker.tick();
  assert.equal(dispatched, 0);
  assert.equal(
    (await server.agent.journal.operations("owner", child.id))[0]?.status,
    "rejected_not_dispatched",
  );
});

for (const change of ["direction+expiry", "expired", "applied-direction", "paused"] as const)
  test(`reviewed MCP dispatch rechecks ${change} after awaited catalogue preflight`, {
    timeout: 15000,
  }, async (t) => {
    let writes = 0;
    let writtenTo = "";
    let blockCatalogue = false;
    let enterCatalogue!: () => void;
    let releaseCatalogue!: () => void;
    const catalogueEntered = new Promise<void>((resolve) => {
      enterCatalogue = resolve;
    });
    const catalogueReleased = new Promise<void>((resolve) => {
      releaseCatalogue = resolve;
    });
    const schema = z.object({ to: z.string(), body: z.string() });
    const remote = new McpServer({ name: "review-dispatch", version: "1" });
    remote.registerTool("send_email", { inputSchema: schema }, async ({ to }) => {
      writes++;
      writtenTo = to;
      return { content: [{ type: "text", text: "Sent receipt message-1" }] };
    });
    remote.server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (blockCatalogue) {
        blockCatalogue = false;
        enterCatalogue();
        await catalogueReleased;
      }
      return { tools: [{ name: "send_email", inputSchema: z.toJSONSchema(schema) }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    await remote.connect(transport);
    const http = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      await transport.handleRequest(
        req,
        res,
        chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined,
      );
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    assert.ok(address && typeof address === "object");
    t.after(async () => {
      releaseCatalogue();
      await remote.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    });
    await modelFixture(t, (index) =>
      index === 0
        ? {
            name: "mcp_mail_send_email",
            arguments: { to: "old@example.test", body: "Requested exact message" },
          }
        : undefined,
    );
    const server = await taskRuntime(t, {
      agentBackend: "model",
      model: "openai/fixture",
      mcpServers: [
        {
          id: "mail",
          url: `http://127.0.0.1:${address.port}/mcp`,
          account: "owner",
          transport: "http",
          headerEnv: {},
          tools: { send_email: "write" },
        },
      ],
    });
    const task = await server.agent.createTask("owner", {
      prompt: "Send an email to old@example.test",
      timing: { priority: "normal", validUntil: "2099-10-02T10:00:00Z" },
    });
    await server.agent.worker.tick();
    const pending = await server.agent.getTask("owner", task.id);
    assert.equal(pending.status, "waiting_approval");
    const action = await server.db.get<ActionProposal>(
      "owner",
      "actions",
      String(pending.actionId),
    );
    assert.ok(action);
    blockCatalogue = true;
    const decision = server.actions.decide("owner", action.id, action.hash, "approve");
    const approval =
      change === "paused" ? decision : assert.rejects(decision, /superseded|expired/i);
    await catalogueEntered;
    assert.equal(writes, 0);
    if (change === "direction+expiry" || change === "expired")
      await server.agent.timing.update("owner", task.id, {
        expectedRevision: 0,
        requestId: "expire-during-preflight",
        validUntil: "2000-01-01T00:00:00Z",
      });
    if (change === "direction+expiry" || change === "applied-direction")
      await server.agent.mailbox.enqueue("owner", task.id, {
        clientMessageId: "steer-during-preflight",
        text: "Use new@example.test instead",
      });
    if (change === "applied-direction") {
      const worker = new TaskWorker(server.db, async (owner, running, ctx) => {
        const applied = await server.agent.actor.apply(owner, running, ctx);
        assert.equal(applied.state.desiredRevision, 1);
        assert.equal(applied.state.appliedRevision, 1);
        return { status: "waiting_approval", actionId: action.id };
      });
      await worker.tick();
      await worker.stop();
    }
    if (change === "paused")
      await server.agent.runtimePause.set("owner", { paused: true, expectedRevision: 0 });
    releaseCatalogue();
    await approval;
    assert.equal(writes, 0);
    assert.equal(writtenTo, "");
    assert.equal(
      (await server.db.get<ActionProposal>("owner", "actions", action.id))?.status,
      "awaiting_review",
    );
    assert.equal(await server.db.get("owner", "mcp-receipts", action.id), null);
  });

test("budget extension preserves concurrently accumulated step and elapsed usage", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask(
    "owner",
    { prompt: "Prepare a report" },
    undefined,
    true,
  );
  await server.db.consumeTaskBudget("owner", task.id, 0);
  let extensionPrepared!: () => void;
  let extensionRelease!: () => void;
  const prepared = new Promise<void>((resolve) => {
    extensionPrepared = resolve;
  });
  const released = new Promise<void>((resolve) => {
    extensionRelease = resolve;
  });
  const mutate = server.db.durableMutation.bind(server.db);
  server.db.durableMutation = async (...args) => {
    if (String(args[1]).startsWith("task-budget:")) {
      extensionPrepared();
      await released;
    }
    return mutate(...args);
  };
  const input = {
    requestId: "extend-during-child-step",
    expectedRevision: 0,
    additionalSteps: 1,
    additionalMilliseconds: 1,
  };
  const extension = server.agent.actor.extendBudget("owner", task.id, input);
  await prepared;
  const beforeCommit = await server.db.consumeTaskBudget<TaskBudget>("owner", task.id, 1234);
  await server.db.chargeTaskBudget("owner", task.id, 456);
  assert.equal(beforeCommit?.usedSteps, 2);
  extensionRelease();
  await extension;
  const after = await server.db.get<TaskBudget>("owner", "task-budgets", task.id);
  assert.equal(after?.usedSteps, 2);
  assert.equal(after?.usedMilliseconds, 1690);
  await server.db.consumeTaskBudget("owner", task.id, 10);
  await server.agent.actor.extendBudget("owner", task.id, input);
  const replayed = await server.db.get<TaskBudget>("owner", "task-budgets", task.id);
  assert.equal(replayed?.maxSteps, 97);
  assert.equal(replayed?.revision, 1);
  assert.equal(replayed?.usedSteps, 3);
  assert.equal(replayed?.usedMilliseconds, 1700);
});

for (const data of [
  { agenda: "Meet at 10:00", costs: "EUR 20", risks: "Rain may delay travel" },
  { agenda: "", costs: "", risks: "", unrelated: "Sunny weather" },
])
  test(`required section values ${data.agenda ? "verify" : "remain unverified when empty"}`, async (t) => {
    await modelFixture(
      t,
      (index) =>
        [
          {
            name: "save_artifact",
            arguments: {
              kind: "report",
              title: "Report",
              summary: "All required sections are present",
              data,
            },
          },
          { name: "finish_task", arguments: { summary: "Agenda, costs and risks are complete" } },
        ][index],
    );
    const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
    const task = await server.agent.createTask("owner", {
      prompt: "Prepare a report with required sections:\n- agenda\n- costs\n- risks",
    });
    await server.agent.worker.tick();
    const saved = await server.agent.getTask("owner", task.id);
    assert.equal(saved.completion?.status, data.agenda ? "verified" : "unverified");
  });

test("current ancestor validity also fences a child approval", async (t) => {
  const server = await taskRuntime(t);
  const parent = await server.agent.createTask(
    "owner",
    {
      prompt: "Prepare the reply",
      timing: { priority: "normal", validUntil: "2099-10-02T10:00:00Z" },
    },
    undefined,
    true,
  );
  const child = await server.agent.createChildTask(
    "owner",
    parent,
    { prompt: "Send an email to wife@example.test" },
    "child-approval",
  );
  const proposal = await server.actions.propose(
    "owner",
    {
      kind: "email.send",
      data: { to: ["wife@example.test"], subject: "Reply", body: "Requested reply" },
    },
    "child-send",
    child.id,
  );
  await server.db.compareAndSwapTask(
    "owner",
    child.id,
    { status: "queued" },
    { status: "waiting_approval", actionId: proposal.id },
  );
  await server.agent.timing.update("owner", parent.id, {
    expectedRevision: 0,
    requestId: "expire-ancestor",
    validUntil: "2000-01-01T00:00:00Z",
  });
  await assert.rejects(
    server.actions.decide("owner", proposal.id, proposal.hash, "approve"),
    /expired/i,
  );
  assert.equal((await server.db.list("owner", "mail")).length, 0);
  assert.equal(
    (await server.db.get<ActionProposal>("owner", "actions", proposal.id))?.status,
    "awaiting_review",
  );
});

test("an already dispatching operation must recheck current authority after a preflight wait", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", { prompt: "Run the requested command" });
  let effects = 0;
  const worker = new TaskWorker(server.db, async (owner, running, ctx) => {
    await server.agent.journal.prepare(owner, {
      id: "preflight-op",
      taskId: task.id,
      revision: 0,
      bindingHash: bindingHash({ command: "echo test" }),
      executorId: "vps",
      executorEpoch: 1,
      resourceFence: 0,
      status: "queued",
      toolName: "run_command",
      args: { command: "echo test" },
      effect: true,
      runToken: String(running.leaseId),
      resourceLeaseIds: [],
      createdAt: new Date().toISOString(),
    });
    await server.agent.journal.authorizeDispatch(owner, "preflight-op", 0, String(running.leaseId));
    await server.agent.mailbox.enqueue(owner, running.id, {
      clientMessageId: "new-command",
      text: "Use the new command",
    });
    await server.agent.actor.apply(owner, running, ctx);
    await assert.rejects(async () => {
      await server.agent.journal.authorizeDispatch(
        owner,
        "preflight-op",
        0,
        String(running.leaseId),
      );
      effects++;
    }, /superseded/i);
    assert.equal(
      (await server.agent.journal.operations(owner, task.id))[0].status,
      "dispatching",
      "existing dispatch evidence must remain available for reconciliation",
    );
    return { status: "waiting_input" };
  });
  t.after(() => worker.stop());
  await worker.tick();
  assert.equal(effects, 0);
});

for (const complete of [false, true])
  test(`required JSON file values ${complete ? "verify" : "cannot be empty"}`, async (t) => {
    const server = await taskRuntime(t);
    const task = await server.agent.createTask("owner", {
      prompt: "Create a file with required fields: agenda, costs, risks",
    });
    const file = await server.files.importAttachment(
      "owner",
      "report.json",
      Buffer.from(
        JSON.stringify(
          complete
            ? { agenda: "Meet at 10:00", costs: "EUR 20", risks: "Delay possible" }
            : { agenda: "", costs: "", risks: "", unrelated: "Weather is sunny" },
        ),
      ),
      "Fixture",
    );
    await server.db.compareAndSwapTask(
      "owner",
      task.id,
      { status: "queued" },
      { artifactIds: [file.id] },
    );
    assert.equal(
      (await server.agent.verification.assess("owner", task.id, 0)).status,
      complete ? "verified" : "unverified",
    );
  });
