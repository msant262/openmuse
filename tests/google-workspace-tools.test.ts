import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { type TestContext, test } from "node:test";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import { googleWorkspaceVerificationBinding } from "../apps/server/src/google-workspace-tools.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";
import { GoogleClient } from "../packages/integrations/src/google.ts";
import { encryptSecret } from "../packages/integrations/src/vault.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

async function fixture(t: TestContext, policy: "money" | "all" = "money") {
  const encryptionKey = randomBytes(32).toString("base64");
  const server = await taskRuntime(t, { mode: "live", encryptionKey, approvalPolicy: policy });
  for (const [id, account, connectionId, scopes] of [
    ["google", "personal@example.com", "personal-id", ["gmail.readonly", "calendar.readonly"]],
    [
      `google:${"a".repeat(64)}`,
      "work@example.com",
      "work-id",
      ["gmail.modify", "gmail.send", "calendar", "drive"],
    ],
  ] as const)
    await server.db.put("owner", "credentials", {
      id,
      connectionId,
      secret: encryptSecret(
        JSON.stringify({
          connectionId,
          account,
          accessToken: "private-access-canary",
          refreshToken: "private-refresh-canary",
          expiresAt: Date.now() + 3600000,
          scopes: scopes.map((scope) => `https://www.googleapis.com/auth/${scope}`),
        }),
        encryptionKey,
      ),
    });
  return server;
}

test("calendar deletion displays the actual event and dispatches only after an exact human approval", async (t) => {
  const server = await fixture(t);
  const writes: Request[] = [];
  t.mock.method(
    server.workspace,
    "google",
    (
      _owner: string,
      connectionId?: string,
      signal?: AbortSignal,
      beforeWrite?: () => Promise<void>,
    ) => {
      assert.equal(connectionId, "work-id");
      return new GoogleClient({
        signal,
        beforeWrite,
        getAccessToken: async () => "fixture",
        fetch: async (url, init) => {
          const request = new Request(url, init);
          if (request.method === "GET")
            return Response.json({
              id: "test-event",
              summary: "Own test event",
              etag: '"version-one"',
              start: { dateTime: "2026-10-07T12:00:00Z" },
            });
          writes.push(request);
          return new Response(null, { status: 204 });
        },
      });
    },
  );
  const input = {
    toolId: "calendar.events.delete",
    account: "work-id",
    parameters: { calendarId: "primary", eventId: "test-event" },
    operationId: "calendar-delete-card",
  };
  const prepared = await server.agent.googleWorkspace.execute("owner", input);
  assert.equal(prepared.status, "awaiting_review");
  assert.equal(writes.length, 0);
  const action = await server.db.get<ActionProposal>("owner", "actions", prepared.actionId);
  assert.ok(action);
  assert.equal(action.data.requiresHumanApproval, true);
  assert.equal(action.data.resourceName, "Own test event");
  await assert.rejects(
    server.actions.decide("owner", action.id, action.hash, "approve", "policy"),
    /human/i,
  );
  await assert.rejects(server.actions.decide("owner", action.id, "wrong-hash", "approve"));
  assert.equal(writes.length, 0);
  await server.actions.decide("owner", action.id, action.hash, "approve");
  await server.agent.googleWorkspace.execute("owner", input);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "DELETE");
  assert.equal(writes[0].headers.get("if-match"), '"version-one"');
});

