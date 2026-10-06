import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
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
      return { name: "tool_search", arguments: { query: "Gmail search emails inbox" } };
    if (index === 2) {
      assert.match(fixture.requests[index].body, /okami_search_mail/);
      return { name: "tool_describe", arguments: { id: "okami_search_mail" } };
    }
    if (index === 3)
      return { name: "search_mail", arguments: { query: "in:inbox", account: "work@example.com" } };
    if (index === 4) return { name: "tool_describe", arguments: { id: "okami_read_mail_thread" } };
    if (index === 5)
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
