import assert from "node:assert/strict";
import { execFile as executeFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PDFDocument } from "pdf-lib";
import { getDesignProfile } from "../apps/server/src/design-catalog.ts";
import {
  composeDocument,
  type DocumentTheme,
} from "../packages/integrations/src/document-model.ts";
import { createDesignedPdf } from "../packages/integrations/src/document-pdf.ts";
import { readPdfText } from "../packages/integrations/src/pdf-text.ts";

// Deterministic renderer acceptance, separate from the later real-provider workflow.
// Run: pnpm exec tsx scripts/document-design-smoke.ts [--formats=pdf,docx,pptx]
// Every run gets a new directory; failures and earlier renders are preserved.
const execute = promisify(executeFile);
const argument = (key: string, fallback: string) =>
  process.argv.find((value) => value.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const formats = argument("formats", "pdf,docx,pptx").split(",");
const profiles = argument("profiles", "claude,ibm,spotify").split(",");
assert.ok(formats.every((value) => ["pdf", "docx", "pptx"].includes(value)));
const root = resolve(argument("output-root", "artifacts/document-design/visual-smoke"));
const output = join(root, new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const title = "Como o assistente trabalha";
const examples = [
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
const categories = [...new Set(examples.map(([category]) => category))];
const chart = {
  title: "Exemplos explicados neste guia",
  labels: categories,
  values: categories.map((category) => examples.filter(([group]) => group === category).length),
  unit: "exemplos",
};
const block = (language: string, value: unknown) =>
  `\n\`\`\`${language}\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
const content = `# ${title}

## Do pedido ao arquivo entregue

O assistente interpreta a conversa, escolhe ferramentas disponíveis e recebe os resultados observados. O servidor valida os argumentos e conserva o progresso das tarefas duráveis. **Uma afirmação de sucesso não substitui a entrega do arquivo.**

${block("metrics", {
  items: [
    {
      value: "3",
      label: "Formatos neste ensaio",
      detail: "PDF para leitura; Word e PowerPoint para edição.",
    },
    {
      value: "4",
      label: "Etapas do fluxo",
      detail: "Pedido, escolha de ferramentas, execução e verificação.",
    },
    {
      value: "6",
      label: "Exemplos explicados",
      detail: "A tabela e o gráfico abaixo usam os mesmos seis exemplos.",
    },
  ],
})}

## Um fluxo que deixa evidências

${block("steps", {
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
})}

O modelo propõe ações por chamadas estruturadas. O ambiente de execução controla como essas chamadas são validadas e realizadas. As observações retornadas ajudam a decidir o próximo passo.

## O que deve ser conferido

| Categoria | Exemplo | Evidência útil |
| --- | --- | --- |
${examples.map((row) => `| ${row.join(" | ")} |`).join("\n")}

${block("chart", chart)}

O gráfico conta as seis linhas da tabela: **1** exemplo de conversa, **2** de ferramentas e **3** de arquivos. A escala representa contagens do próprio guia; não representa velocidade, qualidade medida ou desempenho do assistente.

## Leitura, edição e continuidade

O PDF fixa a aparência das páginas. No Word, parágrafos, estilos e tabelas continuam editáveis. No PowerPoint, o conteúdo é distribuído em slides com textos, formas e gráficos editáveis.

> Legibilidade vem de hierarquia, espaço e informação bem organizada. Uma borda colorida sozinha não transforma texto corrido em um documento bem composto.

- **Internacionalização:** preservar português, acentuação e nomes como São Paulo.
- **Rastreabilidade:** associar conteúdo, arquivo e evidências ao mesmo resultado.
- **Continuidade:** retomar a tarefa com o progresso salvo quando isso for necessário.

Uma conexão listada entre as ferramentas não prova que ela esteja autenticada ou disponível naquele momento. O estado precisa ser consultado quando afeta o pedido.

## Próximo pedido, resultado mais claro

Um pedido útil combina objetivo, público e material de referência: “Prepare um guia para uma pessoa que vai usar o assistente pela primeira vez”. Quando o contexto já é suficiente, escolhas usuais de composição podem ser feitas sem um questionário adicional.

Este arquivo é uma **amostra local de aceitação dos renderizadores**. Ele usa descrições amplas do funcionamento observado no aplicativo. Não foi produzido por uma nova chamada ao provedor e não representa uma conversa enviada ao usuário.
`;
await writeFile(join(output, "fixture.md"), content);
await writeFile(
  join(output, "fixture-data.json"),
  JSON.stringify({ title, examples, chart }, null, 2),
);
const checks: {
  kind: string;
  output: string;
  passed: boolean;
  visualReview: string;
  results: Record<string, unknown>[];
} = {
  kind: "local-renderer-fixture",
  output,
  passed: false,
  visualReview:
    "Pending manual inspection of page images; structural checks do not establish visual acceptance.",
  results: [],
};
const save = () => writeFile(join(output, "checks.json"), `${JSON.stringify(checks, null, 2)}\n`);
const require = createRequire(import.meta.url);
const canvas = createRequire(require.resolve("pdfjs-dist/package.json"))("@napi-rs/canvas");

async function contactSheet(paths: string[], target: string, label: string) {
  const images: { width: number; height: number }[] = await Promise.all(
    paths.map((path) => canvas.loadImage(path)),
  );
  const columns = 3,
    cellWidth = 420;
  const heights = images.map((image) => (image.height * (cellWidth - 24)) / image.width);
  const cellHeight = Math.ceil(Math.max(...heights)) + 48;
  const sheet = canvas.createCanvas(
    columns * cellWidth,
    Math.ceil(images.length / columns) * cellHeight + 54,
  );
  const ctx = sheet.getContext("2d");
  ctx.fillStyle = "#e8eaed";
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.fillStyle = "#17202b";
  ctx.font = "bold 19px DejaVu Sans";
  ctx.fillText(label, 16, 31);
  images.forEach((image, index) => {
    const x = (index % columns) * cellWidth + 12,
      y = Math.floor(index / columns) * cellHeight + 64;
    ctx.fillStyle = "#17202b";
    ctx.font = "13px DejaVu Sans";
    ctx.fillText(`Página ${index + 1}`, x, y + 13);
    ctx.drawImage(image, x, y + 23, cellWidth - 24, heights[index]);
  });
  await writeFile(target, sheet.toBuffer("image/png"));
}

const officeInspect = `import json,sys,zipfile,xml.etree.ElementTree as E
ns={'c':'http://schemas.openxmlformats.org/drawingml/2006/chart'}
with zipfile.ZipFile(sys.argv[1]) as z:
 charts=[]
 for name in z.namelist():
  if '/charts/chart' not in name or not name.endswith('.xml'):continue
  root=E.fromstring(z.read(name))
  for series in root.findall('.//c:ser',ns):
   labels=[e.text for e in series.findall('.//c:cat//c:pt/c:v',ns)]
   values=[float(e.text) for e in series.findall('.//c:val//c:pt/c:v',ns)]
   charts.append({'labels':labels,'values':values})
 slides=[n for n in z.namelist() if n.startswith('ppt/slides/slide') and n.endswith('.xml')]
 nativeText=sum(z.read(n).count(b'<a:t>') for n in slides) if slides else z.read('word/document.xml').count(b'<w:t')
 print(json.dumps({'charts':charts,'slides':len(slides),'nativeTextRuns':nativeText}))`;

try {
  for (const profileId of profiles) {
    const profile = await getDesignProfile(profileId);
    assert.ok(profile, `Unknown profile ${profileId}`);
    const theme: DocumentTheme = {
      id: profile.id,
      label: profile.label,
      display: profile.display,
      ...profile.tokens,
    };
    const model = composeDocument(
      content,
      title,
      {
        cover: true,
        subtitle: "Conversa, ferramentas, evidências e arquivos",
        eyebrow: "Guia de uso · Português",
        footer: "Amostra de verificação visual · OpenMuse",
        reference: profile.id,
      },
      theme,
    );
    for (const format of formats) {
      const result: Record<string, unknown> = {
        profile: profile.id,
        format,
        passed: false,
        profileSource: profile.source,
      };
      checks.results.push(result);
      const directory = join(output, profile.id, format);
      await mkdir(directory, { recursive: true });
      const path = join(directory, `assistant-guide.${format}`);
      const bytes =
        format === "pdf"
          ? await createDesignedPdf(model)
          : format === "docx"
            ? await (
                await import("../packages/integrations/src/document-docx.ts")
              ).createDocumentDocx(model)
            : await (
                await import("../packages/integrations/src/document-pptx.ts")
              ).createDocumentPptx(model);
      await writeFile(path, bytes);
      result.file = path;
      result.bytes = bytes.length;
      result.sha256 = createHash("sha256").update(bytes).digest("hex");
      const render = join(directory, "rendered");
      await mkdir(render, { recursive: true });
      const pdfPath = join(render, "assistant-guide.pdf");
      if (format === "pdf") await copyFile(path, pdfPath);
      else {
        const office = JSON.parse(
          (
            await execute("python3", ["-c", officeInspect, path], {
              timeout: 30000,
              maxBuffer: 1024 * 1024,
            })
          ).stdout,
        );
        assert.ok(office.nativeTextRuns > 30, "Office text must be native editable content");
        assert.equal(office.charts.length, 1);
        const actual = Object.fromEntries(
          office.charts[0].labels.map((label: string, index: number) => [
            label,
            office.charts[0].values[index],
          ]),
        );
        assert.deepEqual(
          actual,
          Object.fromEntries(chart.labels.map((label, index) => [label, chart.values[index]])),
          "Native chart must preserve exact category/value pairs",
        );
        result.nativeOffice = office;
        const installation = await mkdtemp(join(tmpdir(), "openmuse-design-office-"));
        try {
          const conversion = await execute(
            "soffice",
            [
              `-env:UserInstallation=${pathToFileURL(installation).href}`,
              "--headless",
              "--convert-to",
              "pdf",
              "--outdir",
              render,
              path,
            ],
            { timeout: 120000, maxBuffer: 1024 * 1024 },
          );
          result.conversion = conversion.stdout.trim();
        } finally {
          await rm(installation, { recursive: true, force: true });
        }
      }
      const pdfBytes = await readFile(pdfPath);
      const pdf = await PDFDocument.load(pdfBytes);
      const pageCount = pdf.getPageCount();
      assert.ok(pageCount > 1 && pageCount <= 40, "Fixture page count must remain bounded");
      const text = (await readPdfText(pdfBytes)).normalize("NFC").replace(/\s+/gu, " ");
      for (const expected of [
        "Como o assistente trabalha",
        "São Paulo",
        "Conversa",
        "Ferramentas",
        "Arquivos",
        "Exemplos explicados neste guia",
      ])
        assert.ok(text.includes(expected), `${format} rendered PDF missing ${expected}`);
      await writeFile(join(render, "extracted-text.txt"), text);
      await execute("pdftoppm", ["-png", "-scale-to", "1400", pdfPath, join(render, "page")], {
        timeout: 120000,
        maxBuffer: 1024 * 1024,
      });
      const pages = (await readdir(render))
        .filter((name) => /^page-\d+\.png$/.test(name))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map((name) => join(render, name));
      assert.equal(pages.length, pageCount);
      const contact = join(directory, "contact-sheet.png");
      await contactSheet(
        pages,
        contact,
        `${profile.label} · ${format.toUpperCase()} · ${pageCount} páginas`,
      );
      Object.assign(result, { pageCount, pageImages: pages, contactSheet: contact, passed: true });
      await save();
      console.log(
        JSON.stringify({ profile: profile.id, format, pageCount, contactSheet: contact }),
      );
    }
  }
  checks.passed = true;
} catch (error) {
  checks.results.push({ error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await save();
  console.log(
    JSON.stringify({
      checks: join(output, "checks.json"),
      structuralPassed: checks.passed,
      visualReview: checks.visualReview,
    }),
  );
}
