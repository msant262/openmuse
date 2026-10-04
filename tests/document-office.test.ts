import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import JSZip from "jszip";
import { officeContent } from "../apps/server/src/engine/task-office.ts";
import {
  documentAccentText,
  documentColorContrast,
} from "../packages/integrations/src/document-colors.ts";
import { createDocumentDocx } from "../packages/integrations/src/document-docx.ts";
import {
  composeDocument,
  defaultDocumentTheme,
} from "../packages/integrations/src/document-model.ts";
import { createDocumentPptx } from "../packages/integrations/src/document-pptx.ts";
import { readPdfText } from "../packages/integrations/src/pdf-text.ts";

const content = `## Clareza antes da execução

Um documento profissional organiza **evidências** com hierarquia e *respiro*. O conteúdo continua editável, incluindo [fontes](https://example.com/research).

1. Receber o pedido e verificar o contexto.
   - Conferir o material disponível.
     7. Validar a referência.
     8. Organizar a evidência.
2. Preparar uma entrega com evidência verificável.

> O resultado precisa ser legível, útil e conferido antes da entrega.

## Indicadores de exemplo

\`\`\`metrics
{"items":[{"label":"Conteúdo organizado","value":"3 etapas","detail":"Da intenção à entrega."},{"label":"Gráfico editável","value":"100%","detail":"Dados preservados no arquivo."},{"label":"Revisão visual","value":"Página a página","detail":"Conferir o resultado renderizado."}]}
\`\`\`

\`\`\`chart
{"title":"Distribuição ilustrativa de trabalho","labels":["Pesquisa","Composição","Revisão"],"values":[20,50,30],"unit":"%"}
\`\`\`

## Comparação das entregas

| Formato | Uso principal | Edição |
| --- | --- | --- |
| DOCX | Relatório com estrutura | Texto e tabelas nativos |
| PPTX | Apresentação visual | Objetos e gráficos nativos |

## Caminho até o resultado

\`\`\`steps
{"items":[{"title":"Compor","detail":"Organizar texto, gráficos e estrutura."},{"title":"Renderizar","detail":"Abrir o arquivo no mecanismo de apresentação."},{"title":"Conferir","detail":"Verificar cada página e preservar o conteúdo."}]}
\`\`\`

ÚLTIMA LINHA: a informação permanece íntegra.
`;
const model = () =>
  composeDocument(content, "Uma entrega que comunica", {
    eyebrow: "GUIA PRÁTICO",
    subtitle: "Estrutura, evidência e revisão visual",
    cover: true,
  });
const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const pptxMime = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("authored DOCX has native headings, numbering, styled tables and editable chart data", async () => {
  const bytes = await createDocumentDocx(model());
  const zip = await JSZip.loadAsync(bytes);
  const document = await zip.file("word/document.xml")?.async("string");
  assert.ok(document);
  assert.match(document, /w:pStyle w:val="Heading2"/);
  assert.match(document, /w:numPr/);
  assert.match(document, /w:tblHeader/);
  assert.match(document, /w:hyperlink/);
  assert.match(document, /c:chart/);
  const chartPath = Object.keys(zip.files).find((name) =>
    /^word\/charts\/chart\d+\.xml$/.test(name),
  );
  assert.ok(chartPath);
  const chart = await zip.file(chartPath)?.async("string");
  assert.match(chart ?? "", /<c:barChart>/);
  for (const value of [20, 50, 30]) assert.ok(chart?.includes(`<c:v>${value}</c:v>`));
  assert.ok(Object.keys(zip.files).some((name) => /word\/embeddings\/.*\.xlsx$/.test(name)));
  assert.match((await zip.file("word/styles.xml")?.async("string")) ?? "", /DejaVu Serif/);
  assert.match(officeContent(bytes, docxMime), /ÚLTIMA LINHA/);
  assert.equal(
    digest(await createDocumentDocx(model())),
    digest(bytes),
    "retry must keep the same package bytes",
  );
});

