import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDict, PDFDocument, PDFName, PDFString } from "pdf-lib";
import { composeDocument, runsText } from "../packages/integrations/src/document-model.ts";
import { createDesignedPdf } from "../packages/integrations/src/document-pdf.ts";

test("PDF source labels retain clickable link destinations", async () => {
  const bytes = await createDesignedPdf(
    "Leia a [documentação](https://example.org/guide).",
    "Fontes",
  );
  const pdf = await PDFDocument.load(bytes);
  const annotations = pdf.getPage(0).node.Annots();
  assert.ok(annotations && annotations.size() > 0);
  const link = annotations.lookup(0, PDFDict);
  const action = link.lookup(PDFName.of("A"), PDFDict);
  assert.equal(
    action.lookup(PDFName.of("URI"), PDFString).decodeText(),
    "https://example.org/guide",
  );
});

test("PDF preserves oversized headings across pages and code indentation", async () => {
  const bytes = await createDesignedPdf(
    `## ${"LongHeadingContent ".repeat(160)}\n\n\`\`\`python\ndef example():\n    return 42\n\`\`\``,
  );
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: bytes, useSystemFonts: false, verbosity: 0 });
  try {
    const pdf = await task.promise;
    const positions: { text: string; x: number; y: number }[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      for (const item of content.items)
        if ("str" in item)
          positions.push({ text: item.str, x: item.transform[4], y: item.transform[5] });
    }
    assert.equal(
      positions
        .map((p) => p.text)
        .join(" ")
        .match(/LongHeadingContent/g)?.length,
      160,
    );
    assert.ok(
      positions.filter((p) => p.text.includes("LongHeadingContent")).every((p) => p.y >= 62),
    );
    const start = positions.find((p) => p.text.startsWith("def"));
    const indented = positions.find((p) => p.text.startsWith("return"));
    assert.ok(start && indented && indented.x > start.x + 15);
  } finally {
    await task.destroy();
  }
});

test("document composition preserves semantic content and editable data", () => {
  const model = composeDocument(
    '# Guia\n\nUma **decisão** com [fonte](https://example.org).\n\n## Comparação\n\n| Etapa | Valor |\n|---|---|\n| Pesquisa | 20 |\n\n```chart\n{"title":"Tempo","labels":["Pesquisa","Produção"],"values":[20,30],"unit":"min"}\n```',
    "Guia",
  );
  assert.equal(model.title, "Guia");
  assert.equal(model.blocks[0].type, "paragraph");
  const paragraph = model.blocks.find((block) => block.type === "paragraph");
  assert.ok(paragraph && paragraph.type === "paragraph");
  assert.equal(runsText(paragraph.runs), "Uma decisão com fonte.");
  assert.ok(paragraph.runs.some((run) => run.bold && run.text === "decisão"));
  assert.ok(paragraph.runs.some((run) => run.href === "https://example.org"));
  assert.ok(model.blocks.some((block) => block.type === "table"));
  assert.ok(model.blocks.some((block) => block.type === "chart" && block.values[1] === 30));
});

test("authoring rejects unresolvable images and malformed numerical graphics", () => {
  assert.throws(() => composeDocument("![Photo](https://example.org/image.png)"), /owned|file:/i);
  assert.throws(
    () => composeDocument('```chart\n{"title":"X","labels":["A"],"values":[1,2]}\n```'),
    /chart|labels/i,
  );
  assert.throws(() => composeDocument("<script>alert(1)</script>"), /HTML/i);
});

test("nested mixed lists retain their own markers and numbering", () => {
  const block = composeDocument("1. Pai\n   - Filho\n2. Outro").blocks[0];
  assert.ok(block.type === "list");
  assert.deepEqual(
    block.items.map(({ level, ordered, number, listId }) => ({ level, ordered, number, listId })),
    [
      { level: 0, ordered: true, number: 1, listId: 0 },
      { level: 1, ordered: false, number: undefined, listId: 1 },
      { level: 0, ordered: true, number: 2, listId: 0 },
    ],
  );
});
