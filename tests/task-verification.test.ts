import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { taskCriteria } from "../apps/server/src/engine/task-verification.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("an explicitly requested program cannot be completed by writing its expected output", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", {
    prompt:
      "Execute um programa para calcular os números primos de 1 a 100 e me entregue o resultado em um arquivo TXT.",
  });
  const file = await server.files.importAttachment(
    "owner",
    "primes.txt",
    Buffer.from(
      "2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97",
    ),
    "Fixture",
  );
  await server.db.compareAndSwapTask(
    "owner",
    task.id,
    { status: "queued" },
    {
      artifactIds: [file.id],
    },
  );
  const before = await server.agent.verification.assess("owner", task.id, 0);
  assert.notEqual(before.status, "verified");
  assert.ok(
    before.checks.some((check) => check.criterionId === "requested-command" && !check.passed),
  );
  for (const [name, status, exitCode, revision, expected] of [
    ["failed", "failed", 1, 0, false],
    ["nonzero", "succeeded", 1, 0, false],
    ["running", "running", undefined, 0, false],
    ["stale", "succeeded", 0, 1, false],
    ["actual-execution", "succeeded", 0, 0, true],
  ] as const) {
    const op = await server.agent.journal.prepare("owner", {
      id: name,
      taskId: task.id,
      revision,
      executorId: "vps",
      executorEpoch: 1,
      resourceFence: 0,
      runToken: "test",
      resourceLeaseIds: [],
      createdAt: new Date().toISOString(),
      status,
      toolName: "run_computer_command",
      bindingHash: "a".repeat(64),
      args: { command: "python3 /workspace/primes.py" },
      effect: true,
      receipt: { id: name, status, exitCode, stdout: "25 primes calculated" },
    });
    const assessment = await server.agent.verification.assess("owner", task.id, 0);
    assert.equal(assessment.status === "verified", expected, name);
    // Each case independently proves whether this receipt satisfies execution.
    await server.db.remove("owner", "task-operations", op.id);
  }
});

test("execution criteria distinguish running code from explaining or only writing it", () => {
  for (const prompt of [
    "Run a Python script and deliver its output in a TXT file.",
    "Rode o código para calcular o resultado.",
  ]) {
    assert.ok(
      taskCriteria({ kind: "agent", prompt }).some((criterion) => criterion.effect === "command"),
      prompt,
    );
  }
  for (const prompt of [
    "Escreva um programa em Python num arquivo TXT, sem executar.",
    "Não execute o programa, apenas explique o código.",
    "Explain how to run a program.",
    "Run a search and write a Python program in a TXT file, without executing it.",
  ]) {
    assert.ok(
      !taskCriteria({ kind: "agent", prompt }).some((criterion) => criterion.effect === "command"),
      prompt,
    );
  }
});

function officeZip(entries: Record<string, string>, advertisedSize?: number) {
  const chunks: Buffer[] = [],
    directory: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const filename = Buffer.from(name),
      source = Buffer.from(content),
      data = deflateRawSync(source);
    let crc = 0xffffffff;
    for (const byte of source) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30),
      central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(advertisedSize ?? source.length, 22);
    local.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(advertisedSize ?? source.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    chunks.push(local, filename, data);
    directory.push(central, filename);
    offset += local.length + filename.length + data.length;
  }
  const index = Buffer.concat(directory),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, index, end]);
}
const validDocx = {
  "[Content_Types].xml":
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  "_rels/.rels":
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  "word/document.xml":
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Requested agenda and useful result</w:t></w:r></w:p></w:body></w:document>',
};