test("authored PPTX uses varied native layouts with editable tables, charts and rich text", async () => {
  const bytes = await createDocumentPptx(model());
  const zip = await JSZip.loadAsync(bytes);
  const paths = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  assert.ok(paths.length >= 7);
  const slides = await Promise.all(paths.map((name) => zip.files[name].async("string")));
  assert.ok(
    slides.some((xml) => xml.includes("<a:tbl>")),
    "table cells remain editable",
  );
  assert.ok(
    slides.some((xml) => xml.includes("<c:chart")),
    "chart is a chart, not a screenshot",
  );
  assert.ok(
    slides.some((xml) => xml.includes("<a:hlinkClick")),
    "inline source links are preserved",
  );
  assert.ok(
    slides.some((xml) => xml.includes('b="1"')),
    "inline emphasis is preserved",
  );
  assert.ok(slides.some((xml) => xml.includes('typeface="DejaVu Serif"')));
  const notes = await Promise.all(
    Object.keys(zip.files)
      .filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))
      .map((name) => zip.files[name].async("string")),
  );
  for (const layout of [
    "cover",
    "editorial-text",
    "pull-quote",
    "metric-cards",
    "data-chart",
    "comparison-table",
    "process",
  ])
    assert.ok(
      notes.some((xml) => xml.includes(layout)),
      `missing ${layout} composition`,
    );
  const chartPath = Object.keys(zip.files).find((name) =>
    /^ppt\/charts\/chart\d+\.xml$/.test(name),
  );
  assert.ok(chartPath);
  const chart = await zip.file(chartPath)?.async("string");
  for (const value of [20, 50, 30]) assert.ok(chart?.includes(`<c:v>${value}</c:v>`));
  assert.ok(Object.keys(zip.files).some((name) => /ppt\/embeddings\/.*\.xlsx$/.test(name)));
  assert.match(officeContent(bytes, pptxMime), /ÚLTIMA LINHA/);
  assert.equal(
    digest(await createDocumentPptx(model())),
    digest(bytes),
    "retry must keep the same package bytes",
  );
});

test("PPTX paginates long prose without silently dropping the final paragraph", async () => {
  const longWord = "X".repeat(230);
  const paragraphs = Array.from(
    { length: 45 },
    (_, index) => `Parágrafo ${index}: contexto, informações e revisão cuidadosa da entrega.`,
  );
  const bytes = await createDocumentPptx(
    composeDocument(`${paragraphs.join("\n\n")}\n\n${longWord}\n\nFINAL ÍNTEGRO`, "Relatório", {
      cover: false,
    }),
  );
  const text = officeContent(bytes, pptxMime);
  assert.match(text, /FINAL ÍNTEGRO/);
  assert.ok(text.replace(/\s/g, "").includes(longWord));
  for (let index = 0; index < 45; index++) assert.ok(text.includes(`Parágrafo ${index}:`));
  const zip = await JSZip.loadAsync(bytes);
  assert.ok(
    Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length > 3,
  );
});

test("PPTX preserves standalone section headings and a chart section label", async () => {
  const bytes = await createDocumentPptx(
    composeDocument(
      '## Primeiro capítulo\n\n## Dados da operação\n\n```chart\n{"title":"Distribuição","labels":["Pesquisa"],"values":[1]}\n```\n\n## Conclusão independente',
      "Cabeçalhos",
      { cover: false },
    ),
  );
  const text = officeContent(bytes, pptxMime).replace(/\s+/g, " ");
  for (const heading of [
    "Primeiro capítulo",
    "Dados da operação",
    "Distribuição",
    "Conclusão independente",
  ])
    assert.ok(text.includes(heading));
  const titleOnly = await createDocumentPptx(
    composeDocument("# Somente o título", undefined, { cover: false }),
  );
  assert.match(officeContent(titleOnly, pptxMime), /Somente o título/);
});

