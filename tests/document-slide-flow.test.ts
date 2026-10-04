import assert from "node:assert/strict";
import test from "node:test";
import { DOMParser, type Element } from "@xmldom/xmldom";
import JSZip from "jszip";
import { composeDocument } from "../packages/integrations/src/document-model.ts";
import { createDocumentPptx } from "../packages/integrations/src/document-pptx.ts";

const emu = 914400;
const table =
  "| Conceito | Papel |\n| --- | --- |\n| Ferramenta | Executa |\n| Skill | Orienta |\n| Tarefa | Define |";
const fence = (kind: string, value: unknown) => `\`\`\`${kind}\n${JSON.stringify(value)}\n\`\`\``;
async function slides(content: string) {
  const bytes = await createDocumentPptx(composeDocument(content, "Guia", { cover: false }));
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)?.[1]) - Number(b.match(/slide(\d+)/)?.[1]));
  return Promise.all(
    names.map(async (name) =>
      new DOMParser().parseFromString(await zip.files[name].async("string"), "application/xml"),
    ),
  );
}
function bounds(element: Element) {
  const offset = element.getElementsByTagNameNS("*", "off")[0],
    extent = element.getElementsByTagNameNS("*", "ext")[0];
  assert.ok(offset && extent);
  const y = Number(offset.getAttribute("y")) / emu,
    h = Number(extent.getAttribute("cy")) / emu;
  return { y, bottom: y + h, h };
}
function textBox(document: ReturnType<DOMParser["parseFromString"]>, text: string) {
  const shape = Array.from(document.getElementsByTagName("p:sp")).find((element) =>
    element.textContent?.includes(text),
  );
  assert.ok(shape, `Missing native text: ${text}`);
  return bounds(shape as Element);
}

test("short table takeaway stays below the native table instead of creating an empty slide", async () => {
  const result = await slides(
    `## Ferramenta, skill ou tarefa?\n\n${table}\n\nExecuta • orienta • define.\n\n## Próximo assunto\n\nInformação adicional.`,
  );
  assert.equal(result.length, 2);
  const frame = result[0].getElementsByTagName("p:graphicFrame")[0];
  assert.ok(frame?.getElementsByTagName("a:tbl").length);
  const caption = textBox(result[0], "Executa • orienta • define.");
  assert.ok(caption.y >= bounds(frame).bottom + 0.18);
  assert.ok(caption.bottom <= 6.55);
});

test("a short chart caption reserves measured room without flattening or squeezing the chart", async () => {
  const chart = fence("chart", {
    title: "Exemplos",
    labels: ["Conversa", "Ferramentas", "Arquivos"],
    values: [1, 2, 3],
  });
  const result = await slides(
    `## Exemplos do guia\n\n${chart}\n\nA escala conta exemplos deste guia; não mede desempenho.`,
  );
  assert.equal(result.length, 1);
  const frame = result[0].getElementsByTagName("p:graphicFrame")[0];
  assert.ok(frame?.getElementsByTagName("c:chart").length);
  const caption = textBox(result[0], "A escala conta exemplos");
  assert.ok(bounds(frame).h >= 2.4);
  assert.ok(caption.y >= bounds(frame).bottom + 0.18);
  assert.ok(caption.bottom <= 6.55);
});

test("process caption uses space after the last visible step and preserves native step numbering", async () => {
  const steps = fence("steps", {
    items: [
      { title: "Entender", detail: "Definir o resultado." },
      { title: "Executar", detail: "Usar ferramentas reais." },
      { title: "Entregar", detail: "Conferir as evidências." },
    ],
  });
  const result = await slides(
    `## Do pedido à entrega\n\n${steps}\n\nCada etapa deixa evidências verificáveis.`,
  );
  assert.equal(result.length, 1);
  const caption = textBox(result[0], "Cada etapa deixa evidências");
  assert.ok(caption.y >= textBox(result[0], "Conferir as evidências.").bottom + 0.18);
  assert.ok(caption.bottom <= 6.55);
  const text = Array.from(result[0].getElementsByTagName("a:t")).map(
    (element) => element.textContent,
  );
  for (const number of ["01", "02", "03"]) assert.ok(text.includes(number));
});

test("large prose and explicit slide breaks keep their own slides after a figure", async () => {
  const prose = `Explicação detalhada: ${"Há informações que precisam de contexto suficiente e espaço próprio. ".repeat(35)} FINAL PRESERVADO.`;
  const result = await slides(`## Comparação\n\n${table}\n\n${prose}`);
  assert.ok(result.length >= 3);
  assert.ok(!result[0].documentElement?.textContent?.includes("Explicação detalhada"));
  assert.match(
    result.map((slide) => slide.documentElement?.textContent).join(" "),
    /FINAL PRESERVADO/,
  );
  const separated = await slides(
    `## Comparação\n\n${table}\n\n---\n\nOutra mensagem independente.`,
  );
  assert.equal(separated.length, 2);
  assert.ok(!separated[0].documentElement?.textContent?.includes("Outra mensagem independente"));
});

test("full tables and dense charts move even a short caption to a new slide", async () => {
  const fullTable = `| Item | Valor |\n| --- | --- |\n${Array.from({ length: 10 }, (_, index) => `| Linha ${index + 1} | Exemplo |`).join("\n")}`;
  const chart = fence("chart", {
    title: "Categorias",
    labels: Array.from({ length: 12 }, (_, index) => `Categoria ${index + 1}`),
    values: Array.from({ length: 12 }, (_, index) => index + 1),
  });
  for (const figure of [fullTable, chart]) {
    const result = await slides(`## Categorias\n\n${figure}\n\nLegenda curta preservada.`);
    assert.equal(result.length, 2);
    assert.ok(!result[0].documentElement?.textContent?.includes("Legenda curta preservada"));
    assert.ok(textBox(result[1], "Legenda curta preservada.").bottom <= 6.55);
  }
});
