import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { taskCriteria } from "../apps/server/src/engine/task-verification.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("a successful-looking browser receipt with an unanswered dialog cannot complete the task", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", {
    prompt: "Submit this form in the browser",
  });
  const sessionId = randomUUID(),
    dialogId = randomUUID();
  assert.ok(task.criteria?.some((criterion) => criterion.effect === "browser"));
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
  const receipt = {
    sessionId,
    snapshotId: randomUUID(),
    url: "https://example.com/",
    text: "Successfully submitted",
    dialog: {
      id: dialogId,
      type: "confirm",
      message: "Confirm submission?",
      requiresApproval: false,
    },
  };
  await server.agent.journal.prepare("owner", {
    ...base,
    id: "pending-browser-click",
    toolName: "browser_act",
    bindingHash: "a".repeat(64),
    args: {},
    effect: true,
    receipt,
  });
  const pending = await server.agent.verification.assess(
    "owner",
    task.id,
    0,
    "The form was successfully submitted.",
  );
  assert.notEqual(pending.status, "verified");
  assert.ok(pending.remaining.some((message) => /dialog/i.test(message)));
  await server.agent.journal.prepare("owner", {
    ...base,
    id: "answered-browser-dialog",
    toolName: "browser_dialog",
    bindingHash: "b".repeat(64),
    args: { dialogId, accept: true },
    effect: true,
    receipt: {
      ...receipt,
      snapshotId: randomUUID(),
      dialog: undefined,
      response: { dialogId, accept: true },
    },
  });
  const finished = await server.agent.verification.assess(
    "owner",
    task.id,
    0,
    "The form was successfully submitted.",
  );
  assert.equal(finished.status, "verified", JSON.stringify(finished));
});

test("a reviewed browser click with a pending confirmation cannot certify completion", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", {
    prompt: "Submit this form in the browser",
  });
  const sessionId = randomUUID(),
    dialogId = randomUUID();
  await server.db.put("owner", "actions", {
    id: "reviewed-click-with-modal",
    taskId: task.id,
    kind: "external.action",
    status: "succeeded",
    dispatchedRevision: 0,
    createdAt: new Date().toISOString(),
    data: { tool: "browser.act" },
    result: JSON.stringify({
      sessionId,
      snapshotId: randomUUID(),
      url: "https://example.com/",
      text: "Successfully submitted",
      dialog: {
        id: dialogId,
        type: "confirm",
        message: "Confirm payment?",
        requiresApproval: true,
      },
    }),
  });
  const pending = await server.agent.verification.assess(
    "owner",
    task.id,
    0,
    "Submitted successfully",
  );
  assert.notEqual(pending.status, "verified");
  assert.ok(pending.remaining.some((text) => /dialog/i.test(text)));
});

test("renaming a document on a page requires the observed new name, without inventing a report", async (t) => {
  const server = await taskRuntime(t);
  const prompt =
    "Abra esta página e renomeie o documento para “Relatório trimestral”: https://example.com/document";
  const task = await server.agent.createTask("owner", { prompt });
  assert.ok(task.criteria?.some((c) => c.effect === "browser"));
  assert.ok(!task.criteria?.some((c) => c.kind === "artifact" || c.kind === "file"));
  assert.ok(
    !taskCriteria({
      kind: "agent",
      prompt:
        "Abra esta página e renomeie o documento para Relatório trimestral: https://example.com/document",
    }).some((c) => c.kind === "artifact"),
  );
  assert.ok(
    !taskCriteria({
      kind: "agent",
      prompt:
        "Exclua o documento “Relatório trimestral” nesta página: https://example.com/document",
    }).some((c) => c.kind === "artifact"),
  );
  const dialogId = randomUUID();
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
  const record = {
    ...base,
    id: "rename-dialog-response",
    toolName: "browser_dialog",
    bindingHash: "c".repeat(64),
    args: { dialogId, accept: true, promptText: "Relatório trimestral" },
    effect: true,
    receipt: {
      sessionId: randomUUID(),
      snapshotId: randomUUID(),
      url: "https://example.com/document",
      text: "Nome: Sem título",
      response: { dialogId, accept: true },
    },
  };
  await server.agent.journal.prepare("owner", record);
  assert.notEqual(
    (await server.agent.verification.assess("owner", task.id, 0)).status,
    "verified",
    "arguments alone cannot prove the new name",
  );
  await server.agent.journal.prepare("owner", {
    ...record,
    id: "confirmed-rename",
    receipt: {
      ...record.receipt,
      text: "Nome: Relatório trimestral\nNome salvo: Relatório trimestral. Alterações: 1.",
    },
  });
  assert.equal((await server.agent.verification.assess("owner", task.id, 0)).status, "verified");
  assert.ok(
    taskCriteria({
      kind: "agent",
      prompt: "Crie um relatório trimestral comparando custos e riscos.",
    }).some((c) => c.kind === "artifact"),
  );
});

