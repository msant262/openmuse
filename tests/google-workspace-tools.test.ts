import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { type TestContext, test } from "node:test";
import { taskCriteria } from "../apps/server/src/engine/task-verification.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import { googleWorkspaceVerificationBinding } from "../apps/server/src/google-workspace-tools.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";
import { createDocumentPdf } from "../packages/integrations/src/document.ts";
import { GoogleClient } from "../packages/integrations/src/google.ts";
import { encryptSecret } from "../packages/integrations/src/vault.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("literal cloud contents preserve punctuation and quoted apostrophes without instruction scaffolding", () => {
  for (const prompt of [
    `Cria no Google Docs um documento contendo o texto “Don't split, and don't remove e nem 'aspas'.”`,
    `Create a Google Docs document containing the text "Don't split, and don't remove e nem 'aspas'."`,
  ])
    assert.deepEqual(taskCriteria({ kind: "agent", prompt })[0].requiredItems, [
      "Don't split, and don't remove e nem 'aspas'.",
    ]);
});

async function fixture(
  t: TestContext,
  policy: "money" | "all" = "money",
  config: Parameters<typeof taskRuntime>[1] = {},
) {
  const encryptionKey = randomBytes(32).toString("base64");
  const server = await taskRuntime(t, {
    mode: "live",
    encryptionKey,
    approvalPolicy: policy,
    ...config,
  });
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

test("native Drive document reading downloads actual PDF bytes without attaching them or using the asynchronous download endpoint", async (t) => {
  const server = await fixture(t);
  const bytes = await createDocumentPdf(
    "Residence permit",
    "Permit type: researcher. Expires: 2027-05-31.",
  );
  const calls: URL[] = [];
  t.mock.method(server.workspace, "google", (_owner: string, connectionId?: string) => {
    assert.equal(connectionId, "work-id");
    return new GoogleClient({
      getAccessToken: async () => "fixture",
      fetch: async (raw, init) => {
        const url = new URL(String(raw));
        calls.push(url);
        assert.equal(init?.method, "GET");
        assert.equal(url.pathname, "/drive/v3/files/permit-file");
        if (url.searchParams.get("alt") === "media")
          return new Response(Buffer.from(bytes), {
            headers: { "Content-Type": "application/pdf" },
          });
        return Response.json({
          id: "permit-file",
          name: "Residence permit.pdf",
          mimeType: "application/pdf",
          version: "1",
          webViewLink: "https://drive.google.com/file/d/permit-file/view",
        });
      },
    });
  });
  const input = { account: "work@example.com", fileId: "permit-file", offset: 0, limit: 10000 };
  const result = await server.agent.googleWorkspace.readDriveFile("owner", input);
  assert.equal(result.attachment, false);
  assert.match(result.text, /researcher/);
  assert.match(result.text, /2027-05-31/);
  assert.equal(result.account, "work@example.com");
  assert.equal(result.nextOffset, null);
  assert.deepEqual(await server.files.bytes("owner", result.fileId), Buffer.from(bytes));
  assert.equal((await server.files.get("owner", result.fileId)).internal, true);
  assert.deepEqual(await server.files.list("owner"), []);
  await server.agent.googleWorkspace.readDriveFile("owner", input);
  assert.equal(
    calls.filter((url) => url.searchParams.get("alt") === "media").length,
    1,
    "unchanged provider version reuses preserved bytes",
  );
  assert.equal((await server.db.list("owner", "actions")).length, 0);
  await assert.rejects(
    server.agent.googleWorkspace.readDriveFile("other-owner", input),
    /disconnected/,
  );
});

test("Drive reading exports native Docs, resolves shortcuts and invalidates preserved text after a provider version changes", async (t) => {
  const server = await fixture(t);
  let version = "1";
  let exports = 0;
  const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const makeDocx = async () => {
    const ref = await server.agent.media.createDocument(
      "fixture-source",
      {
        name: "Permit",
        format: "docx",
        content: `Residence permit expires in version ${version}`,
        operationId: `source-${version}`,
      },
      "fixture",
    );
    return server.files.bytes("fixture-source", ref.fileId);
  };
  t.mock.method(
    server.workspace,
    "google",
    () =>
      new GoogleClient({
        getAccessToken: async () => "fixture",
        fetch: async (raw, init) => {
          const url = new URL(String(raw));
          assert.equal(init?.method, "GET");
          if (url.pathname.endsWith("/shortcut"))
            return Response.json({
              id: "shortcut",
              name: "Permit link",
              mimeType: "application/vnd.google-apps.shortcut",
              shortcutDetails: { targetId: "native-doc" },
            });
          if (url.pathname.endsWith("/export")) {
            exports++;
            assert.equal(url.searchParams.get("mimeType"), docxMime);
            return new Response(await makeDocx(), { headers: { "Content-Type": docxMime } });
          }
          return Response.json({
            id: "native-doc",
            name: "Permit",
            mimeType: "application/vnd.google-apps.document",
            version,
          });
        },
      }),
  );
  const input = { account: "work@example.com", fileId: "shortcut", limit: 10000 };
  const first = await server.agent.googleWorkspace.readDriveFile("owner", input);
  assert.match(first.text, /version 1/);
  assert.equal(first.driveFileId, "native-doc");
  assert.equal(first.mimeType, docxMime);
  assert.equal(first.attachment, false);
  version = "2";
  const latest = await server.agent.googleWorkspace.readDriveFile("owner", input);
  assert.match(latest.text, /version 2/);
  assert.notEqual(first.sha256, latest.sha256);
  assert.equal(exports, 2);
  assert.equal((await server.files.list("owner")).length, 0);
});

test("native Drive search uses the connected account authority, returns folder counts and performs only GETs", async (t) => {
  const server = await fixture(t);
  const calls: { connectionId?: string; url: URL; method?: string }[] = [];
  t.mock.method(
    server.workspace,
    "google",
    (_owner: string, connectionId?: string) =>
      new GoogleClient({
        getAccessToken: async () => "fixture",
        fetch: async (raw, init) => {
          const url = new URL(String(raw));
          calls.push({ connectionId, url, method: init?.method });
          assert.equal(url.pathname, "/drive/v3/files");
          return Response.json({
            files: [
              {
                id: "folder-result",
                name: "MovingDE",
                mimeType: "application/vnd.google-apps.folder",
                webViewLink: "https://drive.google.com/drive/folders/folder-result",
              },
            ],
            incompleteSearch: false,
          });
        },
      }),
  );
  const result = await server.agent.googleWorkspace.searchDrive("owner", {
    query: "MOVING DE",
    account: "work@example.com",
    kind: "folders",
    limit: 20,
  });
  assert.equal(result.complete, true);
  assert.equal(result.totalMatches, 1);
  assert.equal(result.files[0].account, "work@example.com");
  assert.equal(result.files[0].match, "name_variant");
  assert.equal(calls[0].connectionId, "work-id");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url.searchParams.get("includeItemsFromAllDrives"), "true");
  assert.ok(!JSON.stringify(result).includes("private-access-canary"));
  assert.equal((await server.db.list("owner", "actions")).length, 0);
});

