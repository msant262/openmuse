import assert from "node:assert/strict";
import test from "node:test";
import { GoogleWorkspaceCatalog } from "../packages/integrations/src/google-workspace-catalog.ts";

const catalog = new GoogleWorkspaceCatalog();

test("deletions, trash and nested content removal require a review across Google services", () => {
  for (const [id, body] of [
    ["calendar.events.delete"],
    ["calendar.calendars.clear"],
    ["gmail.users.drafts.delete"],
    ["gmail.users.messages.trash"],
    ["gmail.users.messages.batchDelete", { ids: ["message"] }],
    ["drive.files.delete"],
    ["drive.files.emptyTrash"],
    ["drive.files.update", { trashed: true }],
    ["sheets.spreadsheets.values.clear"],
    ["sheets.spreadsheets.values.batchClear", { ranges: ["A1:B2"] }],
    ["sheets.spreadsheets.batchUpdate", { requests: [{ deleteSheet: { sheetId: 5 } }] }],
    [
      "docs.documents.batchUpdate",
      { requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: 2 } } }] },
    ],
    ["slides.presentations.batchUpdate", { requests: [{ deleteObject: { objectId: "slide" } }] }],
  ] as const)
    assert.equal(catalog.destructive(id, body), true, id);
  for (const [id, body] of [
    ["docs.documents.get"],
    ["gmail.users.drafts.create", { message: { raw: "ignored" } }],
    ["drive.files.update", { trashed: false }],
    ["docs.documents.batchUpdate", { requests: [{ insertText: { text: "deleteObject" } }] }],
    ["gmail.users.messages.modify", { removeLabelIds: [], addLabelIds: ["STARRED"] }],
  ] as const)
    assert.equal(catalog.destructive(id, body), false, id);
});

test("the pinned Google catalog discovers all six services without loading their schemas", () => {
  for (const service of ["gmail", "calendar", "drive", "docs", "sheets", "slides"]) {
    const result = catalog.search({ query: "", service, limit: 100 });
    assert.ok(result.total > 0, service);
    assert.ok(result.tools.every((tool) => tool.id.startsWith(`${service}.`)));
    assert.ok(JSON.stringify(result).length < 50000);
  }
  assert.equal(
    catalog.search({ query: "gmail.users.drafts.create", limit: 3 }).tools[0]?.id,
    "gmail.users.drafts.create",
  );
  assert.equal(
    catalog.search({ query: "spreadsheets values update", service: "sheets", limit: 3 }).tools[0]
      ?.id,
    "sheets.spreadsheets.values.update",
  );
});

test("descriptions expand only the requested request-body branch", () => {
  const description = catalog.describe("docs.documents.batchUpdate");
  assert.ok(JSON.stringify(description).length < 10000);
  const insert = catalog.describe("docs.documents.batchUpdate", ["requests", "[]", "insertText"]);
  assert.ok(JSON.stringify(insert).includes("text"));
  assert.throws(
    () => catalog.describe("docs.documents.batchUpdate", ["notAField"]),
    /schema|field/i,
  );
});

test("broad batch schemas stay compact and expose a complete executable example", () => {
  const description = catalog.describe("docs.documents.batchUpdate", ["requests"]);
  assert.ok(JSON.stringify(description).length < 10000);
  const example = description.requestExample;
  assert.ok(example);
  assert.equal(catalog.prepare({ toolId: description.id, ...example }).method, "POST");
  assert.deepEqual(example.body, {
    requests: [{ insertText: { location: { index: 1 }, text: "Text to insert" } }],
  });
});

test("lazy descriptions accept the parameters envelope for reads and body prefixes for writes", () => {
  const list = catalog.describe("gmail.users.messages.list", ["parameters"]);
  assert.ok(list.parameters.q);
  assert.ok(list.parameters.pageToken);
  assert.equal(list.body, undefined);
  const insert = catalog.describe("docs.documents.batchUpdate", [
    "body",
    "requests",
    "[]",
    "insertText",
  ]);
  assert.ok(insert.body);
  assert.deepEqual(insert.schemaPath, ["requests", "[]", "insertText"]);
  assert.throws(
    () => catalog.describe("gmail.users.messages.list", ["parameters", "unknown"]),
    /parameter/i,
  );
});

