import assert from "node:assert/strict";
import test from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import { createDocumentDocx } from "../packages/integrations/src/document-docx.ts";
import { composeDocument } from "../packages/integrations/src/document-model.ts";
import { createDesignedPdf } from "../packages/integrations/src/document-pdf.ts";
import { createDocumentPptx } from "../packages/integrations/src/document-pptx.ts";

const layouts = ["editorial", "briefing", "signal"] as const;
const content = `## Direction\n\nThe team can edit every sentence.\n\n\`\`\`metrics\n{"items":[{"label":"First measure","value":"12"},{"label":"Second measure","value":"24"},{"label":"Third measure","value":"36"}]}\n\`\`\``;
const model = (layout: (typeof layouts)[number], cover = false) => ({
  ...composeDocument(content, "A clearer direction", { cover }),
  design: { layout, cover, eyebrow: "FIELD NOTES", subtitle: "Evidence into action" },
});
const parse = (xml: string) => new DOMParser().parseFromString(xml, "application/xml");
const slideTexts = async (bytes: Uint8Array) => {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)?.[1]) - Number(b.match(/slide(\d+)/)?.[1]));
  return Promise.all(names.map(async (name) => parse(await zip.files[name].async("string"))));
};
const box = (xml: ReturnType<typeof parse>, value: string) => {
  const shape = Array.from(xml.getElementsByTagName("p:sp")).find((element) =>
    element.textContent?.includes(value),
  );
  assert.ok(shape, `Missing editable text: ${value}`);
  const offset = shape.getElementsByTagName("a:off")[0];
  const extent = shape.getElementsByTagName("a:ext")[0];
  return {
    x: Number(offset.getAttribute("x")) / 914400,
    y: Number(offset.getAttribute("y")) / 914400,
    w: Number(extent.getAttribute("cx")) / 914400,
    h: Number(extent.getAttribute("cy")) / 914400,
  };
};

test("layout choices change presentation composition with an identical theme and content", async () => {
  const [editorial, briefing, signal] = await Promise.all(
    layouts.map(async (layout) => slideTexts(await createDocumentPptx(model(layout)))),
  );
  const body = (pages: typeof editorial) => box(pages[0], "The team can edit");
  assert.ok(body(editorial).x > 3, "editorial prose uses a side heading");
  assert.ok(body(briefing).x < 1, "briefing prose starts below the full-width heading");
  assert.ok(body(signal).y > body(briefing).y + 0.3, "signal gives its title more space");
  assert.ok(body(signal).w < body(briefing).w, "signal prose is inset below its title");
  for (const [index, pages] of [editorial, briefing, signal].entries()) {
    const metricPages = pages.filter((page) =>
      page.documentElement?.textContent?.includes("measure"),
    );
    assert.equal(
      metricPages.length,
      [1, 2, 3][index],
      "metric arrangements follow the chosen family",
    );
    const all = pages.map((page) => page.documentElement?.textContent).join(" ");
    for (const value of ["First measure", "Second measure", "Third measure", "12", "24", "36"])
      assert.ok(all.includes(value), `${layouts[index]} lost ${value}`);
  }
});

test("section subtitles stay with their table and process instead of creating title-only slides", async () => {
  const content = `## Comparison\n### Three distinct roles\n\n| Layer | Role |\n| --- | --- |\n| Tool | Execute |\n| Skill | Guide |\n| Task | Deliver |\n\n---\n\n## Process\n### From request to evidence\n\n\`\`\`steps\n{"items":[{"title":"Understand"},{"title":"Execute"},{"title":"Verify"}]}\n\`\`\``;
  for (const layout of layouts) {
    const pages = await slideTexts(
      await createDocumentPptx(composeDocument(content, "Guide", { cover: false, layout })),
    );
    assert.equal(pages.length, 2, `${layout} should keep each heading with its figure`);
    for (const text of ["Comparison", "Three distinct roles", "Tool", "Task"])
      assert.ok(pages[0].documentElement?.textContent?.includes(text));
    for (const text of ["Process", "From request to evidence", "Understand", "Verify"])
      assert.ok(pages[1].documentElement?.textContent?.includes(text));
  }
});