test("account addresses and resource URLs do not turn Calendar or Drive requests into Gmail work", () => {
  for (const prompt of [
    "Na agenda da conta msant262@gmail.com, exclua o compromisso “Okami validação de agenda 10 outubro” de amanhã.",
    "Delete tomorrow's event from the calendar of person@gmail.com.",
    "Na agenda de person@gmail.com, exclua o compromisso e escreva a confirmação.",
    "Remova do Drive da conta person@gmail.com o arquivo antigo.",
    "Remova do Drive o arquivo https://drive.google.com/file/d/gmail/view.",
  ])
    assert.ok(
      !taskCriteria({ kind: "agent", prompt }).some((criterion) =>
        criterion.effect?.startsWith("email."),
      ),
      prompt,
    );
  assert.deepEqual(
    taskCriteria({
      kind: "agent",
      prompt:
        "Na agenda da conta msant262@gmail.com, exclua o compromisso “Okami validação de agenda 10 outubro” de amanhã.",
    }).map((criterion) => criterion.effect),
    ["calendar.delete"],
  );
  const mail = taskCriteria({
    kind: "agent",
    prompt: "Envie um e-mail para person@gmail.com.",
  });
  assert.deepEqual(mail.find((criterion) => criterion.effect === "email.send")?.requiredItems, [
    "person@gmail.com",
  ]);
  assert.ok(
    taskCriteria({
      kind: "agent",
      prompt: "Na conta person@gmail.com, exclua todos os e-mails antigos.",
    }).some((criterion) => criterion.effect === "email.delete"),
  );
  for (const prompt of [
    "Exclua o e-mail com o convite do evento na minha agenda.",
    "Delete the email about tomorrow's calendar event.",
    "Remova do Drive o arquivo com a lista de eventos.",
  ])
    assert.ok(
      !taskCriteria({ kind: "agent", prompt }).some(
        (criterion) => criterion.effect === "calendar.delete",
      ),
      prompt,
    );
});

test("email content does not invent file, send, deletion or organization obligations", () => {
  const prompts = [
    "Na minha conta msant262@gmail.com, escreva um e-mail para msant262@gmail.com com o assunto ‘Confirmação de recebimento’ e a mensagem ‘Olá, esta mensagem confirma o recebimento do documento. Obrigado!’.",
    'Write an email to me@example.test with subject "Send the PDF report" and body "Delete the old files and archive all emails."',
    "Escreva um e-mail com o assunto “Relatório” e o texto “Crie um documento no Google Docs e envie um email.”",
    "Escreva um e-mail dizendo ‘Apague todos os emails e marque um evento no calendário.’",
    "Escreva um e-mail avisando que o documento chegou.",
  ];
  for (const prompt of prompts)
    assert.deepEqual(
      taskCriteria({ kind: "agent", prompt }).map((criterion) => criterion.id),
      ["requested-gmail-draft"],
      prompt,
    );
  for (const prompt of [
    "Escreva um e-mail para me@example.test com o assunto ‘Documento’ e crie um PDF comparativo para anexar.",
    'Write an email with body "The document arrived." and attach a PDF comparison.',
    "Crie um documento TXT e escreva um e-mail para me@example.test contendo ‘Documento pronto.’",
  ]) {
    const ids = taskCriteria({ kind: "agent", prompt }).map((criterion) => criterion.id);
    assert.ok(ids.includes("requested-file"), prompt);
    assert.ok(ids.includes("requested-gmail-draft"), prompt);
  }
  assert.ok(
    taskCriteria({
      kind: "agent",
      prompt:
        "Envie um e-mail para me@example.test com o assunto ‘Não envie’ e a mensagem ‘Documento recebido.’",
    }).some((criterion) => criterion.id === "requested-send"),
    "an actual send instruction remains an obligation regardless of the quoted subject",
  );
});