test("dense metric and process descriptions expand across slides with bounded editable objects", async () => {
  const metrics = {
    items: Array.from({ length: 3 }, (_, index) => ({
      value: `Resultado de qualidade ${index}`,
      label: "Conteúdo organizado e conferido com cuidado em cada parte da entrega",
      detail:
        "A descrição explica os detalhes relevantes sem reduzir o texto a um tamanho ilegível. ".repeat(
          2,
        ),
    })),
  };
  const steps = {
    items: Array.from({ length: 3 }, (_, index) => ({
      title: `Etapa ${index}: preparar uma entrega completa`,
      detail:
        "Preservar os fatos, organizar a estrutura e conferir cada página antes da entrega. ".repeat(
          4,
        ),
    })),
  };
  const heading =
    "Uma seção com título extenso que explica o propósito da informação apresentada e precisa manter os elementos da página dentro da área útil";
  const bytes = await createDocumentPptx(
    composeDocument(
      `## ${heading}\n\n\`\`\`metrics\n${JSON.stringify(metrics)}\n\`\`\`\n\n\`\`\`steps\n${JSON.stringify(steps)}\n\`\`\``,
      "Conteúdo denso",
      { cover: false },
    ),
  );
  const text = officeContent(bytes, pptxMime).replace(/\s+/g, " ");
  for (const item of metrics.items) assert.ok(text.includes(item.value));
  for (const item of steps.items) assert.ok(text.includes(item.title));
  const zip = await JSZip.loadAsync(bytes);
  const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  assert.ok(slides.length > 2, "dense blocks must paginate instead of shrink");
  for (const name of slides) {
    const xml = await zip.files[name].async("string");
    for (const box of xml.matchAll(
      /<a:xfrm[^>]*>\s*<a:off x="(\d+)" y="(\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/g,
    )) {
      const [x, y, width, height] = box.slice(1).map(Number);
      assert.ok(
        x + width <= 13.34 * 914400 && y + height <= 7.5 * 914400,
        `${name} contains an object outside the slide`,
      );
    }
  }
  assert.equal(documentAccentText("1DB954", ["FFFFFF"], "191414"), "191414");
  assert.ok(documentColorContrast("191414", "1DB954") >= 4.5);
});

test("four compact steps and a six-row comparison each fit a readable single slide", {
  timeout: 120000,
}, async (t) => {
  const steps = {
    items: [
      {
        title: "Entender o pedido",
        detail: "Usar a conversa e os materiais fornecidos para definir o resultado esperado.",
      },
      {
        title: "Escolher ferramentas",
        detail: "Consultar capacidades e estado das conexões; aplicar procedimentos relevantes.",
      },
      {
        title: "Executar e registrar",
        detail:
          "Validar argumentos, executar operações autorizadas e conservar os resultados observados.",
      },
      {
        title: "Verificar e entregar",
        detail: "Conferir conteúdo e aparência; publicar o arquivo na conversa de origem.",
      },
    ],
  };
  const rows = [
    [
      "Conversa",
      "Pedido e resultado",
      "A conversa registra o pedido e recebe o resultado da tarefa.",
    ],
    [
      "Ferramentas",
      "Consultar o estado",
      "O estado da conexão precisa ser observado antes de afirmar disponibilidade.",
    ],
    [
      "Ferramentas",
      "Executar uma ação",
      "Argumentos estruturados são validados antes de executar a operação.",
    ],
    [
      "Arquivos",
      "Verificar conteúdo",
      "O texto persistido deve corresponder ao documento solicitado.",
    ],
    [
      "Arquivos",
      "Conferir estrutura",
      "Tabelas, títulos e elementos do arquivo precisam abrir corretamente.",
    ],
    [
      "Arquivos",
      "Revisar aparência",
      "Páginas renderizadas revelam cortes, colisões e problemas de legibilidade.",
    ],
  ];
  const bytes = await createDocumentPptx(
    composeDocument(
      `## Um fluxo que deixa evidências\n\n\`\`\`steps\n${JSON.stringify(steps)}\n\`\`\`\n\n## O que deve ser conferido\n\n| Categoria | Exemplo | Evidência útil |\n| --- | --- | --- |\n${rows.map((row) => `| ${row.join(" | ")} |`).join("\n")}`,
      "Guia",
      { cover: false },
    ),
  );
  const zip = await JSZip.loadAsync(bytes);
  const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  assert.equal(slides.length, 2, "compact related content should not fragment across extra slides");
  const xml = await zip.files[slides[1]].async("string");
  assert.equal((xml.match(/<a:tr /g) ?? []).length, 7);
  assert.match(xml, /sz="1800"/, "table body stays at 18pt");
  const run = promisify(execFile);
  try {
    await run("libreoffice", ["--version"], { timeout: 10000 });
  } catch {
    t.diagnostic("LibreOffice is unavailable; the rendered-coordinate check requires it");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "document-table-bounds-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "compact.pptx");
  await writeFile(path, bytes);
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
    data: new Uint8Array(await readFile(join(directory, "compact.pdf"))),
    useWorkerFetch: false,
    verbosity: 0,
  });
  try {
    const pdf = await loading.promise,
      page = await pdf.getPage(2),
      viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const boxes = content.items.flatMap((item) => {
      if (!("str" in item) || !item.str.trim()) return [];
      const font = content.styles[item.fontName];
      return [
        {
          text: item.str,
          size: item.height,
          top: viewport.height - item.transform[5] - (font.ascent ?? 1) * item.height,
          bottom: viewport.height - item.transform[5] - (font.descent ?? -0.25) * item.height,
        },
      ];
    });
    assert.ok(
      boxes.some((box) => box.text.includes("legibilidade")),
      "the final cell must be visibly rendered",
    );
    const table = boxes.filter((box) => box.size >= 15 && box.top > 110);
    const footer = boxes.filter((box) => box.size < 12 && box.top > viewport.height * 0.9);
    assert.ok(table.length > 6 && footer.length > 0);
    const tableBottom = Math.max(...table.map((box) => box.bottom));
    const footerTop = Math.min(...footer.map((box) => box.top));
    assert.ok(
      tableBottom <= 6.5 * 72,
      `Rendered table enters the reserved footer band: bottom=${tableBottom}pt`,
    );
    assert.ok(
      footerTop - tableBottom >= 24,
      `Rendered table needs 24pt clear space above footer text; got ${footerTop - tableBottom}pt`,
    );
  } finally {
    await loading.destroy();
  }
});