test("Drive search cannot turn an account without Drive permission into an empty successful search", async (t) => {
  const server = await fixture(t);
  t.mock.method(server.workspace, "google", () => {
    throw new Error("Unauthorized provider call");
  });
  const result = await server.agent.googleWorkspace.searchDrive("owner", {
    query: "MOVING DE",
    account: "personal@example.com",
    kind: "folders",
    limit: 20,
  });
  assert.equal(result.complete, false);
  assert.equal(result.status, "partial");
  assert.equal(result.accounts[0].errorCode, "GOOGLE_SCOPE_REQUIRED");
});

test("an uncertain Google write gives a concrete status without manufacturing a text question", async (t) => {
  await modelFixture(t, () => ({
    name: "execute_google_workspace_tool",
    arguments: {
      toolId: "docs.documents.create",
      account: "work@example.com",
      parameters: {},
      body: { title: "Own uncertain Doc" },
      operationId: "uncertain-doc",
    },
  }));
  const server = await fixture(t, "money", { agentBackend: "model", model: "openai/fixture" });
  let dispatched = 0;
  t.mock.method(
    server.workspace,
    "google",
    (
      _owner: string,
      _connection?: string,
      signal?: AbortSignal,
      beforeWrite?: () => Promise<void>,
    ) =>
      new GoogleClient({
        signal,
        beforeWrite,
        getAccessToken: async () => "fixture",
        fetch: async () => {
          dispatched++;
          throw new Error("Connection closed after dispatch");
        },
      }),
  );
  const task = await server.agent.createTask("owner", {
    title: "Criar documento",
    prompt: "Cria na conta work@example.com um documento no Google Docs chamado Own uncertain Doc",
  });
  await server.agent.worker.tick();
  const saved = await server.agent.getTask("owner", task.id);
  assert.equal(saved.status, "paused");
  assert.equal(dispatched, 1);
  assert.match(saved.question ?? "", /Criar documento/);
  assert.match(saved.question ?? "", /work@example\.com/);
  assert.doesNotMatch(saved.question ?? "", /requires reconciliation/);
  assert.equal((await server.db.list("owner", "interaction-requests")).length, 0);
  await server.agent.worker.tick();
  assert.equal(dispatched, 1);
});

