import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { type TestContext, test } from "node:test";
import { taskCriteria } from "../apps/server/src/engine/task-verification.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";
import { GoogleClient } from "../packages/integrations/src/google.ts";
import { GoogleWorkspaceCatalog } from "../packages/integrations/src/google-workspace-catalog.ts";
import { encryptSecret } from "../packages/integrations/src/vault.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

async function fixture(t: TestContext, ignoreWrite = false, count = 3) {
  const encryptionKey = randomBytes(32).toString("base64");
  const server = await taskRuntime(t, { mode: "live", encryptionKey, approvalPolicy: "money" });
  await server.db.put("owner", "credentials", {
    id: "google",
    connectionId: "gmail-test",
    secret: encryptSecret(
      JSON.stringify({
        connectionId: "gmail-test",
        account: "test@example.com",
        accessToken: "fixture",
        refreshToken: "fixture",
        expiresAt: Date.now() + 3600000,
        scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      }),
      encryptionKey,
    ),
  });
  const messages = new Map(
    Array.from({ length: count }, (_, i) => [
      `m${i}`,
      {
        id: `m${i}`,
        threadId: `t${i}`,
        labelIds: ["INBOX"],
        payload: { headers: [{ name: "Subject", value: `Own test ${i}` }] },
      },
    ]),
  );
  const labels = [{ id: "Label_1", name: "Promoções", type: "user" }];
  const writes: Request[] = [];
  t.mock.method(
    server.workspace,
    "google",
    (_o: string, _c?: string, signal?: AbortSignal, beforeWrite?: () => Promise<void>) =>
      new GoogleClient({
        signal,
        beforeWrite,
        getAccessToken: async () => "fixture",
        fetch: async (url, init) => {
          const request = new Request(url, init),
            path = new URL(request.url).pathname;
          if (path.endsWith("/labels")) return Response.json({ labels });
          if (request.method === "GET" && path.endsWith("/messages")) {
            const offset = Number(new URL(request.url).searchParams.get("pageToken") ?? 0),
              size = 2;
            return Response.json({
              messages: [...messages.values()]
                .slice(offset, offset + size)
                .map(({ id, threadId }) => ({ id, threadId })),
              ...(offset + size < messages.size ? { nextPageToken: String(offset + size) } : {}),
              resultSizeEstimate: messages.size,
            });
          }
          if (request.method === "GET") {
            const message = messages.get(path.split("/").at(-1) ?? "");
            return message
              ? Response.json(message)
              : Response.json({ error: { message: "Not found" } }, { status: 404 });
          }
          writes.push(request);
          const body = JSON.parse(await request.text());
          if (!ignoreWrite)
            for (const id of body.ids ?? [path.split("/").at(-2)]) {
              const message = messages.get(id);
              if (message)
                message.labelIds = [
                  ...new Set([
                    ...message.labelIds.filter((x) => !(body.removeLabelIds ?? []).includes(x)),
                    ...(body.addLabelIds ?? []),
                  ]),
                ];
            }
          return Response.json({}); // Gmail batchModify really returns an empty success body.
        },
      }),
  );
  return { ...server, messages, writes };
}

test("ordinary Gmail cleanup requests require confirmed mailbox changes rather than a search", () => {
  for (const prompt of [
    "Organiza e limpa meus emails",
    "Acabei de conectar dois caixas de email aqui. Consegue começar a limpa pela test@example.com?",
    "Tudo que for de promoção coloca numa caixa separada que não seja a principal",
    "Aplica o marcador Promoções nesses e-mails",
    "Move these emails into the folder Promotions",
  ])
    assert.ok(
      taskCriteria({ kind: "agent", prompt }).some((c) => c.effect === "email.organize"),
      prompt,
    );
  assert.ok(
    !taskCriteria({ kind: "agent", prompt: "Busca meus emails sobre a viagem" }).some(
      (c) => c.effect === "email.organize",
    ),
  );
});