test("looking up a message already sent does not require sending another email", () => {
  for (const prompt of [
    "Na conta msant262@gmail.com, procure em Enviados o e-mail com assunto “Confirmação de recebimento” que acabei de enviar para msant262@gmail.com e me diga o remetente, destinatário e texto da mensagem.",
    "Procure o email que acabamos de mandar e confirme o destinatário.",
    "Find the email I just sent and tell me the recipient.",
    "Read the email I was told to send and report its contents.",
  ])
    assert.ok(
      !taskCriteria({ kind: "agent", prompt }).some(
        (criterion) => criterion.effect === "email.send",
      ),
      prompt,
    );
  for (const prompt of [
    "Quero enviar um email para me@example.test.",
    "Pode enviar o email agora para me@example.test.",
    "Send the email to me@example.test.",
  ])
    assert.ok(
      taskCriteria({ kind: "agent", prompt }).some(
        (criterion) => criterion.effect === "email.send",
      ),
      prompt,
    );
});

test("reading or locating files does not invent a file-delivery obligation", () => {
  for (const prompt of [
    "Procure no computador os arquivos com ‘checag’ no nome e veja em qual linha aparece ‘orçamento’. Me diga o nome do arquivo e o texto dessa linha.",
    "Search the files named budget and tell me which file contains the total.",
    "Leia este PDF e me diga a data de vencimento.",
    "Read the CSV file and tell me the number of rows.",
    "Quero encontrar um PDF e saber a data de vencimento.",
    "Preciso ler o arquivo e descobrir o total.",
    "Explique como criar um arquivo PDF.",
    "Explain how to create a PDF file.",
    "Não gere um documento; apenas informe o valor.",
  ])
    assert.ok(
      !taskCriteria({ kind: "agent", prompt }).some((criterion) => criterion.kind === "file"),
      prompt,
    );
  for (const prompt of [
    "Pesquise três cursos gratuitos e me entregue um PDF comparativo.",
    "Crie um arquivo TXT chamado orçamento.txt com o total.",
    "Create a PDF comparison and attach it.",
    "Quero o resultado em PDF.",
    "Faz pra mim um PDF com o comparativo.",
    "Deliver the saved document.",
    "Read the CSV file and deliver it as a PDF.",
  ])
    assert.ok(
      taskCriteria({ kind: "agent", prompt }).some((criterion) => criterion.kind === "file"),
      prompt,
    );
});

test("actual page-image observations verify a read while partial, malformed or stale receipts do not", async (t) => {
  const runtime = await taskRuntime(t);
  const task = await runtime.agent.createTask("owner", {
    prompt: "Describe the images on my browser page.",
  });
  const receipt = {
    sessionId: randomUUID(),
    url: "https://example.com/",
    observedAt: new Date().toISOString(),
    partial: false,
    total: 1,
    nextOffset: null,
    images: [
      {
        src: "https://example.com/cover.svg",
        alt: "Course cover",
        width: 320,
        height: 180,
        frameUrl: "https://example.com/",
      },
    ],
  };
  const operation = {
    id: `${task.id}:images`,
    taskId: task.id,
    revision: 0,
    executorId: "native",
    executorEpoch: 1,
    resourceFence: 0,
    runToken: "test",
    resourceLeaseIds: [],
    createdAt: new Date().toISOString(),
    status: "succeeded" as const,
    toolName: "browser_get_images",
    bindingHash: "a".repeat(64),
    effect: false,
    args: { offset: 0, limit: 50 },
    receipt,
  };
  for (const [label, changes, expected] of [
    ["actual", {}, true],
    ["complete-empty", { receipt: { ...receipt, images: [], total: 0 } }, true],
    ["partial-positive", { receipt: { ...receipt, partial: true } }, false],
    ["partial-empty", { receipt: { ...receipt, partial: true, images: [], total: 0 } }, false],
    ["malformed", { receipt: { images: receipt.images } }, false],
    ["failed", { status: "failed" }, false],
    ["wrong-revision", { revision: 1 }, false],
    ["another-task", { taskId: "another-task" }, false],
  ] as const) {
    await runtime.db.put("owner", "task-operations", { ...operation, ...changes });
    const assessed = await runtime.agent.verification.assess(
      "owner",
      task.id,
      0,
      label === "complete-empty" ? "The page has no HTTP images." : "The page shows Course cover.",
    );
    assert.equal(assessed.status === "verified", expected, `${label}: ${JSON.stringify(assessed)}`);
  }
});