test("the copied worker prepares an ordinary email as a real unsent Gmail draft and attaches its card", async (t) => {
  const sequence = [
    {
      name: "prepare_email",
      arguments: {
        account: "work@example.com",
        to: ["msant262@gmail.com"],
        subject: "Okami teste pelo chat",
        body: "O teste funcionou. Obrigado pela ajuda!",
      },
    },
    { name: "finish_task", arguments: { summary: "Seu e-mail está pronto para revisão." } },
  ];
  await modelFixture(t, (index) => sequence[index]);
  const server = await fixture(t, "money", {
    agentBackend: "model",
    model: "openai/fixture",
    intelligenceApiKey: "fixture-key",
  });
  const writes: Request[] = [];
  t.mock.method(
    server.workspace,
    "google",
    (
      _owner: string,
      connectionId?: string,
      signal?: AbortSignal,
      beforeWrite?: () => Promise<void>,
    ) =>
      new GoogleClient({
        signal,
        beforeWrite,
        getAccessToken: async () => "fixture",
        fetch: async (url, init) => {
          assert.equal(connectionId, "work-id");
          const request = new Request(url, init);
          if (request.method === "GET") return Response.json({ emailAddress: "work@example.com" });
          writes.push(request);
          return Response.json({ id: "real-draft-id" });
        },
      }),
  );
  const task = await server.agent.createTask("owner", {
    prompt:
      "Escreve um e-mail da conta work@example.com para msant262@gmail.com dizendo que o teste funcionou",
  });
  await server.agent.worker.tick();
  const detail = await server.agent.detail("owner", task.id);
  assert.equal(detail.task.status, "succeeded", detail.task.error ?? detail.task.question);
  assert.equal(writes.length, 1);
  assert.equal(new URL(writes[0].url).pathname, "/gmail/v1/users/me/drafts");
  const artifact = detail.artifacts.find(
    (item) => typeof item.data.nativeGoogleDraftId === "string",
  );
  assert.ok(artifact);
  const card = await server.agent.googleWorkspace.mailDraft(
    "owner",
    String(artifact.data.nativeGoogleDraftId),
  );
  assert.equal(card.status, "saved");
  assert.equal(card.account, "work@example.com");
  assert.equal(card.draft.to[0], "msant262@gmail.com");
});

test("ordinary write and reply requests require a real draft; negated sending never requires an outbound receipt", () => {
  for (const prompt of [
    "Escreve um e-mail para msant262@gmail.com confirmando que o teste funcionou",
    "Responde ao email do João agradecendo o convite",
    "Write an email to someone@example.com",
    "Crie um rascunho no Gmail e não envie ainda",
    "Draft an email, do not send it",
  ]) {
    const criteria = taskCriteria({ kind: "agent", prompt });
    assert.ok(
      criteria.some((criterion) => criterion.effect === "email.draft"),
      prompt,
    );
    assert.ok(!criteria.some((criterion) => criterion.effect === "email.send"), prompt);
    assert.ok(!criteria.some((criterion) => criterion.kind === "artifact"), prompt);
  }
  assert.ok(
    taskCriteria({ kind: "agent", prompt: "Envie um e-mail para msant262@gmail.com" }).some(
      (criterion) => criterion.effect === "email.send",
    ),
  );
});

test("the reported email request completes after one saved draft and a prose ending without demanding a document", async (t) => {
  const draft = {
    to: ["msant262@gmail.com"],
    subject: "Confirmação de recebimento",
    body: "Olá, esta mensagem confirma o recebimento do documento. Obrigado!",
  };
  const model = await modelFixture(
    t,
    (index) =>
      index === 0
        ? {
            name: "save_gmail_draft",
            arguments: { account: "work@example.com", draft, operationId: "reported-draft" },
          }
        : undefined,
    { text: () => "O e-mail está salvo como rascunho. Não foi enviado." },
  );
  const server = await fixture(t, "money", { agentBackend: "model", model: "openai/fixture" });
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
          return Response.json({ id: "actual-provider-draft" });
        },
      });
    },
  );
  const task = await server.agent.createTask("owner", {
    prompt:
      "Na minha conta work@example.com, escreva um e-mail para msant262@gmail.com com o assunto ‘Confirmação de recebimento’ e a mensagem ‘Olá, esta mensagem confirma o recebimento do documento. Obrigado!’.",
  });
  await server.agent.worker.tick();
  const detail = await server.agent.detail("owner", task.id);
  assert.equal(detail.task.status, "succeeded", JSON.stringify(detail.task.completion));
  assert.equal(detail.task.completion?.status, "verified");
  assert.equal(model.requests.length, 2, "no artificial file-selection continuation");
  assert.equal(writes.length, 1, "a prose ending neither sends nor duplicates the draft");
  assert.equal(new URL(writes[0].url).pathname, "/gmail/v1/users/me/drafts");
  const artifact = detail.artifacts.find(
    (item) => typeof item.data.nativeGoogleDraftId === "string",
  );
  assert.ok(artifact);
  const card = await server.agent.googleWorkspace.mailDraft(
    "owner",
    String(artifact.data.nativeGoogleDraftId),
  );
  assert.equal(card.status, "saved");
  assert.equal(card.gmailDraftId, "actual-provider-draft");
  assert.equal(card.draft.body, draft.body);
  assert.equal(card.collapsed, false, "the composed email is available for the human to review");
});

