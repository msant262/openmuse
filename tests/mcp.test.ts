import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { connectorReviewLines } from "../apps/mobile/src/external-action-preview.ts";
import { ActionService } from "../apps/server/src/actions.ts";
import { createStore } from "../apps/server/src/db.ts";
import { guardedMcpFetch, McpService, parseMcpConfig } from "../apps/server/src/mcp.ts";

test("MCP config denies dynamic executors and requires explicit tool effects; headers cannot cross origins", async () => {
  assert.throws(
    () =>
      parseMcpConfig([
        {
          id: "c",
          url: "https://example.com/mcp",
          tools: { COMPOSIO_MULTI_EXECUTE_TOOL: "write" },
        },
      ]),
    /executor|meta/i,
  );
  assert.throws(
    () => parseMcpConfig([{ id: "c", url: "https://example.com/mcp", tools: { payment: "read" } }]),
    /money|payment/i,
  );
  const guarded = guardedMcpFetch(new URL("https://example.com/mcp"), { Authorization: "SECRET" });
  await assert.rejects(() => guarded("https://evil.com/receive", {}), /origin/);
});

test("official streamable MCP tools honor allowlists, bind money approval and replay writes without redispatch", async () => {
  const db = await createStore();
  let writes = 0,
    schemaChanged = false;
  const previousKey = process.env.OPENMUSE_MCP_TEST_KEY;
  process.env.OPENMUSE_MCP_TEST_KEY = "Bearer private-test-credential";
  const remote = new McpServer({ name: "test", version: "1" });
  remote.registerTool("read_agenda", { inputSchema: { day: z.string() } }, async ({ day }) => ({
    content: [
      {
        type: "text",
        text: `Agenda ${day}: private-test-credential / ${process.env.OPENMUSE_MCP_TEST_KEY}`,
      },
    ],
  }));
  const buySchema = z.object({
    event: z.string(),
    amount: z.number().optional(),
    currency: z.string().optional(),
    recipient: z.string().optional(),
    recipientAccount: z.string().optional(),
    product: z.string().optional(),
    api_key: z.string().optional(),
    auth: z.object({ password: z.string() }).optional(),
    note: z.string().optional(),
  });
  remote.registerTool("buy_ticket", { inputSchema: buySchema }, async () => {
    writes++;
    return {
      content: [
        {
          type: "text",
          text: `Receipt 42 private-test-credential / ${process.env.OPENMUSE_MCP_TEST_KEY}`,
        },
      ],
    };
  });
  remote.registerTool("uncertain_write", { inputSchema: {} }, async () => {
    writes++;
    throw new Error("disconnected after write");
  });
  remote.registerTool("hidden", { inputSchema: {} }, async () => ({
    content: [{ type: "text", text: "hidden" }],
  }));
  // Use the public low-level SDK handler to include names inherited by plain JS objects.
  remote.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "read_agenda",
        description: `Calendar ${process.env.OPENMUSE_MCP_TEST_KEY}`,
        inputSchema: z.toJSONSchema(z.object({ day: z.string() })),
      },
      {
        name: "buy_ticket",
        inputSchema: z.toJSONSchema(
          schemaChanged ? buySchema.extend({ coupon: z.string().optional() }) : buySchema,
        ),
      },
      ...["uncertain_write", "hidden", "toString", "constructor"].map((name) => ({
        name,
        inputSchema: { type: "object" as const, properties: {} },
      })),
    ],
  }));
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
  const actions = new ActionService(db, {
    policy: "money",
    connected: async () => true,
    execute: async () => "unused",
  });
  const mcp = new McpService(
    db,
    actions,
    parseMcpConfig([
      {
        id: "apps",
        url: `http://127.0.0.1:${address.port}/mcp`,
        account: "wife",
        headerEnv: { "x-private-fixture": "OPENMUSE_MCP_TEST_KEY" },
        tools: { read_agenda: "read", buy_ticket: "money", uncertain_write: "write" },
      },
    ]),
  );
  try {
    const tools = await mcp.tools("wife", "chat:one");
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "mcp_apps_buy_ticket",
      "mcp_apps_read_agenda",
      "mcp_apps_uncertain_write",
    ]);
    const buy = tools.find((t) => t.name.endsWith("buy_ticket"));
    assert(!tools.some((tool) => tool.description.includes("private-test-credential")));
    assert(
      !JSON.stringify(await db.list("wife", "mcp-catalogues")).includes("private-test-credential"),
    );
    assert.ok(buy?.execute);
    const intent = {
      event: "Music",
      amount: 42,
      currency: "EUR",
      recipient: "Ticket shop",
      recipientAccount: "DE123456789",
      product: "Concert ticket",
      api_key: "argument-api-secret",
      auth: { password: "argument-password" },
      note: "Account auth private-test-credential",
    };
    const review = (await buy.execute(intent)) as {
      actionId: string;
      approvalRequired: boolean;
    };
    assert.equal(review.approvalRequired, true);
    assert.equal(writes, 0);
    const proposal = await db.get<{ hash: string; data: Record<string, unknown> }>(
      "wife",
      "actions",
      review.actionId,
    );
    assert.ok(proposal);
    const preview = connectorReviewLines(proposal.data)
      .map((line) => `${line.label}: ${line.value}`)
      .join("\n");
    assert.match(preview, /42/);
    assert.match(preview, /EUR/);
    assert.match(preview, /Ticket shop/);
    assert.match(preview, /DE123456789/);
    assert.match(preview, /Concert ticket/);
    assert.ok(!preview.includes("argument-api-secret"));
    assert.ok(!preview.includes("argument-password"));
    assert.ok(!preview.includes("private-test-credential"));
    await actions.decide("wife", review.actionId, proposal.hash, "approve");
    const result = await buy.execute(intent);
    assert.ok(JSON.stringify(result).includes("Receipt 42"));
    assert.ok(!JSON.stringify(result).includes("private-test-credential"));
    assert.ok(
      !JSON.stringify(await db.list("wife", "mcp-receipts")).includes("private-test-credential"),
    );
    assert.equal(writes, 1);
    assert.equal(
      (await db.actionLog("wife")).entries.filter((e) => e.result === "succeeded").length,
      1,
    );
    assert.equal((await db.actionLog("other")).entries.length, 0);
    const read = tools.find((t) => t.name.endsWith("read_agenda"));
    assert.ok(read?.execute);
    const agenda = await read.execute({ day: "Monday" });
    assert.match(JSON.stringify(agenda), /Agenda Monday/);
    assert.ok(!JSON.stringify(agenda).includes("private-test-credential"));
    const oversized = await read.execute({ day: `x${"private-test-credential".repeat(3000)}` });
    assert.ok(!JSON.stringify(oversized).includes("private-test-credential"));
    assert.ok(!JSON.stringify(oversized).includes("private-test-cred"));
    const buyAgain = (await mcp.tools("wife", "chat:two")).find((t) =>
      t.name.endsWith("buy_ticket"),
    );
    assert.ok(buyAgain?.execute);
    const review2 = (await buyAgain.execute({ event: "Music" })) as { actionId: string };
    const proposal2 = await db.get<{ hash: string }>("wife", "actions", review2.actionId);
    assert.ok(proposal2);
    mcp.servers[0].account = "changed-account";
    assert.equal(
      (await actions.decide("wife", review2.actionId, proposal2.hash, "approve")).status,
      "failed",
    );
    assert.equal(writes, 1);
    mcp.servers[0].account = "wife";
    const forSchema = (await mcp.tools("wife", "chat:schema")).find((t) =>
      t.name.endsWith("buy_ticket"),
    );
    assert.ok(forSchema?.execute);
    const schemaReview = (await forSchema.execute({ event: "Music" })) as { actionId: string };
    const schemaProposal = await db.get<{ hash: string }>("wife", "actions", schemaReview.actionId);
    assert.ok(schemaProposal);
    schemaChanged = true;
    assert.equal(
      (await actions.decide("wife", schemaReview.actionId, schemaProposal.hash, "approve")).status,
      "failed",
    );
    const freshSchema = (await mcp.tools("wife", "chat:fresh-schema")).find((t) =>
      t.name.endsWith("buy_ticket"),
    );
    assert.ok(freshSchema);
    assert.equal(
      (
        (freshSchema.parameters as z.ZodType).parse({ event: "Music", coupon: "SAVE" }) as {
          coupon: string;
        }
      ).coupon,
      "SAVE",
    );
    const buyRotated = (await mcp.tools("wife", "chat:rotated")).find((t) =>
      t.name.endsWith("buy_ticket"),
    );
    assert.ok(buyRotated?.execute);
    const review3 = (await buyRotated.execute({ event: "Music" })) as { actionId: string };
    const proposal3 = await db.get<{ hash: string }>("wife", "actions", review3.actionId);
    assert.ok(proposal3);
    process.env.OPENMUSE_MCP_TEST_KEY = "rotated-test-credential";
    assert.equal(
      (await actions.decide("wife", review3.actionId, proposal3.hash, "approve")).status,
      "failed",
    );
    assert.equal(writes, 1);
    process.env.OPENMUSE_MCP_TEST_KEY = "Bearer private-test-credential";
    const uncertain = tools.find((t) => t.name.endsWith("uncertain_write"));
    assert.ok(uncertain?.execute);
    const first = (await uncertain.execute({})) as { status: string };
    assert.equal(first.status, "outcome_unknown");
    assert.equal(((await uncertain.execute({})) as { status: string }).status, "outcome_unknown");
    assert.equal(writes, 2);
  } finally {
    await mcp.close();
    await remote.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await db.close();
    if (previousKey === undefined) delete process.env.OPENMUSE_MCP_TEST_KEY;
    else process.env.OPENMUSE_MCP_TEST_KEY = previousKey;
  }
});