test("console and CDP observations require typed current receipts, retained logs and the requested command", async (t) => {
  const runtime = await taskRuntime(t);
  const task = await runtime.agent.createTask("owner", {
    prompt: "Inspect my browser page for JavaScript errors.",
  });
  const base = {
    sessionId: randomUUID(),
    url: "https://example.com/",
    observedAt: new Date().toISOString(),
  };
  const log = {
    ...base,
    entries: [
      {
        sequence: 1,
        source: "exception",
        level: "error",
        text: "Observed JavaScript error",
        recordedAt: new Date().toISOString(),
        truncated: false,
      },
    ],
    nextAfter: null,
    dropped: 0,
    cleared: false,
  };
  const protocol = { ...base, method: "Browser.getVersion", result: { product: "Chrome/fixture" } };
  const operation = {
    id: `${task.id}:diagnostics`,
    taskId: task.id,
    revision: 0,
    executorId: "native",
    executorEpoch: 1,
    resourceFence: 0,
    runToken: "test",
    resourceLeaseIds: [],
    createdAt: new Date().toISOString(),
    status: "succeeded",
    bindingHash: "a".repeat(64),
    effect: false,
    args: { command: { method: "Browser.getVersion" } },
  };
  for (const [label, toolName, receipt, changes, expected] of [
    ["console", "browser_console", log, {}, true],
    ["dropped", "browser_console", { ...log, dropped: 1 }, {}, false],
    ["malformed-console", "browser_console", { entries: log.entries }, {}, false],
    ["CDP", "browser_cdp", protocol, {}, true],
    ["wrong-command", "browser_cdp", { ...protocol, method: "DOM.getDocument" }, {}, false],
    ["malformed-CDP", "browser_cdp", { result: protocol.result }, {}, false],
    ["failed", "browser_cdp", protocol, { status: "failed" }, false],
    ["old-revision", "browser_cdp", protocol, { revision: 1 }, false],
    ["other-task", "browser_cdp", protocol, { taskId: "other" }, false],
  ] as const) {
    await runtime.db.put("owner", "task-operations", {
      ...operation,
      toolName,
      receipt,
      ...changes,
    });
    const assessed = await runtime.agent.verification.assess(
      "owner",
      task.id,
      0,
      "The browser inspection has current observed results.",
    );
    assert.equal(assessed.status === "verified", expected, `${label}: ${JSON.stringify(assessed)}`);
  }
});

test("a requested installed browser version cannot complete from a page title or console alone", async (t) => {
  const runtime = await taskRuntime(t);
  const task = await runtime.agent.createTask("owner", {
    prompt: "Abra example.com no computador do agente e confira a versão do navegador usado.",
  });
  assert.ok(task.criteria?.some((c) => c.id === "requested-browser-version"));
  const operation = {
    id: `${task.id}:version`,
    taskId: task.id,
    revision: 0,
    executorId: "native",
    executorEpoch: 1,
    resourceFence: 0,
    runToken: "test",
    resourceLeaseIds: [],
    createdAt: new Date().toISOString(),
    status: "succeeded",
    bindingHash: "a".repeat(64),
    effect: false,
    args: { command: { method: "Browser.getVersion" } },
    toolName: "browser_cdp",
  };
  const base = {
    sessionId: randomUUID(),
    url: "https://example.com/",
    observedAt: new Date().toISOString(),
  };
  for (const [label, receipt, expected] of [
    ["console only", { ...base, entries: [], dropped: 0, nextAfter: null, cleared: false }, false],
    ["missing version", { ...base, method: "Browser.getVersion", result: {} }, false],
    [
      "actual version",
      { ...base, method: "Browser.getVersion", result: { product: "Chrome/150.0.0.1" } },
      true,
    ],
  ] as const) {
    await runtime.db.put("owner", "task-operations", {
      ...operation,
      toolName: label === "console only" ? "browser_console" : "browser_cdp",
      receipt,
    });
    const assessed = await runtime.agent.verification.assess(
      "owner",
      task.id,
      0,
      "The installed browser is Chrome 150.0.0.1.",
    );
    assert.equal(assessed.status === "verified", expected, label);
  }
});