test("draft execution applies optional defaults at the runtime boundary, not only in advertised schemas", async (t) => {
  const server = await fixture(t);
  let writes = 0;
  t.mock.method(
    server.workspace,
    "google",
    (
      _owner: string,
      connectionId?: string,
      signal?: AbortSignal,
      beforeWrite?: () => Promise<void>,
    ) =>
      new GoogleClient({
        signal,
        beforeWrite,
        getAccessToken: async () => "fixture",
        fetch: async (url, init) => {
          assert.equal(connectionId, "work-id");
          if (new Request(url, init).method === "GET")
            return Response.json({ emailAddress: "work@example.com" });
          writes++;
          return Response.json({ id: "gmail-draft" });
        },
      }),
  );
  const result = await server.agent.googleWorkspace.draft("owner", {
    account: "work-id",
    draft: { to: ["msant262@gmail.com"], subject: "Ordinary email", body: "Test content" },
    operationId: "missing-optional-fields",
  } as any);
  assert.equal(result.draftCard.status, "saved");
  assert.deepEqual(result.draftCard.draft.attachmentIds, []);
  assert.deepEqual(result.draftCard.draft.cc, []);
  assert.deepEqual(result.draftCard.draft.bcc, []);
  assert.equal(writes, 1);
});

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

test("Calendar approval resumes from its bound receipt and replaces stale waiting prose without repeating deletion", async (t) => {
  const model = await modelFixture(
    t,
    (index) =>
      index === 0
        ? {
            name: "execute_google_workspace_tool",
            arguments: {
              toolId: "calendar.events.delete",
              account: "work@example.com",
              parameters: { calendarId: "primary", eventId: "test-event" },
              operationId: "calendar-delete-resume",
            },
          }
        : undefined,
    { text: () => "A exclusão está aguardando sua aprovação no cartão de confirmação." },
  );
  const server = await fixture(t, "money", { agentBackend: "model", model: "openai/fixture" });
  let deletes = 0;
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
          assert.match(String(url), /\/calendar\/v3\/calendars\/primary\/events\/test-event/);
          if (init?.method === "GET")
            return Response.json({
              id: "test-event",
              summary: "Okami validação de agenda 10 outubro",
              etag: '"version-one"',
              start: { dateTime: "2026-10-11T15:00:00+02:00", timeZone: "Europe/Berlin" },
              end: { dateTime: "2026-10-11T15:30:00+02:00" },
            });
          assert.equal(init?.method, "DELETE");
          deletes++;
          return new Response(null, { status: 204 });
        },
      });
    },
  );
  const task = await server.agent.createTask("owner", {
    prompt:
      "Na agenda da conta work@example.com, exclua o compromisso “Okami validação de agenda 10 outubro” de amanhã.",
  });
  await server.agent.worker.tick();
  const pending = await server.agent.getTask("owner", task.id);
  assert.equal(pending.status, "waiting_approval");
  assert.equal(deletes, 0);
  assert.equal((await server.agent.verification.assess("owner", task.id, 0)).status, "unverified");
  assert.ok(pending.actionId);
  const action = await server.db.get<ActionProposal>("owner", "actions", pending.actionId);
  assert.ok(action);
  await server.actions.decide("owner", action.id, action.hash, "approve");
  await server.agent.worker.tick();
  const finished = await server.agent.getTask("owner", task.id);
  assert.equal(finished.status, "succeeded", JSON.stringify(finished.completion));
  assert.equal(deletes, 1);
  assert.equal(model.requests.length, 2);
  assert.ok(finished.result);
  assert.doesNotMatch(finished.result, /aguardando|waiting|approv/i);
  assert.match(finished.result, /Okami validação de agenda 10 outubro/);
  assert.match(finished.result, /work@example.com/);
  assert.equal(finished.criteria?.[0].effect, "calendar.delete");
  assert.deepEqual(finished.completion?.checks[0].evidenceIds, [action.id]);
  await server.db.put("owner", "actions", {
    ...action,
    status: "succeeded",
    result: '{"changed":true}',
  });
  assert.equal((await server.agent.verification.assess("owner", task.id, 0)).status, "unverified");
});

