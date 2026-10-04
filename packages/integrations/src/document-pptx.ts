import { readFile } from "node:fs/promises";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont } from "pdf-lib";
import PptxModule from "pptxgenjs";
import { documentAccentText, documentColorContrast } from "./document-colors.ts";

// Upstream exposes CommonJS-shaped declarations for its ESM constructor.
const PptxGenJS = PptxModule as unknown as typeof PptxModule.default;

import type { DocumentModel, DocumentRun } from "./document-model.ts";
import { normalizeOfficePackage } from "./document-office-package.ts";

const bodyFont = "DejaVu Sans";
const hex = (color: string) => color.replace(/^#/, "");
type Fonts = { regular: PDFFont; bold: PDFFont; italic: PDFFont; mono: PDFFont; display: PDFFont };
type Line = DocumentRun[];

async function loadFonts(serif: boolean): Promise<Fonts> {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const font = async (name: string) =>
    document.embedFont(await readFile(new URL(`../assets/${name}.ttf`, import.meta.url)));
  const [regular, bold, italic, mono, display] = await Promise.all([
    font("DejaVuSans"),
    font("DejaVuSans-Bold"),
    font("DejaVuSans-Oblique"),
    font("DejaVuSansMono"),
    font(serif ? "DejaVuSerif" : "DejaVuSans"),
  ]);
  return { regular, bold, italic, mono, display };
}

/** Measured wrapping, including long words, keeps authored text inside fixed slide boxes. */
function wrapRuns(
  runs: readonly DocumentRun[],
  size: number,
  width: number,
  fonts: Fonts,
  display = false,
): Line[] {
  const lines: Line[] = [];
  let line: Line = [],
    used = 0;
  const flush = () => {
    lines.push(line);
    line = [];
    used = 0;
  };
  const measure = (text: string, run: DocumentRun) => {
    const font = run.code
      ? fonts.mono
      : run.bold
        ? fonts.bold
        : run.italic
          ? fonts.italic
          : display
            ? fonts.display
            : fonts.regular;
    return font.widthOfTextAtSize(text, size) * 1.035;
  };
  const add = (text: string, run: DocumentRun) => {
    const previous = line.at(-1);
    if (
      previous &&
      previous.bold === run.bold &&
      previous.italic === run.italic &&
      previous.code === run.code &&
      previous.href === run.href
    )
      previous.text += text;
    else line.push({ ...run, text });
    used += measure(text, run);
  };
  const limit = width * 72;
  for (const run of runs) {
    for (const token of run.text.split(/(\n|[^\S\n]+|[^\s]+)/u).filter(Boolean)) {
      if (token === "\n") {
        flush();
        continue;
      }
      if (!token.trim() && !line.length && !run.code) continue;
      const amount = measure(token, run);
      if (used + amount <= limit) {
        add(token, run);
        continue;
      }
      if (line.length) flush();
      if (!token.trim()) continue;
      if (amount <= limit) {
        add(token, run);
        continue;
      }
      // Shape bounded grapheme chunks rather than repeatedly measuring a whole huge word.
      let part = "";
      for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
        token,
      )) {
        if (segment.length > 256)
          throw new Error("Document contains an oversized combining sequence");
        if (measure(part + segment, run) > limit) {
          if (!part) throw new Error("Document contains a glyph wider than its slide column");
          add(part, run);
          flush();
          part = "";
        }
        part += segment;
      }
      if (part) add(part, run);
    }
  }
  if (line.length || !lines.length) lines.push(line);
  return lines;
}

