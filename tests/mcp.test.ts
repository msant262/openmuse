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
  process.env.OPENMUSE_MCP_TEST_KEY = "private-test-credential";
  const remote = new McpServer({ name: "test", version: "1" });
  remote.registerTool("read_agenda", { inputSchema: { day: z.string() } }, async ({ day }) => ({
    content: [{ type: "text", text: `Agenda ${day}: ${process.env.OPENMUSE_MCP_TEST_KEY}` }],
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
    return { content: [{ type: "text", text: "Receipt 42" }] };
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
      { name: "read_agenda", inputSchema: z.toJSONSchema(z.object({ day: z.string() })) },
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
    process.env.OPENMUSE_MCP_TEST_KEY = "private-test-credential";
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