test("Drive cleanup resumes until every requested document, slide and sheet has a confirmed removal receipt", async (t) => {
  const selectedIds = ["doc-one", "doc-two", "slide-one", "slide-two", "sheet"];
  const model = await modelFixture(
    t,
    (index) => {
      if (index < 3)
        return {
          name: "search_drive",
          arguments: {
            account: "work@example.com",
            query: ["Study notes", "Study slides", "Study budget"][index],
            kind: "files",
            limit: 20,
          },
        };
      if (index >= 3 && index <= 11 && index % 2 === 1)
        return {
          name: "execute_google_workspace_tool",
          arguments: {
            toolId: "drive.files.update",
            account: "work@example.com",
            parameters: { fileId: selectedIds[(index - 3) / 2] },
            body: { trashed: true },
            operationId: `trash-${selectedIds[(index - 3) / 2]}`,
          },
        };
      return undefined;
    },
    { text: () => "A exclusão está aguardando sua aprovação no cartão de confirmação." },
  );
  const server = await fixture(t, "money", { agentBackend: "model", model: "openai/fixture" });
  const files = [
    {
      id: "doc-one",
      name: "Study notes",
      mimeType: "application/vnd.google-apps.document",
      trashed: false,
    },
    {
      id: "doc-two",
      name: "Study notes",
      mimeType: "application/vnd.google-apps.document",
      trashed: false,
    },
    {
      id: "slide-one",
      name: "Study slides",
      mimeType: "application/vnd.google-apps.presentation",
      trashed: false,
    },
    {
      id: "slide-two",
      name: "Study slides",
      mimeType: "application/vnd.google-apps.presentation",
      trashed: false,
    },
    {
      id: "sheet",
      name: "Study budget",
      mimeType: "application/vnd.google-apps.spreadsheet",
      trashed: false,
    },
    {
      id: "unrelated",
      name: "Other notes",
      mimeType: "application/vnd.google-apps.document",
      trashed: false,
    },
  ];
  const changed: string[] = [];
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
        fetch: async (raw, init) => {
          const url = new URL(String(raw));
          if (url.pathname === "/drive/v3/files") {
            assert.equal(init?.method, "GET");
            return Response.json({ files: files.filter((file) => !file.trashed) });
          }
          const file = files.find((file) => url.pathname === `/drive/v3/files/${file.id}`);
          assert.ok(file, url.pathname);
          if (init?.method === "GET") return Response.json(file);
          assert.equal(init?.method, "PATCH");
          assert.deepEqual(JSON.parse(String(init.body)), { trashed: true });
          changed.push(file.id);
          file.trashed = true;
          // Drive's default response need not include the changed field.
          return Response.json({ id: file.id, name: file.name });
        },
      });
    },
  );
  const task = await server.agent.createTask("owner", {
    prompt:
      "Apague do Drive da conta work@example.com os dois documentos “Study notes”, as duas apresentações “Study slides” e a planilha “Study budget”.",
  });
  await server.agent.worker.tick();
  let pending = await server.agent.getTask("owner", task.id);
  assert.equal(pending.status, "waiting_approval");
  assert.deepEqual(changed, []);
  assert.equal((await server.agent.verification.assess("owner", task.id, 0)).status, "unverified");
  const reviewed: ActionProposal[] = [];
  for (let index = 0; index < selectedIds.length; index++) {
    assert.ok(pending.actionId);
    const action = await server.db.get<ActionProposal>("owner", "actions", pending.actionId);
    assert.ok(action);
    reviewed.push(action);
    await server.actions.decide("owner", action.id, action.hash, "approve");
    await server.agent.worker.tick();
    pending = await server.agent.getTask("owner", task.id);
    assert.deepEqual(changed, selectedIds.slice(0, index + 1));
    if (index < selectedIds.length - 1) {
      assert.equal(
        pending.status,
        "queued",
        "a partial removal plus searches must not complete the five requested files",
      );
      await server.agent.worker.tick();
      pending = await server.agent.getTask("owner", task.id);
      assert.equal(
        pending.status,
        "waiting_approval",
        "the next item is prepared without a new user instruction",
      );
    }
  }
  const finished = await server.agent.getTask("owner", task.id);
  assert.equal(finished.status, "succeeded", JSON.stringify(finished.completion));
  assert.deepEqual(changed, selectedIds);
  assert.equal(files[5].trashed, false);
  assert.doesNotMatch(finished.result!, /aguardando|waiting|approv/i);
  assert.match(finished.result!, /Study notes/);
  assert.match(finished.result!, /work@example.com/);
  assert.equal(finished.criteria?.[0].effect, "drive.delete");
  assert.match(finished.result!, /Study slides/);
  assert.match(finished.result!, /Study budget/);
  assert.deepEqual(
    new Set(finished.completion?.checks[0].evidenceIds),
    new Set(reviewed.map((action) => action.id)),
  );
  await server.db.put("owner", "actions", {
    ...reviewed.at(-1)!,
    status: "succeeded",
    result: '{"trashed":true}',
  });
  assert.equal((await server.agent.verification.assess("owner", task.id, 0)).status, "unverified");
  assert.ok(model.requests.length >= 13);
});