test("draft cards preserve sender and content, save and send once, and never auto-delete", async (t) => {
  const server = await fixture(t);
  const writes: Request[] = [];
  t.mock.method(
    server.workspace,
    "google",
    (
      _owner: string,
      connectionId?: string,
      signal?: AbortSignal,
      beforeWrite?: () => Promise<void>,
    ) => {
      assert.equal(connectionId, "work-id");
      return new GoogleClient({
        signal,
        beforeWrite,
        getAccessToken: async () => "fixture",
        fetch: async (url, init) => {
          const request = new Request(url, init);
          if (request.method === "GET") return Response.json({ emailAddress: "work@example.com" });
          writes.push(request);
          return request.method === "DELETE"
            ? new Response(null, { status: 204 })
            : Response.json({
                id: request.url.endsWith("/send") ? "sent-message" : "remote-draft",
              });
        },
      });
    },
  );
  const input = {
    account: "work-id",
    draft: {
      to: ["msant262@gmail.com"],
      cc: [],
      bcc: [],
      subject: "Only test draft",
      body: "Exact visible contents",
      attachmentIds: [],
    },
    operationId: "card-create",
  };
  let linked = "";
  const created = await server.agent.googleWorkspace.draft("owner", input, {
    draftCard: async (id) => {
      linked = id;
    },
  });
  assert.equal(created.draftCard.id, linked);
  assert.equal(created.draftCard.account, "work@example.com");
  assert.equal(created.draftCard.gmailDraftId, "remote-draft");
  assert.deepEqual(created.draftCard.draft, input.draft);
  assert.doesNotMatch(JSON.stringify(created.draftCard), /raw|fixture/);
  await assert.rejects(
    server.agent.googleWorkspace.mailDraft("foreign-owner", linked),
    /not found/,
  );
  const saved = await server.agent.googleWorkspace.operateMailDraft(
    "owner",
    linked,
    "save",
    "save-click",
  );
  assert.equal(saved.draft.status, "saved");
  await server.agent.googleWorkspace.operateMailDraft("owner", linked, "save", "save-click");
  assert.equal(writes.length, 2);
  const pending = await server.agent.googleWorkspace.operateMailDraft(
    "owner",
    linked,
    "delete",
    "delete-click",
  );
  assert.equal(pending.draft.status, "awaiting_review");
  assert.equal(writes.length, 2);
  const action = await server.db.get<ActionProposal>("owner", "actions", pending.actionId);
  assert.ok(action);
  assert.equal(action.data.subject, input.draft.subject);
  assert.equal(action.data.to, "msant262@gmail.com");
  await server.actions.decide("owner", action.id, action.hash, "deny");
  assert.equal((await server.agent.googleWorkspace.mailDraft("owner", linked)).status, "denied");
  assert.equal(writes.length, 2);
  const sent = await server.agent.googleWorkspace.operateMailDraft(
    "owner",
    linked,
    "send",
    "send-click",
  );
  assert.equal(sent.draft.status, "sent");
  const repeated = await server.agent.googleWorkspace.operateMailDraft(
    "owner",
    linked,
    "send",
    "send-click",
  );
  assert.deepEqual(repeated, sent);
  assert.equal(writes.length, 3);
  assert.ok(writes.every((request) => request.method !== "DELETE"));
  await assert.rejects(
    server.agent.googleWorkspace.operateMailDraft("owner", linked, "delete", "late-delete"),
    /already/,
  );
  assert.equal((await server.workspace.googleAccounts("owner")).length, 2);
});

test("a dispatched Google read failure retains its error and does not become an uncertain write", async (t) => {
  const server = await fixture(t);
  t.mock.method(
    server.workspace,
    "google",
    () =>
      new GoogleClient({
        getAccessToken: async () => "fixture",
        fetch: async () =>
          Response.json({ error: { message: "Document not found" } }, { status: 404 }),
      }),
  );
  const task = await server.agent.createTask("owner", { prompt: "Read my Google Doc" });
  const worker = new TaskWorker(server.db, async (owner, running) => {
    const args = {
      toolId: "docs.documents.get",
      account: "work-id",
      parameters: { documentId: "missing-document" },
      operationId: "missing-doc-read",
    };
    await assert.rejects(
      server.agent.journal.run(
        owner,
        running,
        {
          id: "read-missing-doc",
          name: "execute_google_workspace_tool",
          args,
        },
        () => server.agent.googleWorkspace.execute(owner, args),
        false,
      ),
      /Document not found/,
    );
    return { status: "failed", error: "Expected diagnostic failure" };
  });
  await worker.tick();
  await worker.stop();
  const op = (await server.agent.journal.operations("owner", task.id))[0];
  assert.equal(op.effect, false);
  assert.equal(op.status, "failed");
  assert.match(JSON.stringify(op.receipt), /Document not found/);
});

test("Google discovery exposes metadata and which simultaneous accounts can perform an operation", async (t) => {
  const server = await fixture(t);
  const search = await server.agent.googleWorkspace.search("owner", {
    query: "gmail.users.drafts.create",
    limit: 3,
  });
  assert.equal(search.tools[0].id, "gmail.users.drafts.create");
  assert.deepEqual(search.tools[0].accounts, ["work@example.com"]);
  assert.doesNotMatch(JSON.stringify(search), /private-access|private-refresh/);
  assert.ok((await server.workspace.googleAccounts("owner")).every((value) => value.connectionId));
});

test("missing Google permissions, unknown accounts and foreign-owner resources fail before dispatch", async (t) => {
  const server = await fixture(t);
  let calls = 0;
  t.mock.method(server.workspace, "google", () => {
    calls++;
    throw new Error("must not dispatch");
  });
  const input = { toolId: "drive.files.list", parameters: {}, operationId: "test-drive-read" };
  await assert.rejects(server.agent.googleWorkspace.execute("owner", input), {
    code: "GOOGLE_SCOPE_REQUIRED",
  });
  await assert.rejects(
    server.agent.googleWorkspace.execute("owner", { ...input, account: "unknown@example.com" }),
    { code: "GOOGLE_RECONNECT_REQUIRED" },
  );
  await assert.rejects(
    server.agent.googleWorkspace.execute("someone-else", { ...input, account: "work-id" }),
    { code: "GOOGLE_RECONNECT_REQUIRED" },
  );
  assert.equal(calls, 0);
});

