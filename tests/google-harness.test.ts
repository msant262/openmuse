import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { GoogleClient } from "../packages/integrations/src/google.ts";
import { encryptSecret } from "../packages/integrations/src/vault.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("a worker discovers native Gmail and reads the requested account without a browser credential", async (t) => {
  const fixture = await modelFixture(t, (index) => {
    if (index === 0) {
      const body = JSON.parse(fixture.requests[index].body);
      assert.ok(body.tools.some((tool: { name: string }) => tool.name === "list_google_accounts"));
      assert.match(body.instructions, /work@example.com/);
      assert.match(body.instructions, /server.managed|managed by the server/i);
      assert.doesNotMatch(
        fixture.requests[index].body,
        /private-google-access|private-google-refresh/,
      );
      return { name: "list_google_accounts", arguments: {} };
    }
    if (index === 1)
      return { name: "search_mail", arguments: { query: "in:inbox", account: "work@example.com" } };
    if (index === 2)
      return {
        name: "read_mail_thread",
        arguments: { threadId: "work-thread", account: "work@example.com" },
      };
    return {
      name: "finish_task",
      arguments: {
        outcome: "completed",
        summary: "A conta corporativa tem o relatório solicitado: Relatório corporativo.",
      },
    };
  });
  const encryptionKey = randomBytes(32).toString("base64");
  const server = await taskRuntime(t, {
    mode: "live",
    agentBackend: "model",
    model: "openai/fixture",
    encryptionKey,
  });
  await server.db.put("owner", "credentials", {
    id: "google",
    connectionId: "work-google",
    secret: encryptSecret(
      JSON.stringify({
        connectionId: "work-google",
        account: "work@example.com",
        accessToken: "private-google-access",
        refreshToken: "private-google-refresh",
        expiresAt: Date.now() + 3600000,
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      }),
      encryptionKey,
    ),
  });
  const reads: string[] = [];
  t.mock.method(server.workspace, "google", (_owner: string, connectionId?: string) => {
    assert.equal(connectionId, "work-google");
    const mail = {
      id: "work-message",
      threadId: "work-thread",
      sender: "reports@example.com",
      subject: "Relatório",
      body: "Relatório corporativo",
      date: new Date().toISOString(),
      attachments: [],
      label: "Inbox",
    };
    return {
      listMail: async (query: string) => {
        reads.push(query);
        return [mail];
      },
      getThread: async (id: string) => {
        reads.push(id);
        return [mail];
      },
    };
  });
  const task = await server.agent.createTask("owner", {
    prompt: "Leia a mensagem do Gmail da conta work@example.com.",
  });
  await server.agent.worker.tick();
  const finished = await server.agent.getTask("owner", task.id);
  const direct = JSON.parse(fixture.requests[0].body).tools.map(
    (tool: { name: string }) => tool.name,
  );
  for (const name of [
    "search_google_workspace_tools",
    "describe_google_workspace_tool",
    "execute_google_workspace_tool",
  ])
    assert.ok(direct.includes(name), `${name} is available directly for Google work`);
  assert.ok(
    !direct.includes("docs.documents.create"),
    "the full 206-method catalog remains deferred",
  );
  assert.equal(
    finished.status,
    "succeeded",
    JSON.stringify({
      error: finished.error,
      completion: finished.completion,
      reads,
      calls: (await server.agent.journal.operations("owner", task.id)).map((o) => ({
        tool: o.toolName,
        status: o.status,
        receipt: o.receipt,
      })),
    }),
  );
  assert.deepEqual(reads, ["in:inbox", "work-thread"]);
  assert.doesNotMatch(
    fixture.requests.map((r) => r.body).join("\n"),
    /private-google-access|private-google-refresh/,
  );
});

