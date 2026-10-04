import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import fontkit from "@pdf-lib/fontkit";
import { DOMParser, type Element } from "@xmldom/xmldom";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { composeDocument } from "../packages/integrations/src/document-model.ts";
import { createDocumentPptx } from "../packages/integrations/src/document-pptx.ts";

const emu = 914400;
const table =
  "| Conceito | Papel |\n| --- | --- |\n| Ferramenta | Executa |\n| Skill | Orienta |\n| Tarefa | Define |";
const fence = (kind: string, value: unknown) => `\`\`\`${kind}\n${JSON.stringify(value)}\n\`\`\``;
const listRegression = `# O harness coordena o trabalho

O harness liga conversa, ferramentas, serviços e entrega.

1. O modelo interpreta o pedido e seleciona uma ferramenta registrada, com argumentos estruturados.
2. O servidor valida e executa a chamada; o resultado retorna como observação.
3. O ciclo continua com novas chamadas e verificações, se necessário.
4. Tarefas duráveis preservam objetivo, progresso, recibos e arquivos entre etapas.

- **Uma explicação importante** também precisa de espaço para seus trechos em negrito, *ênfase* e continuação legível.
  - Uma observação aninhada precisa respeitar o espaço do marcador e manter cada linha alinhada com a anterior.
`;
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

test("adjacent title and subtitle share a content slide while explicit dividers remain intentional", async () => {
  const heading = "Como o OkamiBot funciona",
    subtitle = "Guia do runtime observado · 4 de outubro de 2026",
    body = "O modelo conversa e escolhe ferramentas. O aplicativo valida e executa.";
  const result = await slides(`# ${heading}\n\n## ${subtitle}\n\n${body}`);
  assert.equal(result.length, 1, "consecutive headings must not create an empty divider");
  const contents = result[0].documentElement?.textContent ?? "";
  for (const expected of [heading, subtitle, body])
    assert.ok(contents.replace(/\s+/g, " ").includes(expected));
  const separated = await slides(`# ${heading}\n\n---\n\n## ${subtitle}\n\n${body}`);
  assert.equal(separated.length, 2, "an explicit rule preserves a requested title divider");
  assert.ok(!separated[0].documentElement?.textContent?.includes(body));
});

test("consecutive figure headings retain their hierarchy without an extra slide", async () => {
  const result = await slides(`# Guia de trabalho\n\n## Conceitos principais\n\n${table}`);
  assert.equal(result.length, 1);
  const parent = textBox(result[0], "Guia de trabalho"),
    child = textBox(result[0], "Conceitos principais"),
    figure = result[0].getElementsByTagName("p:graphicFrame")[0];
  assert.ok(figure);
  assert.ok(parent.bottom < child.y);
  assert.ok(child.bottom < bounds(figure).y);
});

test("measured bullet lines fit after native indentation and cannot be wrapped a second time", async () => {
  const result = await slides(listRegression);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const [regular, bold, italic] = await Promise.all(
    ["DejaVuSans", "DejaVuSans-Bold", "DejaVuSans-Oblique"].map(async (name) =>
      pdf.embedFont(
        await readFile(new URL(`../packages/integrations/assets/${name}.ttf`, import.meta.url)),
      ),
    ),
  );
  let bullets = 0;
  for (const slide of result) {
    for (const shape of Array.from(slide.getElementsByTagName("p:sp"))) {
      const paragraph = shape.getElementsByTagName("a:p")[0];
      if (!paragraph) continue;
      const properties = paragraph.getElementsByTagName("a:pPr")[0];
      const bullet =
        properties?.getElementsByTagName("a:buAutoNum")[0] ??
        properties?.getElementsByTagName("a:buChar")[0];
      if (!bullet) continue;
      bullets++;
      const extent = shape.getElementsByTagName("a:ext")[0];
      assert.ok(extent);
      const available =
        (Number(extent.getAttribute("cx")) - Number(properties?.getAttribute("marL") ?? 0)) / 12700;
      const used = Array.from(paragraph.getElementsByTagName("a:r")).reduce((total, run) => {
        const style = run.getElementsByTagName("a:rPr")[0];
        const font =
          style?.getAttribute("b") === "1"
            ? bold
            : style?.getAttribute("i") === "1"
              ? italic
              : regular;
        return (
          total + font.widthOfTextAtSize(run.getElementsByTagName("a:t")[0]?.textContent ?? "", 21)
        );
      }, 0);
      assert.ok(used <= available, `native marker leaves ${available}pt but text uses ${used}pt`);
      assert.equal(shape.getElementsByTagName("a:bodyPr")[0]?.getAttribute("wrap"), "none");
    }
  }
  assert.equal(bullets, 6, "all original native markers and nesting remain editable");
});