test("a real Gmail draft uses server-built UTF-8 MIME, the selected account and one durable write", async (t) => {
  const server = await fixture(t);
  const calls: Request[] = [];
  t.mock.method(
    server.workspace,
    "google",
    (
      _owner: string,
      connectionId?: string,
      signal?: AbortSignal,
      beforeWrite?: () => Promise<void>,
    ) => {
      assert.equal(connectionId, "work-id");
      return new GoogleClient({
        signal,
        beforeWrite,
        getAccessToken: async () => "fixture",
        fetch: async (url, init) => {
          const request = new Request(url, init);
          if (request.method === "GET") return Response.json({ emailAddress: "work@example.com" });
          calls.push(request);
          return Response.json({
            id: "draft-real-id",
            message: { id: "message-real-id", threadId: "thread-real-id" },
          });
        },
      });
    },
  );
  const input = {
    account: "work@example.com",
    draft: {
      to: ["msant262@gmail.com"],
      subject: "Teste de rascunho — Okami",
      body: "Olá!\nTeste sem envio.",
      cc: [],
      bcc: [],
      attachmentIds: [],
    },
    operationId: "draft-create-test",
  };
  const task = await server.agent.createTask("owner", {
    prompt: "Create a draft email in Gmail for msant262@gmail.com",
  });
  const worker = new TaskWorker(server.db, async (owner, running) => {
    const first = await server.agent.googleWorkspace.draft(owner, input, { taskId: running.id });
    const repeated = await server.agent.googleWorkspace.draft(owner, input, { taskId: running.id });
    assert.equal(first.status, "succeeded");
    assert.deepEqual(repeated, first);
    assert.doesNotMatch(JSON.stringify(first), /fixture|private-access|private-refresh/);
    assert.equal((await server.agent.verification.assess(owner, running.id, 0)).status, "verified");
    return { status: "succeeded", result: "Gmail draft saved" };
  });
  await worker.tick();
  await worker.stop();
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, "/gmail/v1/users/me/drafts");
  const body = await calls[0].json();
  const mime = Buffer.from(body.message.raw, "base64url").toString();
  assert.match(mime, /To: msant262@gmail.com/);
  assert.match(mime, /Content-Transfer-Encoding: base64/);
  assert.equal((await server.workspace.googleAccounts("owner")).length, 2);
  assert.equal((await server.agent.verification.assess("owner", task.id, 0)).status, "verified");
});

test("Google writes retain review, target account and action idempotency across default changes", async (t) => {
  const server = await fixture(t, "all");
  let calls = 0;
  t.mock.method(
    server.workspace,
    "google",
    (
      _owner: string,
      connectionId?: string,
      signal?: AbortSignal,
      beforeWrite?: () => Promise<void>,
    ) => {
      assert.equal(connectionId, "work-id");
      return new GoogleClient({
        signal,
        beforeWrite,
        getAccessToken: async () => "fixture",
        fetch: async () => {
          calls++;
          return Response.json({ documentId: "doc-real-id", title: "Teste" });
        },
      });
    },
  );
  const input = {
    toolId: "docs.documents.create",
    account: "work-id",
    parameters: {},
    body: { title: "Teste" },
    operationId: "doc-create-test",
  };
  const prepared = await server.agent.googleWorkspace.execute("owner", input);
  assert.equal(prepared.status, "awaiting_review");
  assert.equal(calls, 0);
  const action = await server.db.get<ActionProposal>("owner", "actions", prepared.actionId);
  assert.ok(action);
  await server.db.put("owner", "settings", {
    id: "google-default",
    account: "personal@example.com",
  });
  const result = await server.actions.decide("owner", action.id, action.hash, "approve");
  assert.equal(result.status, "succeeded");
  assert.equal(calls, 1);
  const again = await server.actions.decide("owner", action.id, action.hash, "approve");
  assert.equal(again.status, "succeeded");
  assert.equal(calls, 1);
});