test("native Google reads prove observations while discovery, writes and stale or invalid receipts do not", async (t) => {
  const server = await taskRuntime(t);
  const valid = {
    status: "succeeded",
    toolId: "gmail.users.messages.list",
    account: "owner@example.test",
    connectionId: "google-owner",
    data: { messages: [{ id: "mail-1" }] },
  };
  const cases = [
    { name: "confirmed-read", receipt: valid, expected: true },
    { name: "empty-read", receipt: { ...valid, data: {} }, expected: true },
    {
      name: "download-read",
      toolId: "drive.files.export",
      receipt: {
        ...valid,
        toolId: "drive.files.export",
        data: undefined,
        artifact: { id: "downloaded-file" },
      },
      expected: true,
    },
    {
      name: "read-post",
      toolId: "calendar.freebusy.query",
      receipt: { ...valid, toolId: "calendar.freebusy.query", data: { calendars: {} } },
      expected: true,
    },
    { name: "discovery", tool: "search_google_workspace_tools", receipt: valid, expected: false },
    {
      name: "description",
      tool: "describe_google_workspace_tool",
      receipt: valid,
      expected: false,
    },
    {
      name: "write",
      toolId: "gmail.users.messages.send",
      receipt: { ...valid, toolId: "gmail.users.messages.send" },
      expected: false,
    },
    { name: "mismatch", receipt: { ...valid, toolId: "calendar.events.list" }, expected: false },
    { name: "error", receipt: { ...valid, error: "Google unavailable" }, expected: false },
    {
      name: "pending",
      receipt: { ...valid, status: "pending", approvalRequired: true },
      expected: false,
    },
    { name: "missing-data", receipt: { ...valid, data: undefined }, expected: false },
    { name: "missing-account", receipt: { ...valid, account: "" }, expected: false },
    {
      name: "unknown-method",
      toolId: "google.invented.get",
      receipt: { ...valid, toolId: "google.invented.get" },
      expected: false,
    },
    { name: "stale", receipt: valid, revision: 1, expected: false },
  ];
  for (const entry of cases) {
    const task = await server.agent.createTask("owner", {
      prompt: "Check my Gmail and Calendar with native Google reads.",
      criteria: [
        {
          id: "native-observation",
          kind: "observation",
          description: "A confirmed native Google read",
          referenceId: entry.name,
          requiredItems: [],
        },
      ],
    });
    await server.agent.journal.prepare("owner", {
      taskId: task.id,
      id: entry.name,
      revision: entry.revision ?? 0,
      executorId: "vps",
      executorEpoch: 1,
      resourceFence: 0,
      runToken: "test",
      resourceLeaseIds: [],
      createdAt: new Date().toISOString(),
      status: "succeeded",
      toolName: entry.tool ?? "execute_google_workspace_tool",
      bindingHash: "a".repeat(64),
      args: { toolId: entry.toolId ?? valid.toolId },
      effect: true,
      receipt: entry.receipt,
    });
    const assessment = await server.agent.verification.assess("owner", task.id, 0);
    assert.equal(assessment.status === "verified", entry.expected, entry.name);
  }
});

test("file and email obligations require their own relevant evidence", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", {
    prompt: "Crie um arquivo TXT com a agenda e envie por email para wife@example.test",
  });
  const file = await server.files.importAttachment(
    "owner",
    "agenda.txt",
    Buffer.from("Agenda: meet at 10:00"),
    "Fixture",
  );
  await server.db.compareAndSwapTask(
    "owner",
    task.id,
    { status: "queued" },
    { artifactIds: [file.id] },
  );
  const assessment = await server.agent.verification.assess("owner", task.id, 0);
  assert.notEqual(assessment.status, "verified");
  assert.equal(assessment.checks.length, 2, "one file cannot discard a requested send");
  await server.db.put("owner", "actions", {
    id: "wrong-recipient",
    taskId: task.id,
    kind: "email.send",
    status: "succeeded",
    dispatchedRevision: 0,
    data: { to: ["someone-else@example.test"] },
    result: "Provider sent id 123",
  });
  assert.notEqual((await server.agent.verification.assess("owner", task.id, 0)).status, "verified");
  await server.db.put("owner", "actions", {
    id: "right-recipient",
    taskId: task.id,
    kind: "email.send",
    status: "succeeded",
    dispatchedRevision: 0,
    data: { to: ["wife@example.test"] },
    result: "Provider sent id 124",
  });
  assert.equal((await server.agent.verification.assess("owner", task.id, 0)).status, "verified");
});

test("Office packages require strict XML, relationships and bounded useful document content", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", { prompt: "Create a DOCX document" });
  for (const [name, bytes, expected] of [
    [
      "not-xml",
      officeZip({ "[Content_Types].xml": "not xml", "word/document.xml": "not xml either" }),
      false,
    ],
    [
      "wrong-root",
      officeZip({ ...validDocx, "word/document.xml": "<unrelated>useful words</unrelated>" }),
      false,
    ],
    [
      "missing-relationship",
      officeZip({
        "[Content_Types].xml": validDocx["[Content_Types].xml"],
        "word/document.xml": validDocx["word/document.xml"],
      }),
      false,
    ],
    [
      "recovered-xml",
      officeZip({
        ...validDocx,
        "word/document.xml": validDocx["word/document.xml"].replace("</w:t>", ""),
      }),
      false,
    ],
    [
      "empty",
      officeZip({
        ...validDocx,
        "word/document.xml":
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
      }),
      false,
    ],
    [
      "entity",
      officeZip({
        ...validDocx,
        "word/document.xml": `<!DOCTYPE doc [<!ENTITY unsafe "data">]>${validDocx["word/document.xml"]}`,
      }),
      false,
    ],
    ["too-large", officeZip(validDocx, 3 * 1024 * 1024), false],
    ["valid", officeZip(validDocx), true],
  ] as const) {
    const file = await server.files.importAttachment("owner", `${name}.docx`, bytes, "Fixture");
    await server.db.compareAndSwapTask(
      "owner",
      task.id,
      { status: "queued" },
      { artifactIds: [file.id] },
    );
    assert.equal(
      (await server.agent.verification.assess("owner", task.id, 0)).status === "verified",
      expected,
      name,
    );
  }
});

