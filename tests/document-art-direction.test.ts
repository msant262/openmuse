import assert from "node:assert/strict";
import test from "node:test";
import { composeDocument } from "../packages/integrations/src/document-model.ts";
import { readPdfText } from "../packages/integrations/src/pdf-text.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const palette = {
  paper: "#FCFAF6",
  ink: "#252321",
  muted: "#59534A",
  accent: "#965427",
  surface: "#EBE4D8",
};
const design = {
  reference: "starbucks",
  layout: "editorial" as const,
  display: "serif" as const,
  palette,
  rationale: "Guia de leitura calmo: hierarquia editorial e tons terrosos da referência.",
};

test("an explicit visual direction changes the composed theme rather than being silently ignored", () => {
  const model = composeDocument("## Leitura\n\nConteúdo preservado.", "Guia", design);
  assert.equal(model.theme.paper, palette.paper);
  assert.equal(model.theme.accent, palette.accent);
  assert.equal(model.theme.display, "serif");
  assert.equal(
    composeDocument("Texto", "Guia", { ...design, display: "mono" }).theme.display,
    "mono",
  );
  assert.throws(
    () =>
      composeDocument("Texto", "Guia", {
        ...design,
        palette: { ...palette, muted: palette.paper },
      }),
    /contrast|contraste/i,
  );
});

test("a catalog reference outside the eight presets produces a real document and a replay-stable design receipt", async (t) => {
  const server = await taskRuntime(t);
  const args = {
    name: "guia.pdf",
    title: "Guia",
    format: "pdf",
    content: "## Leitura\n\nConteúdo preservado.",
    design,
    operationId: "starbucks-guide",
  };
  const result = await server.agent.media.createDocument("owner", args, "design-test");
  assert.ok(result.fileId);
  assert.ok(result.design);
  assert.match(
    await readPdfText(await server.files.bytes("owner", result.fileId)),
    /Conteúdo preservado/,
  );
  assert.equal(result.design.reference, "starbucks");
  assert.deepEqual(result.design.palette, palette);
  assert.deepEqual(await server.agent.media.createDocument("owner", args, "design-test"), result);
  const recent = await server.agent.media.recentDocumentDesigns("owner");
  assert.equal(recent[0].reference, "starbucks");
  assert.equal(recent[0].layout, "editorial");
  assert.deepEqual(await server.agent.media.recentDocumentDesigns("other-owner"), []);
});

test("unsupported references and incomplete adaptations never silently render with the default preset", async (t) => {
  const server = await taskRuntime(t);
  const args = { name: "guia.pdf", format: "pdf", content: "Texto", operationId: "invalid" };
  await assert.rejects(
    server.agent.media.createDocument(
      "owner",
      { ...args, design: { reference: "starbucks" } },
      "missing-palette",
    ),
    /palette|paleta/i,
  );
  await assert.rejects(
    server.agent.media.createDocument(
      "owner",
      { ...args, design: { ...design, reference: "invented-reference" } },
      "unknown",
    ),
    /reference|referência/i,
  );
  await assert.rejects(
    server.agent.media.createDocument(
      "owner",
      { ...args, design: { ...design, palette: { ...palette, paper: "url(file:///etc/passwd)" } } },
      "invalid-color",
    ),
  );
  assert.deepEqual(await server.agent.media.recentDocumentDesigns("owner"), []);
  assert.equal((await server.files.list("owner")).length, 0);
});