test("core document, spreadsheet and presentation examples have valid complete request envelopes", () => {
  for (const service of ["docs", "sheets", "slides"]) {
    for (const method of catalog.search({ query: "", service, limit: 100 }).tools) {
      const description = catalog.describe(method.id);
      if (description.requestExample)
        assert.doesNotThrow(
          () => catalog.prepare({ toolId: method.id, ...description.requestExample }),
          method.id,
        );
    }
  }
});

test("shortened resource identifiers fail before contacting Google", () => {
  for (const documentId of ["110vQV…j7J2-mZc", "110vQV...j7J2-mZc"])
    assert.throws(
      () => catalog.prepare({ toolId: "docs.documents.get", parameters: { documentId } }),
      /full|shortened/i,
    );
});

test("read-only POST operations retain their read classification", () => {
  for (const id of [
    "calendar.freebusy.query",
    "sheets.spreadsheets.getByDataFilter",
    "sheets.spreadsheets.values.batchGetByDataFilter",
    "sheets.spreadsheets.developerMetadata.search",
    "drive.files.download",
  ])
    assert.equal(catalog.effect(id), "read");
  assert.equal(catalog.effect("slides.presentations.batchUpdate"), "write");
});

test("Google requests validate arguments, encode path data and never accept arbitrary destinations", () => {
  const prepared = catalog.prepare({
    toolId: "sheets.spreadsheets.values.get",
    parameters: { spreadsheetId: "test-id", range: "'Teste pessoal'!A1:B2" },
  });
  const url = new URL(prepared.url);
  assert.equal(url.origin, "https://sheets.googleapis.com");
  assert.ok(url.pathname.includes("%20"));
  assert.throws(
    () =>
      catalog.prepare({
        toolId: "drive.files.get",
        parameters: { fileId: "../users?access_token=secret" },
      }),
    /resource|path/i,
  );
  assert.throws(
    () =>
      catalog.prepare({
        toolId: "drive.files.get",
        parameters: { fileId: "abc", access_token: "secret" },
      }),
    /parameter/i,
  );
  assert.throws(() => catalog.prepare({ toolId: "drive.files.get", parameters: {} }), /fileId/);
  assert.throws(() => catalog.prepare({ toolId: "unknown.request", parameters: {} }), /Unknown/i);
  assert.throws(
    () =>
      catalog.prepare({
        toolId: "gmail.users.messages.get",
        parameters: { userId: "someone@example.com", id: "abc" },
      }),
    /authenticated|me/i,
  );
});

test("request bodies validate nested schemas, enums and scalar types before dispatch", () => {
  const args = { toolId: "docs.documents.batchUpdate", parameters: { documentId: "doc" } };
  assert.throws(
    () => catalog.prepare({ ...args, body: { requests: [{ insertText: { text: 12 } }] } }),
    /text/,
  );
  assert.throws(
    () => catalog.prepare({ ...args, body: { requests: [{ inventedOperation: {} }] } }),
    /inventedOperation/,
  );
  assert.throws(
    () => catalog.prepare({ toolId: "drive.files.list", parameters: { pageSize: "ten" } }),
    /pageSize/,
  );
  assert.throws(
    () =>
      catalog.prepare({
        toolId: "gmail.users.messages.get",
        parameters: { userId: "me", id: "abc", format: "invented" },
      }),
    /format/,
  );
  assert.equal(
    catalog.prepare({
      ...args,
      body: { requests: [{ insertText: { text: "Olá", location: { index: 1 } } }] },
    }).method,
    "POST",
  );
});

test("downloads and multipart uploads retain their API identities and supplied metadata", () => {
  assert.equal(
    catalog.prepare({
      toolId: "drive.files.export",
      parameters: { fileId: "doc", mimeType: "text/plain" },
    }).download,
    true,
  );
  assert.equal(
    catalog.prepare({ toolId: "drive.files.get", parameters: { fileId: "doc", alt: "media" } })
      .download,
    true,
  );
  const upload = catalog.prepare({
    toolId: "drive.files.create",
    parameters: { fields: "id,name,mimeType" },
    body: { name: "Teste.txt" },
    upload: { mimeType: "text/plain", bytes: Buffer.from("Olá") },
  });
  assert.equal(new URL(upload.url).pathname, "/upload/drive/v3/files");
  assert.equal(new URL(upload.url).searchParams.get("uploadType"), "multipart");
  assert.match(upload.contentType ?? "", /^multipart\/related; boundary=/);
  assert.match(Buffer.from(upload.rawBody!).toString(), /Teste.txt/);
  assert.match(Buffer.from(upload.rawBody!).toString(), /Olá/);
});