test("archive and label removal preserve mail; TRASH via modify still requires human approval", () => {
  const catalog = new GoogleWorkspaceCatalog();
  assert.equal(
    catalog.destructive("gmail.users.messages.batchModify", {
      removeLabelIds: ["INBOX"],
      addLabelIds: ["Label_1"],
    }),
    false,
  );
  assert.equal(
    catalog.destructive("gmail.users.messages.modify", { addLabelIds: ["TRASH"] }),
    true,
  );
});

test("an empty Gmail success response cannot verify changes Google did not apply", async (t) => {
  const server = await fixture(t, true);
  const result = await server.agent.googleWorkspace.execute("owner", {
    toolId: "gmail.users.messages.batchModify",
    account: "test@example.com",
    parameters: {},
    body: { ids: ["m0"], addLabelIds: ["Label_1"] },
    operationId: "ignored-label",
  });
  assert.notEqual(result.status, "succeeded");
  assert.equal(server.messages.get("m0")!.labelIds.includes("Label_1"), false);
});

test("organization receipts contain exact verified message counts, labels and titles", async (t) => {
  const server = await fixture(t);
  const result = (await server.agent.googleWorkspace.execute("owner", {
    toolId: "gmail.users.messages.batchModify",
    account: "test@example.com",
    parameters: {},
    body: { ids: ["m0", "m1"], addLabelIds: ["Label_1"], removeLabelIds: ["INBOX"] },
    operationId: "archive-label",
  })) as any;
  assert.equal(result.status, "succeeded");
  assert.equal(result.mailChange.verified, true);
  assert.equal(result.mailChange.processed, 2);
  assert.equal(result.mailChange.archived, 2);
  assert.deepEqual(result.mailChange.labelNames, ["Promoções"]);
  assert.equal(result.mailChange.messages[0].subject, "Own test 0");
  assert.deepEqual(server.messages.get("m0")!.labelIds, ["Label_1"]);
});

test("creating a label alone cannot complete moving emails into it", async (t) => {
  const server = await fixture(t);
  const task = await server.agent.createTask("owner", {
    prompt: "Organiza os emails em uma pasta Promoções",
  });
  assert.equal((await server.agent.verification.assess("owner", task.id, 0)).status, "unverified");
});

test("mail organization freezes all search pages, applies the label and archives every match without duplicate writes", async (t) => {
  const server = await fixture(t, false, 5);
  const input = {
    account: "test@example.com",
    query: "in:inbox category:promotions",
    labelNames: ["Promoções"],
    archive: true,
    operationId: "all-promotions",
  };
  const result = (await server.agent.googleWorkspace.organize("owner", input)) as any;
  assert.equal(result.status, "succeeded");
  assert.equal(result.matched, 5);
  assert.equal(result.processed, 5);
  assert.equal(result.remaining, 0);
  for (const message of server.messages.values()) assert.deepEqual(message.labelIds, ["Label_1"]);
  const count = server.writes.length;
  const replay = (await server.agent.googleWorkspace.organize("owner", input)) as any;
  assert.equal(replay.processed, 5);
  assert.deepEqual(replay.messages, result.messages);
  assert.equal(server.writes.length, count);
});

test("archiving the last label accepts Gmail's omitted empty labelIds array", async (t) => {
  const server = await fixture(t);
  const original = server.workspace.google.bind(server.workspace);
  t.mock.method(server.workspace, "google", (...args: Parameters<typeof original>) => {
    const client = original(...args);
    const request = client.workspaceRequest.bind(client);
    t.mock.method(client, "workspaceRequest", async (...args: Parameters<typeof request>) => {
      const data = (await request(...args)) as any;
      if (data?.id && Array.isArray(data.labelIds) && !data.labelIds.length) {
        const { labelIds: _empty, ...rest } = data;
        return rest;
      }
      return data;
    });
    return client;
  });
  const result = await server.agent.googleWorkspace.execute("owner", {
    toolId: "gmail.users.messages.modify",
    account: "test@example.com",
    parameters: { id: "m0" },
    body: { removeLabelIds: ["INBOX"] },
    operationId: "empty-labels",
  });
  assert.equal(result.status, "succeeded");
});

