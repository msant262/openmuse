import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import {
  configuredSecretScrubber,
  scrubConfiguredValue,
} from "../apps/server/src/configured-secrets.ts";
import { createDocumentDocx } from "../packages/integrations/src/document-docx.ts";
import { composeDocument } from "../packages/integrations/src/document-model.ts";
import { createDocumentPptx } from "../packages/integrations/src/document-pptx.ts";
import {
  inspectOfficeExport,
  smokeOperationEvidence,
  smokeProviderDiagnostics,
} from "../scripts/harness-delivery-smoke.mjs";

test("provider diagnostics retain exact admission numbers without checkpoint content or credentials", () => {
  const secret = "diagnostic-secret-do-not-export";
  const requirements = {
    tools: true,
    vision: true,
    structuredOutput: false,
    contextTokens: 141200,
  };
  const value = smokeProviderDiagnostics(
    {
      state: {
        providerCheckpoint: {
          code: "MODEL_CAPABILITY_UNAVAILABLE",
          rejectedModel: "openai/fixture",
          accepted: false,
          partialText: secret,
          messages: [
            {
              role: "assistant",
              content: secret,
              toolCalls: [{ function: { arguments: secret } }],
            },
            { role: "tool", content: "document private body", toolCallId: "doc" },
          ],
          admission: {
            stage: "context_projection",
            requirements: { ...requirements, credential: secret },
            prompt: secret,
            candidates: [
              {
                model: "openai/fixture",
                capabilities: { ...requirements, contextTokens: 131072 },
                eligible: false,
                considered: true,
                cooldownUntil: 0,
                capabilitySource: "declared",
                accessToken: secret,
              },
            ],
          },
        },
      },
    },
    (input) => scrubConfiguredValue(input, configuredSecretScrubber([secret])),
  );
  assert.deepEqual(value.admission.requirements, requirements);
  assert.equal(value.admission.candidates[0].capabilities.contextTokens, 131072);
  assert.equal(value.history.messages, 2);
  assert.equal(value.history.toolCalls, 1);
  assert.equal(value.history.toolReceipts, 1);
  assert.doesNotMatch(
    JSON.stringify(value),
    /credential|accessToken|partialText|private body|arguments|diagnostic-secret/,
  );
  assert.equal(
    smokeProviderDiagnostics({ state: {} }, (value) => value),
    undefined,
  );
});

test("smoke preserves exact document call IDs, revisions and errors while bounding scrubbed prose", () => {
  const secret = "do-not-export-this-credential";
  const scrub = (value) => scrubConfiguredValue(value, configuredSecretScrubber([secret]));
  const skill = smokeOperationEvidence(
    {
      toolName: "skills_read",
      status: "succeeded",
      toolCallId: "read-skill",
      args: { id: "builtin:slides" },
      receipt: {
        id: "builtin:slides",
        source: "builtin",
        content: `Private workflow ${secret}`,
        sha256: "a".repeat(64),
        truncated: false,
      },
    },
    scrub,
  );
  assert.equal(skill.args.id, "builtin:slides");
  assert.equal(skill.output.sha256, "a".repeat(64));
  assert.ok(skill.output.contentBytes > 0);
  assert.equal(skill.output.contentSha256.length, 64);
  assert.equal(skill.output.content, undefined);
  assert.doesNotMatch(JSON.stringify(skill), /Private workflow|do-not-export/);
  const receiptId = "a".repeat(64),
    fileId = "b".repeat(64);
  const failed = smokeOperationEvidence(
    {
      id: "operation",
      taskId: "task-one",
      revision: 3,
      toolName: "confirm_document_review",
      toolCallId: "call-one",
      status: "failed",
      args: { receiptId, passed: true, issues: [] },
      receipt: { error: `Inspection does not belong to this task revision ${secret}` },
    },
    scrub,
  );
  assert.equal(failed.args.receiptId, receiptId);
  assert.equal(failed.revision, 3);
  assert.equal(failed.toolCallId, "call-one");
  assert.equal(failed.taskId, "task-one");
  assert.equal(failed.output.error, failed.error);
  assert.match(failed.error, /\[redacted\]/);
  assert.ok(!JSON.stringify(failed).includes(secret));

  const created = smokeOperationEvidence(
    {
      toolName: "create_document",
      status: "succeeded",
      args: { content: `${secret} ${"conteúdo ".repeat(2000)}`, operationId: "authored" },
      receipt: { fileId },
    },
    scrub,
  );
  assert.equal(created.args.content.omitted, true);
  assert.ok(created.args.content.journalCharacters > 4000);
  assert.equal(created.args.content.journalSha256.length, 64);
  assert.equal(created.output.fileId, fileId);
  assert.ok(!JSON.stringify(created).includes(secret));
  assert.ok(JSON.stringify(created).length < 1500);
  assert.deepEqual(
    smokeOperationEvidence(
      {
        toolName: "search_web",
        status: "succeeded",
        args: { query: secret },
        receipt: { content: "large unrelated result" },
      },
      scrub,
    ),
    { tool: "search_web", status: "succeeded" },
  );
});

const content = `## Como o assistente trabalha

O assistente recebe uma solicitação, identifica o contexto disponível e usa ferramentas registradas para realizar a tarefa. As capacidades dependem do ambiente e das conexões efetivamente configuradas.

## Componentes e responsabilidades

| Componente | Função |
| --- | --- |
| Ferramenta | Executa uma operação e retorna seu resultado. |
| Skill | Descreve um procedimento compatível com as ferramentas atuais. |
| Tarefa | Mantém o estado e as evidências da execução. |

## Limites e verificação

Os resultados precisam de evidência observável. A geração de um arquivo não comprova que sua composição visual foi revisada. Cada página deve ser renderizada e conferida antes da entrega.
`;

for (const format of ["docx", "pptx"])
  test(`smoke checks accept real native ${format} exports and reject flattened or renamed files`, async () => {
    const model = composeDocument(content, "Guia do assistente", { cover: false });
    const bytes = await (format === "docx" ? createDocumentDocx(model) : createDocumentPptx(model));
    const inspection = await inspectOfficeExport(bytes, format);
    assert.equal(inspection.nativeEditableText, true);
    assert.equal(inspection.nativeTables, 1);
    assert.ok(inspection.textCharacters > 200);
    assert.match(inspection.text, /procedimento compatível/);
    if (format === "pptx") assert.ok(inspection.slides >= 3);
    await assert.rejects(inspectOfficeExport(bytes, format === "docx" ? "pptx" : "docx"), /format/);
    await assert.rejects(inspectOfficeExport(Buffer.from("%PDF-1.7 renamed"), format));

    const zip = await JSZip.loadAsync(bytes);
    const paths = Object.keys(zip.files).filter((name) =>
      format === "docx" ? name === "word/document.xml" : /^ppt\/slides\/slide\d+\.xml$/.test(name),
    );
    for (const path of paths) {
      const source = await zip.file(path).async("string");
      zip.file(path, source.replace(/<(?:w|a):t(?:\s[^>]*)?>[\s\S]*?<\/(?:w|a):t>/g, ""));
    }
    await assert.rejects(
      inspectOfficeExport(await zip.generateAsync({ type: "nodebuffer" }), format),
      /editable text/,
    );
  });