test("Drive trash does not certify a successful PATCH when provider readback still shows an active file", async (t) => {
  const server = await fixture(t);
  let writes = 0;
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
        fetch: async (raw, init) => {
          assert.equal(new URL(String(raw)).pathname, "/drive/v3/files/no-change");
          if (init?.method === "GET")
            return Response.json({ id: "no-change", name: "Study notes", trashed: false });
          assert.equal(init?.method, "PATCH");
          writes++;
          return Response.json({ id: "no-change", trashed: true });
        },
      });
    },
  );
  const prepared = await server.agent.googleWorkspace.execute("owner", {
    toolId: "drive.files.update",
    account: "work@example.com",
    parameters: { fileId: "no-change" },
    body: { trashed: true },
    operationId: "unverified-trash",
  });
  assert.equal(writes, 0);
  const action = await server.db.get<ActionProposal>("owner", "actions", prepared.actionId!);
  assert.ok(action);
  const result = await server.actions.decide("owner", action.id, action.hash, "approve");
  assert.equal(writes, 1);
  assert.equal(result.status, "outcome_unknown");
  assert.equal(await server.db.get("owner", "google-workspace-receipts", action.id), null);
});

test("an ordinary Drive deletion cannot prepare permanent deletion instead of recoverable trash", async (t) => {
  const server = await fixture(t);
  let reads = 0;
  t.mock.method(
    server.workspace,
    "google",
    () =>
      new GoogleClient({
        getAccessToken: async () => "fixture",
        fetch: async () => {
          reads++;
          return Response.json({ id: "selected-file", name: "Study notes" });
        },
      }),
  );
  for (const prompt of [
    "Apague do Drive o arquivo “Study notes”.",
    "Apague do Drive o arquivo, mas não permanentemente.",
    "Apague do Drive o arquivo “Permanent deletion”.",
    "Delete this Drive file, but don't permanently delete it.",
  ]) {
    const task = await server.agent.createTask("owner", { prompt });
    await assert.rejects(
      server.agent.googleWorkspace.execute(
        "owner",
        {
          toolId: "drive.files.delete",
          account: "work@example.com",
          parameters: { fileId: "selected-file" },
          operationId: task.id,
        },
        { taskId: task.id },
      ),
      /drive\.files\.update|recoverable|lixeira/i,
    );
  }
  assert.equal(reads, 0);
  assert.equal((await server.db.list("owner", "actions")).length, 0);
  const explicit = await server.agent.createTask("owner", {
    prompt: "Apague permanentemente do Drive o arquivo “Study notes”.",
  });
  const result = await server.agent.googleWorkspace.execute(
    "owner",
    {
      toolId: "drive.files.delete",
      account: "work@example.com",
      parameters: { fileId: "selected-file" },
      operationId: explicit.id,
    },
    { taskId: explicit.id },
  );
  assert.equal(result.approvalRequired, true);
  assert.equal(reads, 1);
});