test("owned image assets survive deterministic package normalization alongside multiple charts", async () => {
  const image = {
    id: "owned-image",
    bytes: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    ),
    width: 1,
    height: 1,
    mimeType: "image/png" as const,
  };
  const chart = '\n\n```chart\n{"title":"Dados editáveis","labels":["A","B"],"values":[1,2]}\n```';
  const value = composeDocument(
    `Texto com imagem${chart}${chart}`,
    "Imagem e dados",
    {},
    defaultDocumentTheme,
    new Map([[image.id, image]]),
  );
  value.blocks.unshift({
    type: "image",
    fileId: image.id,
    caption: "Imagem pertencente ao documento",
  });
  for (const [format, render] of [
    ["docx", createDocumentDocx],
    ["pptx", createDocumentPptx],
  ] as const) {
    const bytes = await render(value),
      zip = await JSZip.loadAsync(bytes);
    assert.equal(
      digest(await render(value)),
      digest(bytes),
      `${format} image/chart relations must remain stable`,
    );
    assert.equal(
      Object.keys(zip.files).filter((name) => /\/charts\/chart\d+\.xml$/.test(name)).length,
      2,
    );
    assert.equal(Object.keys(zip.files).filter((name) => /\/media\/.*\.png$/.test(name)).length, 1);
  }
});