test("rendered list lines stay inside the column with separated text bounds", {
  timeout: 120000,
}, async (t) => {
  const run = promisify(execFile);
  try {
    await run("libreoffice", ["--version"], { timeout: 10000 });
  } catch {
    t.skip("LibreOffice is required for the rendered line bounds regression");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "slide-list-bounds-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "list.pptx");
  await writeFile(
    path,
    await createDocumentPptx(composeDocument(listRegression, "Guia", { cover: false })),
  );
  await run(
    "libreoffice",
    [
      `-env:UserInstallation=${pathToFileURL(join(directory, "profile")).href}`,
      "--headless",
      "--nologo",
      "--nodefault",
      "--norestore",
      "--convert-to",
      "pdf",
      "--outdir",
      directory,
      path,
    ],
    { timeout: 60000 },
  );
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({
    data: new Uint8Array(await readFile(join(directory, "list.pdf"))),
    useWorkerFetch: false,
    verbosity: 0,
  });
  try {
    const pdf = await loading.promise;
    let observedLines = 0;
    let observedText = "";
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const lines: Array<{ baseline: number; y: number; bottom: number }> = [];
      const boxes: Array<{
        left: number;
        right: number;
        top: number;
        bottom: number;
        text: string;
      }> = [];
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim() || Math.abs(item.height - 21) > 0.1) continue;
        if (!/^(?:[•·]|\d+\.)$/.test(item.str.trim())) observedText += item.str;
        const style = content.styles[item.fontName];
        const top = page.view[3] - item.transform[5] - (style.ascent ?? 1) * item.height;
        const bottom = page.view[3] - item.transform[5] - (style.descent ?? -0.25) * item.height;
        const left = item.transform[4],
          right = left + item.width;
        assert.ok(right <= 12.27 * 72 + 1, `${item.str} overflows the text column`);
        for (const box of boxes)
          assert.ok(
            Math.min(right, box.right) - Math.max(left, box.left) < 0.5 ||
              Math.min(bottom, box.bottom) - Math.max(top, box.top) < 0.5,
            `slide ${number}: ${item.str} overlaps ${box.text}`,
          );
        boxes.push({ left, right, top, bottom, text: item.str });
        // The native bullet uses another font with a slightly shifted baseline.
        // Box intersections above still detect two text runs drawn over each other.
        const existing = lines.find(
          (line) => Math.abs(line.baseline - item.transform[5]) < 21 * 0.25,
        );
        if (existing) {
          existing.y = Math.min(existing.y, top);
          existing.bottom = Math.max(existing.bottom, bottom);
        } else lines.push({ baseline: item.transform[5], y: top, bottom });
      }
      lines.sort((a, b) => a.y - b.y);
      for (let index = 1; index < lines.length; index++)
        assert.ok(
          lines[index].y - lines[index - 1].bottom >= 1,
          `slide ${number}: lines overlap by ${lines[index - 1].bottom - lines[index].y}pt`,
        );
      observedLines += lines.length;
    }
    assert.ok(observedLines >= 12, "the fixture must wrap into multiple actual rendered lines");
    for (const block of composeDocument(listRegression).blocks) {
      const runs =
        block.type === "paragraph"
          ? [block.runs]
          : block.type === "list"
            ? block.items.map((item) => item.runs)
            : [];
      for (const text of runs.map((runs) => runs.map((run) => run.text).join("")))
        assert.ok(
          observedText.replace(/\s+/g, "").includes(text.replace(/\s+/g, "")),
          `render lost authored content: ${text}`,
        );
    }
  } finally {
    await loading.destroy();
  }
});