/** Every visible heading, table, chart and diagram is an editable Office object. */
export async function createDocumentPptx(model: DocumentModel): Promise<Uint8Array> {
  const fonts = await loadFonts(model.theme.display === "serif");
  const presentation = new PptxGenJS();
  presentation.layout = "LAYOUT_WIDE";
  presentation.author = "";
  presentation.company = "";
  presentation.title = model.title ?? "";
  presentation.subject = model.design.subtitle ?? "";
  const displayFont = model.theme.display === "serif" ? "DejaVu Serif" : bodyFont;
  presentation.theme = { headFontFace: displayFont, bodyFontFace: bodyFont };
  const ink = hex(model.theme.ink),
    muted = hex(model.theme.muted),
    accent = hex(model.theme.accent),
    paper = hex(model.theme.paper),
    surface = hex(model.theme.surface);
  const accentText = documentAccentText(accent, [paper, surface], ink);
  const accentLarge = documentAccentText(accent, [paper, surface], ink, true);
  const markerText =
    documentColorContrast(ink, accent) >= documentColorContrast("FFFFFF", accent) ? ink : "FFFFFF";
  let count = 0,
    section = model.title ?? "",
    continuation = false,
    pendingSection = false;
  let flow: { slide: PptxModule.default.Slide; y: number } | undefined;

  const styled = (
    runs: readonly DocumentRun[],
    color = ink,
    font = bodyFont,
  ): PptxModule.default.TextProps[] =>
    runs.map((run) => ({
      text: run.text,
      options: {
        bold: run.bold,
        italic: run.italic,
        fontFace: run.code ? "DejaVu Sans Mono" : font,
        color: run.href ? accentText : color,
        ...(run.href ? { hyperlink: { url: run.href }, underline: { style: "sng" as const } } : {}),
      },
    }));
  const text = (
    slide: PptxModule.default.Slide,
    runs: readonly DocumentRun[],
    x: number,
    y: number,
    w: number,
    h: number,
    size = 21,
    options: PptxModule.default.TextPropsOptions = {},
  ) =>
    slide.addText(styled(runs, options.color ?? ink, options.fontFace ?? bodyFont), {
      x,
      y,
      w,
      h,
      fontFace: bodyFont,
      fontSize: size,
      color: ink,
      margin: 0,
      breakLine: false,
      valign: "top",
      fit: "none",
      wrap: true,
      lineSpacingMultiple: 1.15,
      paraSpaceAfter: 0,
      ...options,
    });
  const lineText = (
    slide: PptxModule.default.Slide,
    lines: readonly Line[],
    x: number,
    y: number,
    w: number,
    size: number,
    options: PptxModule.default.TextPropsOptions = {},
  ) => {
    const leading = (size * 1.29) / 72;
    for (const [index, line] of lines.entries())
      text(slide, line, x, y + index * leading, w, leading + 0.035, size, options);
    return lines.length * leading;
  };
  const rect = (
    slide: PptxModule.default.Slide,
    x: number,
    y: number,
    w: number,
    h: number,
    fill: string,
  ) =>
    slide.addShape(presentation.ShapeType.rect, {
      x,
      y,
      w,
      h,
      fill: { color: fill },
      line: { color: fill, transparency: 100 },
    });
  const base = (layout: string, background = paper): PptxModule.default.Slide => {
    if (++count > 100) throw new Error("Document exceeds the 100-slide authoring limit");
    const slide = presentation.addSlide();
    slide.background = { color: background };
    slide.addNotes(`Layout: ${layout}`);
    const folio = model.design.footer ?? model.title ?? "";
    text(slide, [{ text: folio.slice(0, 95) }], 0.72, 7.01, 10.8, 0.23, 9, { color: muted });
    text(slide, [{ text: String(count).padStart(2, "0") }], 11.9, 6.98, 0.7, 0.25, 10, {
      color: muted,
      align: "right",
    });
    rect(slide, 0.72, 6.82, 11.89, 0.014, surface);
    return slide;
  };
  const title = (slide: PptxModule.default.Slide, value: string, size = 30) => {
    const lines = wrapRuns([{ text: value }], size, 11.89, fonts, true);
    if (lines.length > 3)
      throw new Error("Slide section title needs more than three lines; shorten the heading");
    const h = lineText(slide, lines, 0.72, 0.68, 11.89, size, { fontFace: displayFont });
    rect(slide, 0.72, 0.42, 0.62, 0.045, accent);
    return Math.max(1.6, 0.68 + h + 0.3);
  };
  const flowSlide = () => {
    const slide = base("editorial-text");
    if (model.design.eyebrow)
      text(slide, [{ text: model.design.eyebrow }], 0.72, 0.5, 11.8, 0.3, 11, {
        bold: true,
        color: accentText,
      });
    const label = section;
    const lines = wrapRuns([{ text: label }], 29, 3, fonts, true);
    if (lines.length > 10)
      throw new Error("Slide section title is too long for the editorial layout");
    lineText(slide, lines, 0.72, 1.3, 3, 29, { fontFace: displayFont });
    rect(slide, 0.72, 1.1, 0.6, 0.045, accent);
    if (continuation) text(slide, [{ text: "…" }], 0.72, 6.13, 0.6, 0.4, 26, { color: accent });
    continuation = true;
    pendingSection = false;
    return { slide, y: 1.23 };
  };
  const sectionSlide = () => {
    const slide = base("section-divider");
    title(slide, section);
    pendingSection = false;
  };
  const body = (
    runs: readonly DocumentRun[],
    size = 21,
    bullet?: { ordered: boolean; value: number; level: number },
  ) => {
    const indent = bullet ? Math.min(4, bullet.level) * 0.25 + 0.3 : 0;
    const lines = wrapRuns(runs, size, 8.15 - indent, fonts);
    const leading = (size * 1.29) / 72;
    for (const [index, line] of lines.entries()) {
      if (!flow || flow.y + leading > 6.55) flow = flowSlide();
      text(
        flow.slide,
        index === 0 && bullet
          ? line.map((run, runIndex) =>
              runIndex === 0 ? { ...run, text: `\u00a0${run.text}` } : run,
            )
          : line,
        4.12 + indent,
        flow.y,
        8.15 - indent,
        leading + 0.035,
        size,
        index === 0 && bullet
          ? {
              bullet: bullet.ordered
                ? { type: "number", numberType: "arabicPeriod", startAt: bullet.value, indent: 18 }
                : { indent: 18 },
            }
          : {},
      );
      flow.y += leading;
    }
    if (flow) flow.y += 0.19;
  };

  if (model.title && model.design.cover !== false) {
    const slide = base("cover");
    rect(slide, 9.75, 0, 3.58, 6.82, surface);
    rect(slide, 9.75, 0, 0.1, 6.82, accent);
    if (model.design.eyebrow)
      text(slide, [{ text: model.design.eyebrow }], 0.82, 1.02, 8.2, 0.4, 13, {
        color: accentText,
        bold: true,
      });
    const titleLines = wrapRuns([{ text: model.title }], 40, 8.1, fonts, true);
    if (titleLines.length > 5) throw new Error("Presentation title is too long for its cover");
    const height = lineText(slide, titleLines, 0.82, 1.95, 8.1, 40, { fontFace: displayFont });
    if (model.design.subtitle) {
      const subtitle = wrapRuns([{ text: model.design.subtitle }], 20, 8, fonts);
      if (subtitle.length * 0.36 + 2.25 + height > 6.4)
        throw new Error("Presentation subtitle overflows the cover; shorten it");
      lineText(slide, subtitle, 0.85, 2.25 + height, 8, 20, { color: muted });
    }
    text(slide, [{ text: "01" }], 10.25, 4.88, 2.2, 1, 64, {
      color: accentLarge,
      fontFace: displayFont,
    });
  }

  for (const block of model.blocks) {
    if (block.type === "heading") {
      if (block.level <= 2) {
        if (pendingSection) sectionSlide();
        section = block.text;
        continuation = false;
        flow = undefined;
        pendingSection = true;
      } else body([{ text: block.text, bold: true }], 23);
      continue;
    }
    if (block.type === "paragraph") {
      body(block.runs);
      continue;
    }
    if (block.type === "list") {
      for (const [index, item] of block.items.entries())
        body(item.runs, 21, {
          ordered: item.ordered ?? block.ordered,
          value: item.number ?? block.start + index,
          level: item.level,
        });
      continue;
    }
    if (block.type === "rule") {
      flow = undefined;
      continue;
    }
    flow = undefined;
    if (block.type === "code") {
      body([{ text: block.text, code: true }], 18);
    } else if (block.type === "quote") {
      const lines = wrapRuns(block.runs, 27, 9.6, fonts);
      for (let offset = 0; offset < lines.length; ) {
        const slide = base("pull-quote");
        const y = title(slide, section);
        const height = 6.5 - y,
          capacity = Math.floor((height - 0.85) / ((27 * 1.29) / 72));
        rect(slide, 0.72, y, 11.89, height, surface);
        rect(slide, 0.72, y, 0.07, height, accent);
        lineText(slide, lines.slice(offset, offset + capacity), 1.45, y + 0.45, 9.6, 27);
        offset += capacity;
      }
    } else if (block.type === "metrics") {
      for (let offset = 0; offset < block.items.length; ) {
        const slide = base("metric-cards");
        const y = title(slide, section);
        const height = 6.45 - y - 0.2;
        let columns = Math.min(3, block.items.length - offset);
        const measured = (number: number) => {
          const width = (11.89 - (number - 1) * 0.25) / number;
          return block.items.slice(offset, offset + number).map((item) => {
            const value = wrapRuns([{ text: item.value }], 35, width - 0.56, fonts, true);
            const label = wrapRuns([{ text: item.label, bold: true }], 20, width - 0.56, fonts);
            const detail = item.detail
              ? wrapRuns([{ text: item.detail }], 18, width - 0.56, fonts)
              : [];
            const contentHeight =
              0.83 + ((value.length * 35 + label.length * 20 + detail.length * 18) * 1.29) / 72;
            return { value, label, detail, contentHeight };
          });
        };
        while (columns > 1 && measured(columns).some((item) => item.contentHeight > height - 0.18))
          columns--;
        const cards = measured(columns),
          width = (11.89 - (columns - 1) * 0.25) / columns;
        for (const [index, item] of cards.entries()) {
          if (item.contentHeight > height - 0.18)
            throw new Error(
              "Metric card is too dense; shorten its label/detail or split the content",
            );
          const x = 0.72 + index * (width + 0.25);
          rect(slide, x, y + 0.2, width, height, surface);
          rect(slide, x, y + 0.2, width, 0.045, accent);
          const valueH = lineText(slide, item.value, x + 0.28, y + 0.58, width - 0.56, 35, {
            color: accentLarge,
            fontFace: displayFont,
          });
          const labelH = lineText(slide, item.label, x + 0.28, y + 0.83 + valueH, width - 0.56, 20);
          if (item.detail.length)
            lineText(slide, item.detail, x + 0.28, y + 1.03 + valueH + labelH, width - 0.56, 18, {
              color: muted,
            });
        }
        offset += columns;
      }
    } else if (block.type === "steps") {
      for (let offset = 0; offset < block.items.length; ) {
        const slide = base("process");
        const y = title(slide, section);
        const preferredHeight = Math.min(
          1.5,
          (6.45 - y) / Math.min(4, block.items.length - offset),
        );
        let top = y;
        while (offset < block.items.length) {
          const item = block.items[offset];
          const itemTitle = wrapRuns([{ text: item.title, bold: true }], 23, 10.4, fonts);
          const detail = item.detail ? wrapRuns([{ text: item.detail }], 18, 10.4, fonts) : [];
          const stepHeight = Math.max(
            preferredHeight,
            ((itemTitle.length * 23 + detail.length * 18) * 1.29) / 72 + 0.15,
          );
          if (stepHeight > 6.5 - y)
            throw new Error("Process step is too dense; use a separate prose section");
          if (top + stepHeight > 6.5) break;
          slide.addShape(presentation.ShapeType.ellipse, {
            x: 0.78,
            y: top + 0.08,
            w: 0.58,
            h: 0.58,
            fill: { color: accent },
            line: { color: accent },
          });
          text(
            slide,
            [{ text: String(offset + 1).padStart(2, "0") }],
            0.81,
            top + 0.2,
            0.52,
            0.25,
            14,
            { bold: true, color: markerText, align: "center" },
          );
          const height = lineText(slide, itemTitle, 1.65, top + 0.03, 10.4, 23);
          if (detail.length)
            lineText(slide, detail, 1.65, top + 0.1 + height, 10.4, 18, { color: muted });
          top += stepHeight;
          offset++;
        }
      }
    } else if (block.type === "chart") {
      const slide = base("data-chart");
      let y = title(slide, block.title);
      if (pendingSection && section !== block.title) {
        const label = wrapRuns([{ text: section }], 12, 11.89, fonts);
        y += lineText(slide, label, 0.72, y, 11.89, 12, { color: muted }) + 0.18;
      }
      const labelLength = Math.max(...block.labels.map((label) => label.length));
      if (labelLength > 55)
        throw new Error(
          "Chart labels are too long for presentation axes; shorten labels and explain them in prose",
        );
      slide.addChart(
        presentation.ChartType.bar,
        [
          {
            name: block.unit ?? block.title,
            labels: block.labels.toReversed(),
            values: block.values.toReversed(),
          },
        ],
        {
          x: 0.72,
          y,
          w: 11.85,
          h: 6.45 - y,
          catAxisLabelFontFace: bodyFont,
          catAxisLabelFontSize: block.labels.length > 8 ? 15 : 18,
          catAxisLabelColor: ink,
          catAxisLineShow: false,
          valAxisLabelFontFace: bodyFont,
          valAxisLabelFontSize: 12,
          valAxisLabelColor: muted,
          valAxisLineShow: false,
          valGridLine: { color: surface, size: 1 },
          showLegend: false,
          showTitle: false,
          showValue: true,
          dataLabelPosition: "outEnd",
          dataLabelColor: ink,
          dataLabelFontFace: bodyFont,
          dataLabelFontSize: 14,
          chartColors: [accent],
          barDir: "bar",
          barGrouping: "clustered",
          barGapWidthPct: 70,
          ...(block.unit
            ? {
                showValAxisTitle: true,
                valAxisTitle: block.unit,
                valAxisTitleFontSize: 12,
                valAxisTitleColor: muted,
              }
            : {}),
        },
      );
    } else if (block.type === "image") {
      const image = model.images.get(block.fileId);
      if (!image) throw new Error(`Document image is missing: ${block.fileId}`);
      const slide = base("image-caption");
      const y = title(slide, section);
      const captionLines = block.caption
        ? wrapRuns([{ text: block.caption }], 16, 11.89, fonts)
        : [];
      const availableHeight = 6.4 - y - captionLines.length * 0.3;
      if (availableHeight < 1)
        throw new Error(
          "Image caption is too long for its slide; move the explanation to a prose section",
        );
      const scale = Math.min(11.89 / image.width, availableHeight / image.height);
      const w = image.width * scale,
        h = image.height * scale;
      slide.addImage({
        data: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`,
        x: 0.72 + (11.89 - w) / 2,
        y,
        w,
        h,
        altText: block.caption,
      });
      if (captionLines.length)
        lineText(slide, captionLines, 0.72, y + h + 0.18, 11.89, 16, { color: muted });
    } else if (block.type === "table") {
      const columns = block.headers.length;
      if (columns > 6)
        throw new Error(
          "Presentation tables support up to six columns; split this table into separate sections",
        );
      const size = columns > 4 ? 16 : 18;
      const naturalWidths = block.headers.map((header, index) => {
        const cells = [header, ...block.rows.map((row) => row[index])];
        const width = Math.max(
          ...cells.map(
            (cell, row) =>
              (cell.reduce(
                (total, run) =>
                  total +
                  (run.bold || row === 0 ? fonts.bold : fonts.regular).widthOfTextAtSize(
                    run.text,
                    size,
                  ),
                0,
              ) *
                1.05) /
              72,
          ),
        );
        return Math.max(1.1, width + 0.28);
      });
      const columnWidths = new Array<number>(columns).fill(0);
      const pending = new Set(naturalWidths.map((_, index) => index));
      let remainingWidth = 11.89;
      while (pending.size) {
        const short = [...pending].find(
          (index) => naturalWidths[index] <= remainingWidth / pending.size,
        );
        if (short === undefined) {
          const weight = [...pending].reduce((total, index) => total + naturalWidths[index], 0);
          for (const index of pending)
            columnWidths[index] = (remainingWidth * naturalWidths[index]) / weight;
          break;
        }
        columnWidths[short] = naturalWidths[short];
        remainingWidth -= columnWidths[short];
        pending.delete(short);
      }
      if (columnWidths.some((width) => width < 0.65))
        throw new Error("Presentation table has an excessively narrow column; split the table");
      const rowLines = (row: DocumentRun[][]) =>
        row.map((cell, index) => wrapRuns(cell, size, columnWidths[index] - 0.28, fonts));
      const headerLines = rowLines(block.headers);
      const headerHeight =
        (Math.max(...headerLines.map((lines) => lines.length)) * size * 1.2) / 72 + 0.12;
      const data = block.rows.map(rowLines);
      let offset = 0;
      do {
        const slide = base("comparison-table");
        const y = title(slide, section);
        if (headerHeight > 2)
          throw new Error("Presentation table header is too dense; shorten its column headings");
        const cellRuns = (lines: Line[], color: string) =>
          styled(
            lines.flatMap((line, index) => [...(index ? [{ text: "\n" }] : []), ...line]),
            color,
          );
        const rows: PptxModule.default.TableRow[] = [
          headerLines.map((lines) => ({
            text: cellRuns(lines, "FFFFFF"),
            options: { bold: true, fill: { color: ink }, color: "FFFFFF" },
          })),
        ];
        const heights = [headerHeight];
        let used = headerHeight;
        while (offset < data.length) {
          const row = data[offset];
          const h = (Math.max(...row.map((lines) => lines.length)) * size * 1.2) / 72 + 0.12;
          if (h > 6.45 - y - headerHeight)
            throw new Error(
              "A presentation table row is too tall; split its content into shorter rows",
            );
          if (used + h > 6.45 - y) break;
          rows.push(
            row.map((lines) => ({
              text: cellRuns(lines, ink),
              options: { fill: { color: offset % 2 ? surface : paper }, color: ink },
            })),
          );
          heights.push(h);
          used += h;
          offset++;
        }
        slide.addTable(rows, {
          x: 0.72,
          y,
          w: 11.89,
          colW: columnWidths,
          rowH: heights,
          fontFace: bodyFont,
          fontSize: size,
          margin: [0.06, 0.12, 0.06, 0.12],
          border: { type: "solid", color: surface, pt: 0.5 },
          autoPage: false,
          valign: "top",
        });
      } while (offset < data.length);
    }
    pendingSection = false;
  }
  if (pendingSection || count === 0) sectionSlide();
  const bytes = await presentation.write({ outputType: "uint8array", compression: true });
  if (!(bytes instanceof Uint8Array))
    throw new Error("Presentation writer returned an unexpected format");
  return normalizeOfficePackage(bytes);
}