test("every frozen batch is required before a mailbox organization task is verified", async (t) => {
  const server = await fixture(t, false, 205);
  const task = await server.agent.createTask("owner", {
    prompt: "Organiza os emails em uma pasta Promoções e tira da caixa de entrada",
  });
  const worker = new TaskWorker(server.db, async (owner, running) => {
    const read = {
      toolId: "gmail.users.messages.list",
      account: "test@example.com",
      parameters: {},
      operationId: "read-only",
    };
    await server.agent.journal.run(
      owner,
      running,
      { id: "mail-read", name: "execute_google_workspace_tool", args: read },
      () => server.agent.googleWorkspace.execute(owner, read, { taskId: running.id }),
      false,
    );
    assert.notEqual(
      (await server.agent.verification.assess(owner, running.id, 0)).status,
      "verified",
    );
    const result = await server.agent.googleWorkspace.organize(
      owner,
      {
        account: "test@example.com",
        query: "in:inbox",
        labelNames: ["Promoções"],
        archive: true,
        operationId: "all-batches",
      },
      { taskId: running.id },
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.processed, 205);
    assert.equal(server.writes.length, 3);
    assert.equal((await server.agent.verification.assess(owner, running.id, 0)).status, "verified");
    return { status: "succeeded", result: "205 e-mails organizados e conferidos" };
  });
  await worker.tick();
  await worker.stop();
  assert.equal((await server.agent.getTask("owner", task.id)).status, "succeeded");
});

test("a completed Gmail organization delivers its verified report automatically", async (t) => {
  const server = await fixture(t);
  const reports: Record<string, unknown>[] = [];
  const result = await server.agent.googleWorkspace.organize(
    "owner",
    {
      account: "test@example.com",
      query: "in:inbox",
      labelNames: ["Promoções"],
      archive: true,
      operationId: "automatic-report",
    },
    {
      mailReport: async (report) => {
        reports.push(report);
      },
    },
  );
  assert.equal(result.status, "succeeded");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].processed, 3);
  assert.equal((reports[0].messages as { subject: string }[])[0].subject, "Own test 0");
});

test("listing Gmail labels or creating an empty folder never invents an obligation to move email", () => {
  for (const prompt of [
    "Lista os marcadores do Gmail",
    "Mostra as pastas do meu email",
    "Crie uma pasta no Gmail chamada Viagem",
  ])
    assert.ok(
      !taskCriteria({ kind: "agent", prompt }).some((c) => c.effect === "email.organize"),
      prompt,
    );
});

test("creating a file and sending it by email never implies organizing the mailbox", () => {
  const criteria = taskCriteria({
    kind: "agent",
    prompt: "Crie um arquivo TXT com a agenda e envie por email para wife@example.test",
  });
  assert.ok(!criteria.some((c) => c.effect === "email.organize"));
  assert.ok(criteria.some((c) => c.effect === "email.send"));
});