test("a legacy Drive approval without reviewed identity cannot dispatch a removal", async (t) => {
  const server = await fixture(t);
  let writes = 0;
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
        fetch: async (_raw, init) => {
          if (init?.method !== "GET") writes++;
          return Response.json({ id: "legacy-file", name: "Study notes", trashed: true });
        },
      }),
  );
  const prepared = await server.agent.googleWorkspace.execute("owner", {
    toolId: "drive.files.update",
    account: "work@example.com",
    parameters: { fileId: "legacy-file" },
    body: { trashed: true },
    operationId: "legacy-trash",
  });
  const action = await server.db.get<ActionProposal>("owner", "actions", prepared.actionId!);
  assert.ok(action);
  const saved = await server.db.get<{
    id: string;
    tool: string;
    hash: string;
    binding: Record<string, unknown>;
  }>("owner", "external-action-bindings", action.id);
  assert.ok(saved);
  const { driveBefore: _reviewedIdentity, ...binding } = saved.binding;
  await server.db.put("owner", "external-action-bindings", { ...saved, binding });
  await server.actions.decide("owner", action.id, action.hash, "approve");
  assert.equal(writes, 0);
  assert.equal(await server.db.get("owner", "google-workspace-receipts", action.id), null);
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
  assert.equal(created.draftCard.collapsed, false);
  await server.agent.googleWorkspace.collapseMailDraft("owner", linked);
  assert.equal((await server.agent.googleWorkspace.mailDraft("owner", linked)).collapsed, true);
  assert.equal(writes.length, 1);
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
  assert.equal(saved.draft.collapsed, true);
  await server.agent.googleWorkspace.operateMailDraft("owner", linked, "save", "save-click");
  assert.equal(writes.length, 2);
  const pending = await server.agent.googleWorkspace.operateMailDraft(
    "owner",
    linked,
    "delete",
    "delete-click",
  );
  assert.equal(pending.draft.status, "awaiting_review");
  assert.equal(pending.draft.collapsed, false);
  assert.equal(writes.length, 2);
  const action = await server.db.get<ActionProposal>("owner", "actions", pending.actionId);
  assert.ok(action);
  assert.equal(action.data.subject, input.draft.subject);
  assert.equal(action.data.to, "msant262@gmail.com");
  await server.actions.decide("owner", action.id, action.hash, "deny");
  assert.equal((await server.agent.googleWorkspace.mailDraft("owner", linked)).status, "denied");
  assert.equal((await server.agent.googleWorkspace.mailDraft("owner", linked)).collapsed, true);
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

test("mail draft history returns recent bounded owner-scoped summaries without MIME or message bodies", async (t) => {
  const server = await fixture(t);
  for (let i = 0; i < 23; i++)
    await server.db.put("owner", "google-mail-drafts", {
      id: `history-${String(i).padStart(2, "0")}`,
      account: "work@example.com",
      connectionId: "work-id",
      draft: {
        to: ["msant262@gmail.com"],
        cc: [],
        bcc: [],
        attachmentIds: [],
        subject: `Subject ${i}`,
        body: "private-body-canary",
      },
      raw: "private-mime-canary",
      lastOperationId: "private-operation-canary",
      operation: "save",
      status: "saved",
      updatedAt: new Date(Date.UTC(2026, 9, 6, 0, i)).toISOString(),
    });
  const first = await server.agent.googleWorkspace.mailDrafts("owner");
  assert.equal(first.entries.length, 20);
  assert.equal(first.entries[0].subject, "Subject 22");
  assert.ok(first.nextCursor);
  assert.doesNotMatch(
    JSON.stringify(first),
    /private-body-canary|private-mime-canary|private-operation-canary/,
  );
  const second = await server.agent.googleWorkspace.mailDrafts("owner", first.nextCursor);
  assert.equal(second.entries.length, 3);
  assert.equal(second.nextCursor, undefined);
  assert.equal(new Set([...first.entries, ...second.entries].map((entry) => entry.id)).size, 23);
  assert.deepEqual(await server.agent.googleWorkspace.mailDrafts("foreign-owner"), { entries: [] });
  await assert.rejects(
    server.agent.googleWorkspace.collapseMailDraft("foreign-owner", "history-00"),
    /not found/,
  );
});

test("a natural calendar request is verified from its real receipt across equivalent timezone offsets", async (t) => {
  const server = await fixture(t);
  const body = {
    summary: "Okami teste de agenda pelo chat",
    start: { dateTime: "2026-10-07T15:00:00Z", timeZone: "UTC" },
    end: { dateTime: "2026-10-07T15:15:00Z", timeZone: "UTC" },
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 5 }] },
  };
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
          assert.equal(request.method, "POST");
          assert.deepEqual(await request.json(), body);
          return Response.json({
            id: "provider-event",
            ...body,
            start: { dateTime: "2026-10-07T17:00:00+02:00", timeZone: "UTC" },
            end: { dateTime: "2026-10-07T17:15:00+02:00", timeZone: "UTC" },
          });
        },
      });
    },
  );
  const task = await server.agent.createTask("owner", {
    prompt:
      "Na conta work@example.com, coloca na minha agenda amanhã às 15h UTC um evento de 15 minutos chamado Okami teste de agenda pelo chat, com lembrete cinco minutos antes.",
  });
  assert.equal(task.criteria?.[0].effect, "calendar.create");
  const worker = new TaskWorker(server.db, async (owner, running) => {
    const result = await server.agent.googleWorkspace.execute(
      owner,
      {
        toolId: "calendar.events.insert",
        account: "work@example.com",
        parameters: { calendarId: "primary" },
        body,
        operationId: "natural-calendar",
      },
      { taskId: running.id },
    );
    assert.equal(result.status, "succeeded");
    assert.equal((await server.agent.verification.assess(owner, running.id, 0)).status, "verified");
    return { status: "succeeded", result: "Evento às 15h UTC confirmado" };
  });
  await worker.tick();
  await worker.stop();
  assert.equal((await server.agent.detail("owner", task.id)).task.status, "succeeded");
});