test("read receipts cannot satisfy a command effect; a completed owned command can", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", { prompt: "Run a bounded command" });
  const base = {
    taskId: task.id,
    revision: 0,
    executorId: "vps",
    executorEpoch: 1,
    resourceFence: 0,
    runToken: "test",
    resourceLeaseIds: [],
    createdAt: new Date().toISOString(),
    status: "succeeded" as const,
  };
  await server.agent.journal.prepare("owner", {
    ...base,
    id: "read-receipt",
    toolName: "read_computer_file",
    bindingHash: "a".repeat(64),
    args: { path: "/workspace/report.txt" },
    effect: false,
    receipt: { id: "read", status: "succeeded", content: "Complete" },
  });
  assert.equal((await server.agent.verification.assess("owner", task.id, 0)).status, "unverified");
  await server.agent.journal.prepare("owner", {
    ...base,
    id: "command-receipt",
    toolName: "run_command",
    bindingHash: "b".repeat(64),
    args: { command: "true" },
    effect: true,
    receipt: { id: "command", status: "succeeded", exitCode: 0 },
  });
  assert.equal((await server.agent.verification.assess("owner", task.id, 0)).status, "verified");
});

test("spreadsheet and presentation verification follows their content relationships", async (t) => {
  const server = await taskRuntime(t);
  const typesNs = "http://schemas.openxmlformats.org/package/2006/content-types",
    relsNs = "http://schemas.openxmlformats.org/package/2006/relationships",
    officeNs = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  for (const format of ["xlsx", "pptx"] as const) {
    const workbook = format === "xlsx",
      main = workbook ? "xl/workbook.xml" : "ppt/presentation.xml",
      part = workbook ? "xl/worksheets/sheet1.xml" : "ppt/slides/slide1.xml";
    const ns = workbook
      ? "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
      : "http://schemas.openxmlformats.org/presentationml/2006/main";
    const entries = {
      "[Content_Types].xml": `<Types xmlns="${typesNs}"><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${workbook ? "spreadsheetml.sheet" : "presentationml.presentation"}.main+xml"/><Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${workbook ? "spreadsheetml.worksheet" : "presentationml.slide"}+xml"/></Types>`,
      "_rels/.rels": `<Relationships xmlns="${relsNs}"><Relationship Id="main" Type="${officeNs}/officeDocument" Target="${main}"/></Relationships>`,
      [main]: workbook
        ? `<workbook xmlns="${ns}" xmlns:r="${officeNs}"><sheets><sheet name="Result" sheetId="1" r:id="content"/></sheets></workbook>`
        : `<p:presentation xmlns:p="${ns}" xmlns:r="${officeNs}"><p:sldIdLst><p:sldId id="256" r:id="content"/></p:sldIdLst></p:presentation>`,
      [workbook ? "xl/_rels/workbook.xml.rels" : "ppt/_rels/presentation.xml.rels"]:
        `<Relationships xmlns="${relsNs}"><Relationship Id="content" Type="${officeNs}/${workbook ? "worksheet" : "slide"}" Target="${workbook ? "worksheets/sheet1.xml" : "slides/slide1.xml"}"/></Relationships>`,
      [part]: workbook
        ? `<worksheet xmlns="${ns}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Requested result: completed analysis</t></is></c></row></sheetData></worksheet>`
        : `<p:sld xmlns:p="${ns}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Requested result: completed analysis</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    };
    const task = await server.agent.createTask("owner", {
      prompt: `Create a ${format} file`,
      criteria: [
        {
          id: "file",
          kind: "file",
          description: "Requested content",
          requiredItems: ["Requested result"],
        },
      ],
    });
    const file = await server.files.importAttachment(
      "owner",
      `result.${format}`,
      officeZip(entries),
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
      "verified",
      format,
    );
    const empty = await server.files.importAttachment(
      "owner",
      `empty.${format}`,
      officeZip({ ...entries, [part]: entries[part].replace(": completed analysis", "") }),
      "Fixture",
    );
    await server.db.compareAndSwapTask(
      "owner",
      task.id,
      { status: "queued" },
      { artifactIds: [empty.id] },
    );
    assert.notEqual(
      (await server.agent.verification.assess("owner", task.id, 0)).status,
      "verified",
      `${format} with only a heading must not verify`,
    );
    const broken = await server.files.importAttachment(
      "owner",
      `broken.${format}`,
      officeZip({ ...entries, [part]: "<unrelated>Requested result</unrelated>" }),
      "Fixture",
    );
    await server.db.compareAndSwapTask(
      "owner",
      task.id,
      { status: "queued" },
      { artifactIds: [broken.id] },
    );
    assert.equal(
      (await server.agent.verification.assess("owner", task.id, 0)).status,
      "unverified",
      format,
    );
  }
});

test("a convincing finish summary without the requested file is a partial delivery", async (t) => {
  await modelFixture(t, () => ({
    name: "finish_task",
    arguments: { summary: "The report is complete and saved." },
  }));
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await server.agent.createTask("owner", {
    prompt: "Create a report with the requested comparison",
    kind: "plan",
  });
  await server.agent.worker.tick();
  const saved = await server.agent.getTask("owner", task.id);
  assert.notEqual(saved.status, "succeeded");
  assert.equal(saved.completion?.status, "unverified");
  assert.ok(saved.completion?.remaining.length);
  assert.ok(saved.plan.some((step) => step.status === "pending"));
  assert.equal(
    (await server.agent.detail("owner", task.id)).artifacts.length,
    0,
    "finish text is not an artifact witness",
  );
});

test("empty or corrupt files and a missing external receipt cannot verify completion", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", {
    prompt: "Deliver a useful document and send its reply",
    criteria: [
      {
        id: "file",
        kind: "file",
        description: "A usable file",
        requiredItems: ["requested result"],
      },
      { id: "receipt", kind: "receipt", description: "A confirmed reply", requiredItems: [] },
    ],
  });
  const empty = await server.files.importAttachment(
    "owner",
    "empty.txt",
    new Uint8Array(),
    "Fixture",
  );
  await server.db.compareAndSwapTask(
    "owner",
    task.id,
    { status: "queued" },
    { artifactIds: [empty.id] },
  );
  const emptyAssessment = await server.agent.verification.assess("owner", task.id, 0);
  assert.equal(emptyAssessment.status, "unverified");
  assert.ok(emptyAssessment.checks.every((check) => !check.passed));
  assert.ok(emptyAssessment.checks.some((check) => check.criterionId === "requested-file"));
  await writeFile(join(server.directory, "files", `${empty.id}.pdf`), "not a PDF");
  await server.db.put("owner", "files", { ...empty, mimeType: "application/pdf", size: 9 });
  assert.equal((await server.agent.verification.assess("owner", task.id, 0)).status, "unverified");
});

test("new directions require new evidence and action receipts from their dispatched revision", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", {
    prompt: "Observe the result and confirm the send",
    criteria: [
      {
        id: "observation",
        kind: "observation",
        description: "A current observation",
        requiredItems: ["new value"],
      },
      {
        id: "receipt",
        kind: "receipt",
        description: "A current effect receipt",
        requiredItems: [],
      },
    ],
  });
  await server.db.compareAndSwapTask(
    "owner",
    task.id,
    { status: "queued" },
    {
      state: { ...task.state, desiredRevision: 1, appliedRevision: 1 },
      evidence: [
        {
          id: "old-observation",
          kind: "web",
          title: "Old observation",
          excerpt: "new value",
          acquiredAt: "2026-01-01T00:00:00Z",
          revision: 0,
        },
      ],
      artifactIds: [],
    },
  );
  await server.db.put("owner", "actions", {
    id: "old-send",
    taskId: task.id,
    status: "succeeded",
    result: "Provider receipt",
    dispatchedRevision: 0,
  });
  const assessment = await server.agent.verification.assess("owner", task.id, 1);
  assert.equal(assessment.status, "unverified");
  assert.deepEqual(
    assessment.checks.map((check) => check.passed),
    [false, false],
  );
  const mail = {
    id: "mail",
    threadId: "thread",
    sender: "Sender",
    label: "Inbox",
    from: "sender@example.test",
    to: ["user@example.test"],
    subject: "Cached mail",
    body: "old facts",
    date: "2026-01-01T00:00:00Z",
    unread: false,
    attachments: [],
  };
  assert.equal(
    server.agent.mailEvidence(mail).acquiredAt,
    undefined,
    "materializing a cached object does not refresh its acquisition time",
  );
});