test("slow replay of confirmed batches still advances the next organization continuation", async (t) => {
  const server = await fixture(t, false, 205);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const originalPut = server.db.put.bind(server.db);
  server.db.put = (async (owner, kind, value) => {
    const saved = await originalPut(owner, kind, value);
    if (
      kind === "google-workspace-receipts" &&
      "result" in value &&
      (value.result as { mailChange?: unknown }).mailChange
    )
      t.mock.timers.tick(21_000);
    return saved;
  }) as typeof server.db.put;
  const input = {
    account: "test@example.com",
    query: "in:inbox",
    labelNames: ["Promoções"],
    archive: true,
    operationId: "slow-continuation",
  };
  const first = await server.agent.googleWorkspace.organize("owner", input);
  assert.equal(first.processed, 100);
  const originalGet = server.db.get.bind(server.db);
  let slowReplay = true;
  server.db.get = (async (owner, kind, id) => {
    const value = await originalGet(owner, kind, id);
    if (
      slowReplay &&
      kind === "actions" &&
      (value as ActionProposal | null)?.status === "succeeded"
    ) {
      slowReplay = false;
      t.mock.timers.tick(21_000);
    }
    return value;
  }) as typeof server.db.get;
  const second = await server.agent.googleWorkspace.organize("owner", {
    ...input,
    cursor: first.cursor,
  });
  assert.equal(second.processed, 200, "replayed batches cannot consume the entire continuation");
  slowReplay = true;
  const last = await server.agent.googleWorkspace.organize("owner", {
    ...input,
    cursor: second.cursor,
  });
  assert.equal(last.status, "succeeded");
  assert.equal(last.processed, 205);
  assert.equal(server.writes.length, 3, "no confirmed batch is submitted twice");
});

test("deleting mail requires a verified destructive receipt and a real approval before dispatch", async (t) => {
  const server = await fixture(t);
  const task = await server.agent.createTask("owner", {
    prompt: "Apaga o email Own test 0 do Gmail",
  });
  assert.equal(task.criteria?.[0].effect, "email.delete");
  let actionId = "";
  const worker = new TaskWorker(server.db, async (owner, running) => {
    const result = await server.agent.googleWorkspace.execute(
      owner,
      {
        toolId: "gmail.users.messages.modify",
        account: "test@example.com",
        parameters: { id: "m0" },
        body: { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
        operationId: "approved-trash",
      },
      { taskId: running.id },
    );
    assert.equal(result.status, "awaiting_review");
    assert.equal(server.writes.length, 0);
    actionId = result.actionId;
    return { status: "waiting_approval", actionId };
  });
  await worker.tick();
  await worker.stop();
  assert.notEqual((await server.agent.verification.assess("owner", task.id, 0)).status, "verified");
  const action = await server.db.get<ActionProposal>("owner", "actions", actionId);
  assert.ok(action);
  const approved = await server.actions.decide("owner", action.id, action.hash, "approve");
  assert.equal(approved.status, "succeeded");
  assert.deepEqual(server.messages.get("m0")?.labelIds, ["TRASH"]);
  assert.equal((await server.agent.verification.assess("owner", task.id, 0)).status, "verified");
});

test("after approved mail deletion the delivered summary states the confirmed effect instead of stale preparation text", async (t) => {
  const server = await fixture(t);
  const task = await server.agent.createTask("owner", {
    prompt: "Apaga os emails Own test do Gmail",
  });
  const worker = new TaskWorker(server.db, async (owner, running, context) => {
    if (running.actionId)
      return server.agent.finish(
        running,
        context,
        "Preparei a exclusão. Só serão movidos após aprovação.",
        owner,
      );
    const result = await server.agent.googleWorkspace.execute(
      owner,
      {
        toolId: "gmail.users.messages.batchModify",
        account: "test@example.com",
        parameters: {},
        body: { ids: ["m0", "m1"], addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
        operationId: "summary-trash",
      },
      { taskId: running.id },
    );
    return { status: "waiting_approval", actionId: result.actionId };
  });
  await worker.tick();
  const pending = await server.agent.getTask("owner", task.id);
  const action = await server.db.get<ActionProposal>("owner", "actions", pending.actionId!);
  assert.ok(action);
  await server.actions.decide("owner", action.id, action.hash, "approve");
  await worker.tick();
  await worker.stop();
  const completed = await server.agent.getTask("owner", task.id);
  assert.equal(completed.status, "succeeded");
  assert.match(completed.result ?? "", /2.*(?:Lixeira|trash)/i);
  assert.match(completed.result ?? "", /test@example.com/);
  assert.match(completed.result ?? "", /Own test 0/);
  assert.doesNotMatch(completed.result ?? "", /Preparei|após aprovação/);
  assert.equal(server.writes.length, 1);
});