test("owned native search observations verify a lookup, including bounded positive matches, without accepting incomplete absence", async (t) => {
  const runtime = await taskRuntime(t);
  const task = await runtime.agent.createTask("owner", {
    prompt: "Procure os arquivos com checag no nome e informe a linha com orçamento.",
  });
  const receipt = {
    path: "/workspace",
    target: "content",
    outputMode: "content",
    order: "discovery",
    results: [{ path: "/workspace/checagem.txt", line: 1, content: "O orçamento é 200 euros." }],
    offset: 0,
    nextOffset: null,
    complete: true,
    totalMatches: 1,
    entriesScanned: 2,
    bytesRead: 27,
    skippedFiles: 0,
    limits: [],
    scope: "owned_utf8_files_up_to_256KB",
    guidance: "Only observed owned files; incomplete scans do not prove absence.",
  };
  const operation = {
    id: `${task.id}:search`,
    taskId: task.id,
    revision: 0,
    executorId: "native",
    executorEpoch: 1,
    resourceFence: 0,
    runToken: "test",
    resourceLeaseIds: [],
    createdAt: new Date().toISOString(),
    status: "succeeded" as const,
    toolName: "search_files",
    bindingHash: "a".repeat(64),
    effect: false,
    args: { path: "/workspace", pattern: "orçamento", target: "content" },
    receipt,
  };
  for (const [label, changes, expected] of [
    ["actual", {}, true],
    [
      "bounded-positive",
      { receipt: { ...receipt, complete: false, nextOffset: 1, totalMatches: null } },
      true,
    ],
    ["complete-absence", { receipt: { ...receipt, results: [], totalMatches: 0 } }, true],
    [
      "incomplete-absence",
      { receipt: { ...receipt, complete: false, results: [], totalMatches: null } },
      false,
    ],
    ["malformed", { receipt: { results: receipt.results } }, false],
    ["failed", { status: "failed" }, false],
    ["wrong-revision", { revision: 1 }, false],
    ["another-task", { taskId: "another-task" }, false],
  ] as const) {
    await runtime.db.put("owner", "task-operations", { ...operation, ...changes });
    const assessed = await runtime.agent.verification.assess(
      "owner",
      task.id,
      0,
      label === "complete-absence"
        ? "Nenhuma correspondência nessa área pesquisada."
        : "checagem.txt, linha 1: O orçamento é 200 euros.",
    );
    assert.equal(assessed.status === "verified", expected, `${label}: ${JSON.stringify(assessed)}`);
  }
});

test("native command output is a current observation only after successful confirmed execution", async (t) => {
  const runtime = await taskRuntime(t);
  const task = await runtime.agent.createTask("owner", { prompt: "Confira o total e me informe." });
  const receipt = {
    id: "job",
    command: "cat /workspace/total.txt",
    cwd: "/workspace",
    status: "succeeded",
    exitCode: 0,
    stdout: "200 euros\n",
    stderr: "",
    truncated: false,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    cleanupConfirmed: true,
  };
  for (const [label, changes, expected] of [
    ["actual", {}, true],
    ["pending", { status: "running", exitCode: undefined }, false],
    ["failed", { status: "failed", exitCode: 1 }, false],
    ["unknown", { outcomeUnknown: true }, false],
    ["nonzero", { exitCode: 1 }, false],
    ["empty", { stdout: "" }, false],
    ["malformed", { command: undefined }, false],
  ] as const) {
    await runtime.db.put("owner", "task-operations", {
      id: `${task.id}:command`,
      taskId: task.id,
      revision: 0,
      executorId: "native",
      executorEpoch: 1,
      resourceFence: 0,
      runToken: "test",
      resourceLeaseIds: [],
      createdAt: new Date().toISOString(),
      status: "succeeded",
      toolName: "run_computer_command",
      bindingHash: "a".repeat(64),
      effect: true,
      args: { command: receipt.command },
      receipt: { ...receipt, ...changes },
    });
    const assessed = await runtime.agent.verification.assess(
      "owner",
      task.id,
      0,
      "O total é 200 euros.",
    );
    assert.equal(assessed.status === "verified", expected, label);
  }
});