test("official legacy SSE transport exposes only configured tools and executes validated reads", async () => {
  const db = await createStore();
  const remote = new McpServer({ name: "legacy", version: "1" });
  remote.registerTool("agenda", { inputSchema: { day: z.string() } }, async ({ day }) => ({
    content: [{ type: "text", text: `Agenda ${day}` }],
  }));
  let transport: SSEServerTransport;
  const http = createServer(async (req, res) => {
    if (req.method === "GET") {
      transport = new SSEServerTransport("/messages", res);
      await remote.connect(transport);
    } else {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      await transport.handlePostMessage(req, res, JSON.parse(Buffer.concat(chunks).toString()));
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const actions = new ActionService(db, {
    policy: "money",
    connected: async () => true,
    execute: async () => "unused",
  });
  const mcp = new McpService(
    db,
    actions,
    parseMcpConfig([
      {
        id: "legacy",
        url: `http://127.0.0.1:${address.port}/sse`,
        transport: "sse",
        tools: { agenda: "read" },
      },
    ]),
  );
  try {
    const tools = await mcp.tools("wife", "chat:legacy");
    assert.equal(tools[0].name, "mcp_legacy_agenda");
    const execute = tools[0].execute;
    assert.ok(execute);
    await assert.rejects(() => execute({ day: 42 }));
    assert.ok(JSON.stringify(await execute({ day: "Monday" })).includes("Agenda Monday"));
    assert.equal(
      (await db.actionLog("wife")).entries.filter((e) => e.result === "succeeded").length,
      1,
    );
  } finally {
    await mcp.close();
    await remote.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await db.close();
  }
});

test("native approved MCP calls remain tracked through success and interrupted receipt persistence", {
  timeout: 20000,
}, async (t) => {
  for (const interrupted of [false, true]) {
    await t.test(
      interrupted ? "unknown receipt after abort" : "success receipt after dispatch",
      async (t) => {
        const db = await createStore();
        const remote = new McpServer({ name: "native-close", version: "1" });
        let dispatches = 0,
          releaseRemote!: () => void,
          releaseReceipt!: () => void,
          receiptBegan!: () => void;
        const remoteGate = new Promise<void>((resolve) => {
          releaseRemote = resolve;
        });
        const receiptGate = new Promise<void>((resolve) => {
          releaseReceipt = resolve;
        });
        const receiptStarted = new Promise<void>((resolve) => {
          receiptBegan = resolve;
        });
        remote.registerTool("buy_ticket", { inputSchema: {} }, async () => {
          dispatches++;
          if (interrupted) await remoteGate;
          return { content: [{ type: "text", text: "Receipt" }] };
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
        const actions = new ActionService(db, {
          policy: "money",
          connected: async () => true,
          execute: async () => "unused",
        });
        const mcp = new McpService(
          db,
          actions,
          parseMcpConfig([
            {
              id: "apps",
              url: `http://127.0.0.1:${address.port}/mcp`,
              tools: { buy_ticket: "money" },
            },
          ]),
        );
        const put = db.put.bind(db);
        t.mock.method(
          db,
          "put",
          async <T extends { id: string }>(owner: string, kind: string, value: T): Promise<T> => {
            if (kind === "mcp-receipts") {
              receiptBegan();
              await receiptGate;
            }
            return put(owner, kind, value);
          },
        );
        let closing: Promise<void> | undefined;
        let approval: ReturnType<ActionService["decide"]> | undefined;
        try {
          const buy = (await mcp.tools("wife", "native-close")).find((tool) =>
            tool.name.endsWith("buy_ticket"),
          );
          assert.ok(buy?.execute);
          const review = (await buy.execute({})) as { actionId: string };
          const proposal = await db.get<{ hash: string }>("wife", "actions", review.actionId);
          assert.ok(proposal);
          // Native approval executes later, after the model tool has returned.
          approval = actions.decide("wife", review.actionId, proposal.hash, "approve");
          if (interrupted) {
            while (!dispatches) await new Promise((resolve) => setTimeout(resolve, 5));
            closing = mcp.close();
          }
          await receiptStarted;
          closing ??= mcp.close();
          let closed = false;
          void closing.then(() => {
            closed = true;
          });
          await new Promise((resolve) => setTimeout(resolve, 20));
          assert.equal(
            closed,
            false,
            "close must wait for the native executor's receipt persistence",
          );
          assert.equal(await db.get("wife", "mcp-receipts", review.actionId), null);
          releaseReceipt();
          const action = await approval;
          await closing;
          assert.equal(action.status, interrupted ? "outcome_unknown" : "succeeded");
          assert.equal(
            (await db.get("wife", "mcp-receipts", review.actionId))?.status,
            interrupted ? "outcome_unknown" : "succeeded",
          );
          assert.equal(
            (await actions.decide("wife", review.actionId, proposal.hash, "approve")).status,
            action.status,
          );
          assert.equal(dispatches, 1, "an interrupted native write is never re-dispatched");
        } finally {
          releaseReceipt();
          releaseRemote();
          await approval;
          await closing;
          await mcp.close();
          await remote.close();
          await new Promise<void>((resolve) => http.close(() => resolve()));
          await db.close();
        }
      },
    );
  }
});

test("MCP descriptions survive transient discovery failure while newer generations and revocation fence execution", async (t) => {
  const db = await createStore();
  const remote = new McpServer({ name: "catalogue-fixture", version: "1" });
  let calls = 0;
  remote.registerTool("read_item", { inputSchema: {} }, async () => {
    calls++;
    return { content: [{ type: "text", text: "read" }] };
  });
  let failure = false;
  let description = "original";
  let blockNext = false;
  let blocked!: () => void;
  let release!: () => void;
  const observed = new Promise<void>((resolve) => {
    blocked = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  remote.server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (failure) throw new Error("temporary unavailable");
    const captured = description;
    if (blockNext) {
      blockNext = false;
      blocked();
      await gate;
    }
    return {
      tools: [
        {
          name: "read_item",
          description: captured,
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };
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
  const servers = parseMcpConfig([
    { id: "apps", url: `http://127.0.0.1:${address.port}/mcp`, tools: { read_item: "read" } },
  ]);
  const actions = new ActionService(db, {
    policy: "money",
    connected: async () => true,
    execute: async () => "unused",
  });
  const service = new McpService(db, actions, servers);
  t.after(async () => {
    release();
    await service.close();
    await remote.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await db.close();
  });
  await service.tools("owner", "first");
  description = "stale response";
  blockNext = true;
  const older = service.tools("owner", "older");
  await observed;
  description = "new generation";
  const newer = await service.tools("owner", "newer");
  release();
  const late = await older;
  assert.match(newer[0].description, /new generation/);
  assert.match(late[0].description, /new generation/);
  failure = true;
  const cached = await service.tools("owner", "outage");
  assert.match(cached[0].description, /new generation/);
  await assert.rejects(cached[0].execute!({}), /catalogue|unavailable/);
  assert.equal(calls, 0);
  failure = false;
  const guarded = await service.tools("owner", "revoke", {
    before: async () => {
      if (calls === -1) servers[0].tools = {};
      else calls = -1;
    },
  });
  await assert.rejects(guarded[0].execute!({}), /configuration changed/);
  assert.equal(calls, -1, "revocation after awaited discovery prevents the remote read");
  assert.deepEqual(await service.tools("owner", "revoked"), []);
});

test("MCP revocation after the dispatch barrier remains known not sent", async () => {
  const db = await createStore();
  let handler: (...args: any[]) => Promise<unknown> = async () => {};
  let calls = 0;
  const actions = {
    registerExternal: (_: string, value: typeof handler) => {
      handler = value;
    },
  };
  const [server] = parseMcpConfig([
    { id: "review", url: "https://example.invalid/mcp", tools: { update_note: "write" } },
  ]);
  const service = new McpService(db, actions as unknown as ActionService, [server]);
  const fixture = service as any;
  const connection = {
    client: {
      callTool: async () => {
        calls++;
        return {};
      },
    },
    configFingerprint: fixture.fingerprint(server),
  };
  fixture.bound = async () => ({ server, connection });
  try {
    await assert.rejects(
      handler(
        "owner",
        { tool: "update_note", args: {} },
        { id: "action", hash: "fixture" },
        async () => {
          server.tools = {};
        },
      ),
      /configuration changed/,
    );
    assert.equal(calls, 0);
    assert.equal(await db.get("owner", "mcp-receipts", "action"), null);
  } finally {
    await service.close();
    await db.close();
  }
});

test("MCP catalogue revocation during persistent cache awaits cannot expose stale tools", async (t) => {
  for (const barrier of ["read", "insert", "replace"] as const)
    await t.test(barrier, async () => {
      const db = await createStore();
      const [server] = parseMcpConfig([
        { id: "review", url: "https://example.invalid/mcp", tools: { read_note: "read" } },
      ]);
      const service = new McpService(db, { registerExternal() {} } as unknown as ActionService, [
        server,
      ]);
      const fixture = service as any;
      fixture.connection = async () => ({ client: {} });
      fixture.listAllowed = async () => [
        { name: "read_note", inputSchema: { type: "object", properties: {} } },
      ];
      if (barrier === "replace") await service.tools("owner", "initial");
      const operation =
        barrier === "read" ? "get" : barrier === "insert" ? "insertIfAbsent" : "compareAndSwap";
      const original = (db[operation] as Function).bind(db);
      (db as any)[operation] = async (...args: any[]) => {
        const value = await original(...args);
        if (args[1] === "mcp-catalogues") server.tools = {};
        return value;
      };
      try {
        const definitions = await service.tools("owner", "revoked");
        assert(!definitions.some((tool) => tool.name === "mcp_review_read_note"));
        if (barrier === "read")
          assert.equal(await db.get("owner", "mcp-catalogues", "review"), null);
        assert.deepEqual(await service.tools("owner", "after-revocation"), []);
      } finally {
        await service.close();
        await db.close();
      }
    });
});