test("an uncertain Google write dispatches once and cannot be reported or retried as successful", async (t) => {
  const server = await fixture(t);
  let calls = 0;
  t.mock.method(
    server.workspace,
    "google",
    (
      _owner: string,
      _connectionId?: string,
      signal?: AbortSignal,
      beforeWrite?: () => Promise<void>,
    ) =>
      new GoogleClient({
        signal,
        beforeWrite,
        getAccessToken: async () => "fixture",
        fetch: async () => {
          calls++;
          return Response.json({}, { status: 200 });
        },
      }),
  );
  const input = {
    toolId: "docs.documents.create",
    account: "work-id",
    parameters: {},
    body: { title: "Teste" },
    operationId: "doc-unknown-test",
  };
  const result = await server.agent.googleWorkspace.execute("owner", input);
  assert.equal(result.status, "outcome_unknown");
  assert.equal(
    (await server.agent.googleWorkspace.execute("owner", input)).status,
    "outcome_unknown",
  );
  assert.equal(calls, 1);
});

test("Drive exports save verified bytes as an owner-bound local file", async (t) => {
  const server = await fixture(t);
  t.mock.method(
    server.workspace,
    "google",
    (
      _owner: string,
      connectionId?: string,
      signal?: AbortSignal,
      beforeWrite?: () => Promise<void>,
    ) => {
      assert.equal(connectionId, "work-id");
      return new GoogleClient({
        signal,
        beforeWrite,
        getAccessToken: async () => "fixture",
        fetch: async () =>
          new Response("Documento real: Olá!", {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          }),
      });
    },
  );
  const result = await server.agent.googleWorkspace.execute("owner", {
    toolId: "drive.files.export",
    account: "work-id",
    parameters: { fileId: "doc-id", mimeType: "text/plain" },
    downloadName: "Teste.txt",
    operationId: "drive-export-test",
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.text, "Documento real: Olá!");
  assert.equal(
    Buffer.from(await server.files.bytes("owner", result.artifact.id)).toString(),
    result.text,
  );
  await assert.rejects(server.files.get("someone-else", result.artifact.id), /not found/i);
});

test("sending a Gmail draft captures its exact MIME, verifies recipients and never reads or sends it twice", async (t) => {
  const server = await fixture(t);
  const raw = Buffer.from(
    "To: msant262@gmail.com\r\nSubject: Teste\r\n\r\nTeste sem dados pessoais.",
  ).toString("base64url");
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
      assert.equal(connectionId, "work-id");
      return new GoogleClient({
        signal,
        beforeWrite,
        getAccessToken: async () => "fixture",
        fetch: async (url, init) => {
          const request = new Request(url, init);
          requests.push(request);
          return request.method === "GET"
            ? Response.json({ id: "draft-id", message: { raw } })
            : Response.json({ id: "sent-id", threadId: "sent-thread" });
        },
      });
    },
  );
  const input = {
    toolId: "gmail.users.drafts.send",
    account: "work-id",
    parameters: {},
    body: { id: "draft-id" },
    operationId: "send-draft-test",
  };
  const result = await server.agent.googleWorkspace.execute("owner", input);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(await server.agent.googleWorkspace.execute("owner", input), result);
  assert.deepEqual(
    requests.map((request) => request.method),
    ["GET", "POST"],
  );
  assert.equal((await requests[1].json()).message.raw, raw);
  const action = await server.db.get<ActionProposal>("owner", "actions", result.actionId);
  assert.ok(action);
  const binding = await googleWorkspaceVerificationBinding(server.db, "owner", action);
  assert.deepEqual(binding?.args.to, ["msant262@gmail.com"]);
  await server.db.put("owner", "google-workspace-receipts", {
    id: action.id,
    status: "succeeded",
    actionHash: "tampered",
  });
  assert.equal(await googleWorkspaceVerificationBinding(server.db, "owner", action), undefined);
});

test("calendar free/busy queries retry as reads and do not require write permissions", async (t) => {
  const server = await fixture(t);
  let calls = 0;
  t.mock.method(
    server.workspace,
    "google",
    (
      _owner: string,
      connectionId?: string,
      signal?: AbortSignal,
      beforeWrite?: () => Promise<void>,
    ) => {
      assert.equal(connectionId, "personal-id");
      return new GoogleClient({
        signal,
        beforeWrite,
        getAccessToken: async () => "fixture",
        retry: { sleep: async () => {} },
        fetch: async () => {
          calls++;
          return calls === 1
            ? Response.json({}, { status: 503 })
            : Response.json({ calendars: { primary: { busy: [] } } });
        },
      });
    },
  );
  const result = await server.agent.googleWorkspace.execute("owner", {
    toolId: "calendar.freebusy.query",
    parameters: {},
    body: {
      timeMin: "2026-10-06T00:00:00Z",
      timeMax: "2026-10-07T00:00:00Z",
      items: [{ id: "primary" }],
    },
    operationId: "freebusy-read",
  });
  assert.equal(result.status, "succeeded");
  assert.equal(calls, 2);
  assert.deepEqual(await server.db.list("owner", "actions"), []);
});