test("create then replace delivers the edited bytes rather than requiring the obsolete source literal", async (t) => {
  const server = await taskRuntime(t);
  const prompt =
    "Crie um arquivo TXT chamado checagem-edicao.txt contendo “O orçamento é 100 euros.”. Depois troque 100 por 200 nesse arquivo e me entregue a versão atualizada.";
  const task = await server.agent.createTask("owner", { prompt });
  assert.deepEqual(
    task.criteria?.find((criterion) => criterion.id === "requested-file")?.requiredItems,
    ["O orçamento é 200 euros."],
  );
  const updated = Buffer.from("O orçamento é 200 euros.");
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const patch = await server.agent.journal.prepare("owner", {
    id: `${task.id}:patch`,
    taskId: task.id,
    revision: 0,
    executorId: "native",
    executorEpoch: 1,
    resourceFence: 0,
    runToken: "test",
    resourceLeaseIds: [],
    createdAt: new Date().toISOString(),
    status: "succeeded",
    toolName: "patch",
    bindingHash: "a".repeat(64),
    effect: true,
    args: { path: "checagem-edicao.txt", old_string: "100", new_string: "200" },
    receipt: {
      path: "/workspace/checagem-edicao.txt",
      status: "succeeded",
      replacements: 1,
      beforeSha256: sha(Buffer.from("O orçamento é 100 euros.")),
      afterSha256: sha(updated),
    },
  });
  for (const [label, bytes, exportPath, expected] of [
    ["updated", updated, "checagem-edicao.txt", true],
    ["obsolete", Buffer.from("O orçamento é 100 euros."), "checagem-edicao.txt", false],
    ["unrelated", updated, "another.txt", false],
    [
      "changed-after-patch",
      Buffer.from("O orçamento é 200 euros. Extra!"),
      "checagem-edicao.txt",
      false,
    ],
  ] as const) {
    const file = await server.files.importAttachment("owner", `${label}.txt`, bytes, "Fixture");
    const changed = await server.db.compareAndSwapTask(
      "owner",
      task.id,
      { status: "queued" },
      {
        artifactIds: [file.id],
      },
    );
    assert.ok(changed);
    const exported = await server.agent.journal.prepare("owner", {
      ...patch,
      id: `${task.id}:${label}`,
      toolName: "export_computer_file",
      effect: false,
      args: { path: exportPath },
      receipt: { fileId: file.id, attachment: true },
    });
    const assessment = await server.agent.verification.assess("owner", task.id, 0);
    assert.equal(assessment.status === "verified", expected, JSON.stringify({ label, assessment }));
    await server.db.remove("owner", "task-operations", exported.id);
  }
  assert.deepEqual(
    taskCriteria({
      kind: "agent",
      prompt: "Create a TXT containing ‘Old amount.’ Then replace ‘Old amount.’ with '$& new'.",
    }).find((criterion) => criterion.id === "requested-file")?.requiredItems,
    ["$& new"],
    "quoted replacements retain literal dollar sequences",
  );
  assert.deepEqual(
    taskCriteria({
      kind: "agent",
      prompt: "Create a TXT containing ‘Keep 100.’ Required fields: total, status.",
    }).find((criterion) => criterion.id === "requested-file")?.requiredItems,
    ["total", "status"],
    "explicit independent field obligations stay mandatory",
  );
});

test("a requested exact text literal is content, while mandatory section labels still need their own body", async (t) => {
  const server = await taskRuntime(t);
  for (const [prompt, body, expected] of [
    ["Create a TXT containing ‘Hello, world.’", "Hello, world.", true],
    ["Create a TXT containing ‘Hello, world.’", "Hello world", false],
    ["Create a TXT. Required sections: Total, Status.", "Total\nStatus", false],
    [
      "Create a TXT. Required sections: Total, Status.",
      "Total\n200 euros\nStatus\nConfirmed",
      true,
    ],
  ] as const) {
    const task = await server.agent.createTask("owner", { prompt });
    const file = await server.files.importAttachment(
      "owner",
      "literal.txt",
      Buffer.from(body),
      "Fixture",
    );
    await server.db.compareAndSwapTask(
      "owner",
      task.id,
      { status: "queued" },
      { artifactIds: [file.id] },
    );
    assert.equal(
      (await server.agent.verification.assess("owner", task.id, 0)).status === "verified",
      expected,
      prompt,
    );
  }
});

