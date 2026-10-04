import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { createDocumentDocx } from "../packages/integrations/src/document-docx.ts";
import { composeDocument } from "../packages/integrations/src/document-model.ts";
import { createDocumentPptx } from "../packages/integrations/src/document-pptx.ts";
import { inspectOfficeExport } from "../scripts/harness-delivery-smoke.mjs";

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