test("cloud document writing requires a confirmed native Google receipt with the requested contents", async (t) => {
  const server = await fixture(t);
  t.mock.method(
    server.workspace,
    "google",
    () =>
      new GoogleClient({
        getAccessToken: async () => "fixture",
        fetch: async (url, init) => {
          const request = new Request(url, init);
          return request.url.endsWith(":batchUpdate")
            ? Response.json({ documentId: "full-document-id", replies: [{}] })
            : Response.json({ documentId: "full-document-id", title: "Own document" });
        },
      }),
  );
  const task = await server.agent.createTask("owner", {
    prompt:
      "Na conta work@example.com, cria no Google Docs um documento contendo o texto “Texto confirmado. Criado e salvo.”",
  });
  assert.equal(task.criteria?.[0].id, "requested-google-document");
  assert.deepEqual(task.criteria?.[0].requiredItems, ["Texto confirmado. Criado e salvo."]);
  const actionIds: string[] = [];
  const worker = new TaskWorker(server.db, async (owner, running) => {
    const created = await server.agent.googleWorkspace.execute(
      owner,
      {
        toolId: "docs.documents.create",
        account: "work@example.com",
        parameters: {},
        body: { title: "Own document" },
        operationId: "cloud-create",
      },
      { taskId: running.id },
    );
    assert.ok("actionId" in created);
    actionIds.push(created.actionId);
    assert.notEqual(
      (await server.agent.verification.assess(owner, running.id, 0)).status,
      "verified",
    );
    const edited = await server.agent.googleWorkspace.execute(
      owner,
      {
        toolId: "docs.documents.batchUpdate",
        account: "work@example.com",
        parameters: { documentId: "full-document-id" },
        body: {
          requests: [
            { insertText: { location: { index: 1 }, text: "Texto confirmado. Criado e salvo." } },
          ],
        },
        operationId: "cloud-text",
      },
      { taskId: running.id },
    );
    assert.ok("actionId" in edited);
    actionIds.push(edited.actionId);
    assert.equal((await server.agent.verification.assess(owner, running.id, 0)).status, "verified");
    return { status: "succeeded", result: "Documento escrito e confirmado" };
  });
  await worker.tick();
  await worker.stop();
  assert.equal((await server.agent.detail("owner", task.id)).task.status, "succeeded");
  const links = () => server.agent.googleWorkspace.deliveryLinks("owner", task.id, 0, actionIds);
  assert.deepEqual(await links(), [
    {
      title: "Google Docs",
      url: "https://docs.google.com/document/d/full-document-id/edit?authuser=work%40example.com",
    },
  ]);
  for (const [owner, taskId, revision] of [
    ["other-owner", task.id, 0],
    ["owner", "other-task", 0],
    ["owner", task.id, 1],
  ] as const)
    assert.deepEqual(
      await server.agent.googleWorkspace.deliveryLinks(owner, taskId, revision, actionIds),
      [],
    );
  for (const id of actionIds) {
    const action = await server.db.get<ActionProposal>("owner", "actions", id);
    assert.ok(action);
    await server.db.put("owner", "actions", { ...action, status: "awaiting_review" });
    assert.deepEqual(
      await server.agent.googleWorkspace.deliveryLinks("owner", task.id, 0, [id]),
      [],
    );
    await server.db.put("owner", "actions", {
      ...action,
      result: JSON.stringify({ data: { documentId: "invented-id" } }),
    });
    assert.deepEqual(
      await server.agent.googleWorkspace.deliveryLinks("owner", task.id, 0, [id]),
      [],
    );
    await server.db.put("owner", "actions", action);
  }
  assert.equal(
    (await links()).length,
    1,
    "only original, matching provider receipts are deliverable",
  );
});