test("literal edits require confirmed file changes rather than an unrequested download", async (t) => {
  const server = await taskRuntime(t);
  for (const prompt of [
    "Replace the unique price in patch-note.txt",
    "Substitua 100 por 200 no arquivo valores.txt",
  ]) {
    const task = await server.agent.createTask("owner", { prompt });
    assert.ok(!task.criteria?.some((criterion) => criterion.kind === "file"));
    assert.ok(task.criteria?.some((criterion) => criterion.id === "requested-workspace-edit"));
    assert.notEqual(
      (await server.agent.verification.assess("owner", task.id, 0)).status,
      "verified",
    );
    const target = prompt.includes("patch-note.txt")
      ? "/workspace/patch-note.txt"
      : "/workspace/valores.txt";
    for (const [status, revision, path, expected] of [
      ["rejected_not_dispatched", 0, target, false],
      ["outcome_unknown", 0, target, false],
      ["succeeded", 1, target, false],
      ["succeeded", 0, "/workspace/other.txt", false],
      ["succeeded", 0, target, true],
    ] as const) {
      const op = await server.agent.journal.prepare("owner", {
        id: `${task.id}:${status}:${revision}:${path.split("/").at(-1)}`,
        taskId: task.id,
        revision,
        executorId: "vps",
        executorEpoch: 1,
        resourceFence: 0,
        runToken: "test",
        resourceLeaseIds: [],
        createdAt: new Date().toISOString(),
        status,
        toolName: "patch",
        bindingHash: "a".repeat(64),
        effect: true,
        args: { path: target, old_string: "100", new_string: "200" },
        receipt: {
          path,
          status: "succeeded",
          replacements: 1,
          beforeSha256: "1".repeat(64),
          afterSha256: "2".repeat(64),
        },
      });
      assert.equal(
        (await server.agent.verification.assess("owner", task.id, 0)).status === "verified",
        expected,
      );
      await server.db.remove("owner", "task-operations", op.id);
    }
  }
  assert.ok(
    taskCriteria({
      kind: "agent",
      prompt: "Replace the price in values.txt and deliver the corrected file.",
    }).some((criterion) => criterion.kind === "file"),
  );
});

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

test("an executed Code Mode program is valid execution, while a shell or Python request needs its own runtime", async (t) => {
  const server = await taskRuntime(t);
  for (const [prompt, status, revision, expected] of [
    ["Execute um programa para calcular os números primos.", "completed", 0, true],
    ["Execute um programa para calcular os números primos.", "failed", 0, false],
    ["Execute um programa para calcular os números primos.", "completed", 1, false],
    ["Run a Python program to calculate primes.", "completed", 0, false],
    ["Run the command python3 primes.py.", "completed", 0, false],
  ] as const) {
    const task = await server.agent.createTask("owner", { prompt });
    await server.agent.journal.prepare("owner", {
      id: `code:${task.id}`,
      taskId: task.id,
      revision,
      executorId: "vps",
      executorEpoch: 1,
      resourceFence: 0,
      runToken: "test",
      resourceLeaseIds: [],
      createdAt: new Date().toISOString(),
      status: "succeeded",
      toolName: "execute_code",
      bindingHash: "a".repeat(64),
      effect: false,
      args: {
        code: "const p=[];for(let n=2;n<=100;n++){let prime=true;for(let d=2;d*d<=n;d++){if(n%d===0){prime=false;break;}}if(prime)p.push(n);}text(p);",
      },
      receipt: {
        status,
        output: [{ type: "text", text: "2,3,5,7" }],
        value: null,
        toolCallCount: 0,
      },
    });
    const result = await server.agent.verification.assess("owner", task.id, 0);
    assert.equal(
      result.checks.find((c) => c.criterionId === "requested-command")?.passed,
      expected,
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