test("wrapped DOCX titles and headings retain separate lines with and without a cover", {
  timeout: 120000,
}, async (t) => {
  const run = promisify(execFile);
  const directory = await mkdtemp(join(tmpdir(), "document-title-leading-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths: string[] = [];
  const title = "Como funciona o OkamiBot neste aplicativo";
  const heading =
    "Uma seção com título extenso que permanece legível quando é distribuído em várias linhas consecutivas";
  for (const cover of [false, true]) {
    const bytes = await createDocumentDocx(
      composeDocument(
        `# ${heading}\n\nTexto de conferência.`,
        title,
        {
          cover,
          eyebrow: "GUIA DE OPERAÇÃO",
          subtitle: "Ferramentas, skills e limites observáveis",
        },
        { ...defaultDocumentTheme, display: "sans" },
      ),
    );
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file("word/document.xml")?.async("string");
    const styles = await zip.file("word/styles.xml")?.async("string");
    assert.ok(xml && styles);
    // LibreOffice 7.4 interprets an omitted lineRule as fixed body-sized leading,
    // although newer versions render it as automatic. Preserve compatibility.
    assert.match(styles, /<w:pPrDefault>.*?<w:spacing[^>]*w:lineRule="auto"/);
    const titleParagraph = xml.match(/<w:p>\s*<w:pPr><w:pStyle w:val="Title".*?<\/w:p>/)?.[0];
    assert.ok(titleParagraph);
    assert.match(titleParagraph, /<w:spacing[^>]*w:lineRule="auto"/);
    const path = join(directory, `cover-${cover}.docx`);
    await writeFile(path, bytes);
    paths.push(path);
  }
  try {
    await run("libreoffice", ["--version"], { timeout: 10000 });
  } catch {
    t.diagnostic("LibreOffice is unavailable; rendered line separation requires it");
    return;
  }
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
      ...paths,
    ],
    { timeout: 60000 },
  );
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  for (const cover of [false, true]) {
    const loading = getDocument({
      data: new Uint8Array(await readFile(join(directory, `cover-${cover}.pdf`))),
      useWorkerFetch: false,
      verbosity: 0,
    });
    try {
      const pdf = await loading.promise;
      for (const [pageNumber, fontSize, expected] of [
        [1, cover ? 36 : 26, title],
        [cover ? 2 : 1, 18, heading],
      ] as const) {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        const text = await page.getTextContent();
        const lines = text.items.flatMap((item) => {
          if (!("str" in item) || !item.str.trim() || Math.abs(item.height - fontSize) > 0.1)
            return [];
          const font = text.styles[item.fontName];
          return [
            {
              text: item.str,
              top: viewport.height - item.transform[5] - (font.ascent ?? 1) * item.height,
              bottom: viewport.height - item.transform[5] - (font.descent ?? -0.25) * item.height,
            },
          ];
        });
        assert.equal(lines.map((line) => line.text).join(" "), expected);
        assert.ok(lines.length >= 2, "the regression fixture must actually wrap");
        for (let index = 1; index < lines.length; index++) {
          const gap = lines[index].top - lines[index - 1].bottom;
          assert.ok(
            gap >= 2,
            `cover=${cover}, ${fontSize}pt lines need clear separation; got ${gap}pt`,
          );
        }
      }
    } finally {
      await loading.destroy();
    }
  }
});

test("native Office documents open in LibreOffice and retain their final text in actual rendered PDFs", {
  timeout: 120000,
}, async (t) => {
  const run = promisify(execFile);
  try {
    await run("libreoffice", ["--version"], { timeout: 10000 });
  } catch {
    t.skip("LibreOffice is not installed in this development environment");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "document-office-render-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [format, render] of [
    ["docx", createDocumentDocx],
    ["pptx", createDocumentPptx],
  ] as const) {
    const path = join(directory, `designed-${format}.${format}`);
    await writeFile(path, await render(model()));
    await run(
      "libreoffice",
      [
        `-env:UserInstallation=${pathToFileURL(join(directory, `profile-${format}`)).href}`,
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
    const text = await readPdfText(await readFile(join(directory, `designed-${format}.pdf`)));
    assert.match(text, /1\.\s*Receber/, `${format} render must preserve visible list numbering`);
    assert.match(text, /2\.\s*Preparar/, `${format} outer numbering must ignore nested items`);
    assert.match(text, /7\.\s*Validar/, `${format} nested numbering must preserve its own start`);
    assert.match(text, /8\.\s*Organizar/, `${format} nested numbering must continue independently`);
    for (const expected of [
      "Uma entrega que comunica",
      "DOCX",
      "PPTX",
      "Pesquisa",
      "Composição",
      "Revisão",
      "ÚLTIMA LINHA",
    ])
      assert.ok(text.includes(expected), `${format} render lost ${expected}`);
  }
});