test("Word layout families change editable cover structure and metric grid", async () => {
  const documents = await Promise.all(
    layouts.map(async (layout) => {
      const zip = await JSZip.loadAsync(await createDocumentDocx(model(layout, true)));
      return parse((await zip.file("word/document.xml")?.async("string")) ?? "");
    }),
  );
  const titleInTable = (doc: ReturnType<typeof parse>) =>
    Array.from(doc.getElementsByTagName("w:tbl")).find((table) =>
      table.textContent?.includes("A clearer direction"),
    );
  assert.equal(titleInTable(documents[0]), undefined);
  assert.equal(
    titleInTable(documents[1])?.getElementsByTagName("w:tc").length,
    2,
    "briefing cover uses a title and metadata grid",
  );
  const signal = titleInTable(documents[2]);
  assert.equal(
    signal?.getElementsByTagName("w:tc").length,
    1,
    "signal title is a single contrast panel",
  );
  assert.ok(
    Array.from(signal?.getElementsByTagName("w:shd") ?? []).some(
      (shade) => shade.getAttribute("w:fill") === "30302E",
    ),
  );
  for (const [index, doc] of documents.entries()) {
    const metric = Array.from(doc.getElementsByTagName("w:tbl")).find((table) =>
      table.textContent?.includes("First measure"),
    );
    assert.equal(
      metric?.getElementsByTagName("w:tr")[0].getElementsByTagName("w:tc").length,
      [3, 2, 1][index],
    );
    assert.ok(doc.documentElement?.textContent?.includes("The team can edit every sentence."));
  }
});

test("PDF layout families change metric geometry while preserving every label", async () => {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const geometries = [];
  for (const layout of layouts) {
    const task = getDocument({
      data: await createDesignedPdf(model(layout)),
      useSystemFonts: false,
      verbosity: 0,
    });
    try {
      const pdf = await task.promise;
      const items: { str: string; transform: number[] }[] = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const text = await page.getTextContent();
        items.push(...text.items.filter((item) => "str" in item));
      }
      const measure = (value: string) => {
        const item = items.find((item) => "str" in item && item.str === value);
        assert.ok(item && "transform" in item, `${layout} lost ${value}`);
        return { x: item.transform[4], y: item.transform[5] };
      };
      geometries.push([measure("12"), measure("24"), measure("36")]);
    } finally {
      await task.destroy();
    }
  }
  assert.equal(geometries[0][0].y, geometries[0][2].y);
  assert.equal(geometries[1][0].y, geometries[1][1].y);
  assert.ok(geometries[1][2].y < geometries[1][0].y - 40, "briefing uses a two-column grid");
  assert.equal(geometries[2][0].x, geometries[2][1].x);
  assert.ok(geometries[2][1].y < geometries[2][0].y - 40, "signal stacks metric statements");
});

test("dark palettes keep native Office table headings legible against the light ink fill", async () => {
  const document = composeDocument(
    "| Item | Evidence |\n| --- | --- |\n| Alpha | Source |",
    "Review",
    { cover: false },
  );
  document.theme = {
    ...document.theme,
    paper: "#101820",
    ink: "#F4F2ED",
    surface: "#223040",
    muted: "#D2D6DA",
  };
  for (const [format, render, path] of [
    ["docx", createDocumentDocx, "word/document.xml"],
    ["pptx", createDocumentPptx, "ppt/slides/slide1.xml"],
  ] as const) {
    const zip = await JSZip.loadAsync(await render(document));
    const xml = parse((await zip.file(path)?.async("string")) ?? "");
    const cell = Array.from(xml.getElementsByTagName(format === "docx" ? "w:tc" : "a:tc")).find(
      (item) => item.textContent?.includes("Item"),
    );
    assert.ok(cell);
    const colors = Array.from(
      cell.getElementsByTagName(format === "docx" ? "w:color" : "a:srgbClr"),
    );
    assert.ok(
      colors.some((color) => color.getAttribute(format === "docx" ? "w:val" : "val") === "101820"),
      `${format} table heading needs the contrasting paper color`,
    );
  }
});

test("Word keeps each table row together when it reaches a page boundary", async () => {
  for (const layout of layouts) {
    const document = composeDocument(
      "| Item | Evidence |\n| --- | --- |\n| Alpha | The evidence stays beside its label. |",
      "Review",
      { layout, cover: false },
    );
    const zip = await JSZip.loadAsync(await createDocumentDocx(document));
    const xml = parse((await zip.file("word/document.xml")?.async("string")) ?? "");
    const table = Array.from(xml.getElementsByTagName("w:tbl")).find((element) =>
      element.textContent?.includes("The evidence stays"),
    );
    assert.ok(table);
    for (const row of Array.from(table.getElementsByTagName("w:tr")))
      assert.equal(row.getElementsByTagName("w:cantSplit").length, 1);
  }
});

test("a signal PDF rejects cover text that would continue invisibly onto a paper page", async () => {
  const document = model("signal", true);
  document.title = "A lengthy cover title ".repeat(120);
  await assert.rejects(createDesignedPdf(document), /cover.*(long|fit|overflow)/i);
});