test("the copied worker discovers Google Workspace, creates and edits a remote Doc and verifies its native receipts", async (t) => {
  const steps = [
    {
      name: "search_google_workspace_tools",
      arguments: { query: "docs.documents.create", service: "docs" },
    },
    { name: "describe_google_workspace_tool", arguments: { toolId: "docs.documents.create" } },
    {
      name: "execute_google_workspace_tool",
      arguments: {
        toolId: "docs.documents.create",
        body: { title: "Teste Docs" },
        operationId: "create-doc",
      },
    },
    {
      name: "execute_google_workspace_tool",
      arguments: {
        toolId: "docs.documents.batchUpdate",
        parameters: { documentId: "doc-google-id" },
        body: {
          requests: [{ insertText: { location: { index: 1 }, text: "Integração funcionando." } }],
        },
        operationId: "edit-doc",
      },
    },
    {
      name: "execute_google_workspace_tool",
      arguments: {
        toolId: "docs.documents.get",
        parameters: { documentId: "doc-google-id" },
        operationId: "read-doc",
      },
    },
    {
      name: "finish_task",
      arguments: {
        outcome: "completed",
        summary:
          "Documento criado no Google Docs, editado e lido: https://docs.google.com/document/d/doc-google-id/edit",
      },
    },
  ];
  const fixture = await modelFixture(t, (index) => steps[index] ?? steps.at(-1)!);
  const encryptionKey = randomBytes(32).toString("base64");
  const server = await taskRuntime(t, {
    mode: "live",
    agentBackend: "model",
    model: "openai/fixture",
    encryptionKey,
    approvalPolicy: "money",
  });
  await server.db.put("owner", "credentials", {
    id: "google",
    connectionId: "docs-google",
    secret: encryptSecret(
      JSON.stringify({
        connectionId: "docs-google",
        account: "work@example.com",
        accessToken: "private-google-access",
        refreshToken: "private-google-refresh",
        expiresAt: Date.now() + 3600000,
        scopes: ["https://www.googleapis.com/auth/drive"],
      }),
      encryptionKey,
    ),
  });
  const requests: Request[] = [];
  t.mock.method(
    server.workspace,
    "google",
    (
      _owner: string,
      connectionId?: string,
      signal?: AbortSignal,
      beforeWrite?: () => Promise<void>,
    ) => {
      assert.equal(connectionId, "docs-google");
      return new GoogleClient({
        signal,
        beforeWrite,
        getAccessToken: async () => "fixture",
        fetch: async (url, init) => {
          requests.push(new Request(url, init));
          return Response.json({
            documentId: "doc-google-id",
            title: "Teste Docs",
            body: {
              content: [
                { paragraph: { elements: [{ textRun: { content: "Integração funcionando." } }] } },
              ],
            },
          });
        },
      });
    },
  );
  const task = await server.agent.createTask("owner", {
    prompt:
      "Crie um documento no Google Docs com o texto Integração funcionando. Edite e confira o documento salvo.",
  });
  await server.agent.worker.tick();
  const finished = await server.agent.getTask("owner", task.id);
  assert.equal(
    finished.status,
    "succeeded",
    JSON.stringify({
      error: finished.error,
      completion: finished.completion,
      tools: (await server.agent.journal.operations("owner", task.id)).map((o) => ({
        tool: o.toolName,
        status: o.status,
        receipt: o.receipt,
      })),
    }),
  );
  assert.deepEqual(
    requests.map((request) => request.method),
    ["POST", "POST", "GET"],
  );
  assert.equal((await server.db.list("owner", "google-workspace-receipts")).length, 2);
  const operations = await server.agent.journal.operations("owner", task.id);
  assert.deepEqual(
    operations
      .filter((op) => op.toolName === "execute_google_workspace_tool")
      .map((op) => op.effect),
    [true, true, false],
    "Docs writes are effects; its provider read is an observation",
  );
  assert.ok(
    operations
      .filter((op) =>
        /^(search_google_workspace_tools|describe_google_workspace_tool)$/.test(op.toolName),
      )
      .every((op) => !op.effect),
    "catalog discovery must not be classified as a provider write",
  );
  assert.doesNotMatch(
    fixture.requests.map((request) => request.body).join("\n"),
    /private-google-access|private-google-refresh/,
  );
});
