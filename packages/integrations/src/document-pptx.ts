import { readFile } from "node:fs/promises";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont } from "pdf-lib";
import PptxModule from "pptxgenjs";
import { documentAccentText, documentColorContrast } from "./document-colors.ts";

// Upstream exposes CommonJS-shaped declarations for its ESM constructor.
const PptxGenJS = PptxModule as unknown as typeof PptxModule.default;

import type { DocumentBlock, DocumentModel, DocumentRun } from "./document-model.ts";
import { normalizeOfficePackage } from "./document-office-package.ts";

const bodyFont = "DejaVu Sans";
const hex = (color: string) => color.replace(/^#/, "");
type Fonts = { regular: PDFFont; bold: PDFFont; italic: PDFFont; mono: PDFFont; display: PDFFont };
type Line = DocumentRun[];

async function loadFonts(displayStyle: DocumentModel["theme"]["display"]): Promise<Fonts> {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const font = async (name: string) =>
    document.embedFont(await readFile(new URL(`../assets/${name}.ttf`, import.meta.url)));
  const [regular, bold, italic, mono, display] = await Promise.all([
    font("DejaVuSans"),
    font("DejaVuSans-Bold"),
    font("DejaVuSans-Oblique"),
    font("DejaVuSansMono"),
    font(
      displayStyle === "serif"
        ? "DejaVuSerif"
        : displayStyle === "mono"
          ? "DejaVuSansMono"
          : "DejaVuSans",
    ),
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
  const fonts = await loadFonts(model.theme.display);
  const family = model.design.layout ?? "editorial";
  const presentation = new PptxGenJS();
  presentation.layout = "LAYOUT_WIDE";
  presentation.author = "";
  presentation.company = "";
  presentation.title = model.title ?? "";
  presentation.subject = model.design.subtitle ?? "";
  const displayFont =
    model.theme.display === "serif"
      ? "DejaVu Serif"
      : model.theme.display === "mono"
        ? "DejaVu Sans Mono"
        : bodyFont;
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
    section = [model.title ?? ""],
    continuation = false,
    pendingSection = false;
  let flow: { slide: PptxModule.default.Slide; y: number } | undefined;
  let wideFlow = false;
  let splitAfterHeading = false;
  let captionArea: { slide: PptxModule.default.Slide; y: number } | undefined;
  const captionSize = 18,
    captionLeading = (captionSize * 1.29) / 72,
    captionGap = 0.23;
  const shortCaption = (runs: readonly DocumentRun[]) => {
    const lines = wrapRuns(runs, captionSize, 11.89, fonts);
    return lines.length <= 3 ? lines : undefined;
  };

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
      text(slide, line, x, y + index * leading, w, leading + 0.035, size, {
        ...options,
        wrap: false,
      });
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
    const footerColor = background === ink ? paper : muted;
    text(slide, [{ text: folio.slice(0, 95) }], 0.72, 7.01, 10.8, 0.23, 9, { color: footerColor });
    text(slide, [{ text: String(count).padStart(2, "0") }], 11.9, 6.98, 0.7, 0.25, 10, {
      color: footerColor,
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
  const sectionTitle = (slide?: PptxModule.default.Slide, compact = false) => {
    if (family !== "editorial") {
      const signal = family === "signal";
      const x = signal ? 1.16 : 0.72,
        width = signal ? 10.73 : 11.89;
      let y = signal ? 0.75 : 0.63;
      for (const [index, heading] of section.entries()) {
        const size = index === 0 ? (signal ? 40 : 29) : 20;
        const lines = wrapRuns([{ text: heading }], size, width, fonts, index === 0);
        const height = (lines.length * size * 1.29) / 72;
        if (y + height > 3.8)
          throw new Error(
            "Slide section headings are too long; shorten them or separate sections with content",
          );
        if (slide)
          lineText(slide, lines, x, y, width, size, {
            fontFace: index === 0 ? displayFont : bodyFont,
            color: index === 0 ? ink : muted,
          });
        y += height + 0.15;
      }
      if (slide) {
        if (signal) rect(slide, 0.72, 0.75, 0.08, y - 0.9, accent);
        else rect(slide, 0.72, y, 11.89, 0.018, accent);
      }
      return Math.max(signal ? 2.2 : 1.6, y + (signal ? 0.4 : 0.25));
    }
    if (section.length === 1) {
      if (slide) title(slide, section[0]);
      return Math.max(
        compact ? 1.4 : 1.6,
        0.68 +
          (wrapRuns([{ text: section[0] }], 30, 11.89, fonts, true).length * 30 * 1.29) / 72 +
          (compact ? 0.15 : 0.3),
      );
    }
    let y = 0.68;
    for (const [index, heading] of section.entries()) {
      const size = index === 0 ? 30 : 20;
      const lines = wrapRuns([{ text: heading }], size, 11.89, fonts, index === 0);
      if (y + (lines.length * size * 1.29) / 72 > 3.8)
        throw new Error(
          "Consecutive slide headings are too long; shorten them or separate sections with content or an explicit divider",
        );
      if (slide)
        lineText(slide, lines, 0.72, y, 11.89, size, {
          fontFace: index === 0 ? displayFont : bodyFont,
          color: index === 0 ? ink : muted,
        });
      y += (lines.length * size * 1.29) / 72 + 0.15;
    }
    if (slide) rect(slide, 0.72, 0.42, 0.62, 0.045, accent);
    return Math.max(compact ? 1.4 : 1.6, y + (compact ? 0 : 0.15));
  };
  const flowSlide = () => {
    const slide = base(
      family !== "editorial" ? `${family}-text` : wideFlow ? "wide-text" : "editorial-text",
    );
    if (model.design.eyebrow)
      text(
        slide,
        [{ text: model.design.eyebrow }],
        0.72,
        wideFlow || family !== "editorial" ? 0.13 : 0.5,
        11.8,
        wideFlow || family !== "editorial" ? 0.22 : 0.3,
        11,
        {
          bold: true,
          color: accentText,
        },
      );
    if (wideFlow || family !== "editorial") {
      const y = sectionTitle(slide, true);
      continuation = true;
      pendingSection = false;
      return { slide, y };
    }
    let headingY = 1.3;
    for (const [index, heading] of section.entries()) {
      const size = index === 0 ? 29 : 20;
      const lines = wrapRuns([{ text: heading }], size, 3, fonts, index === 0);
      if (headingY + (lines.length * size * 1.29) / 72 + 0.035 > 6.55)
        throw new Error("Slide section headings are too long for the editorial layout");
      headingY +=
        lineText(slide, lines, 0.72, headingY, 3, size, {
          fontFace: index === 0 ? displayFont : bodyFont,
          color: index === 0 ? ink : muted,
        }) + 0.24;
    }
    rect(slide, 0.72, 1.1, 0.6, 0.045, accent);
    if (continuation) text(slide, [{ text: "…" }], 0.72, 6.13, 0.6, 0.4, 26, { color: accent });
    continuation = true;
    pendingSection = false;
    return { slide, y: 1.23 };
  };
  const sectionSlide = () => {
    const slide = base("section-divider");
    sectionTitle(slide);
    pendingSection = false;
  };
  type Prose = {
    runs: readonly DocumentRun[];
    size: number;
    bullet?: { ordered: boolean; value: number; level: number };
  };
  const prose = (block: DocumentBlock): Prose[] | undefined => {
    if (block.type === "paragraph") return [{ runs: block.runs, size: 21 }];
    if (block.type === "heading" && block.level > 2)
      return [{ runs: [{ text: block.text, bold: true }], size: 23 }];
    if (block.type === "list")
      return block.items.map((item, index) => ({
        runs: item.runs,
        size: 21,
        bullet: {
          ordered: item.ordered ?? block.ordered,
          value: item.number ?? block.start + index,
          level: item.level,
        },
      }));
    return undefined;
  };
  const proseWidth = (width: number, item: Prose) =>
    width -
    (item.bullet
      ? Math.min(4, item.bullet.level) * 0.25 +
        0.3 +
        (18 + fonts.regular.widthOfTextAtSize("\u00a0", item.size)) / 72
      : 0);
  // Prefer the editorial column, but do not create a continuation when the same
  // complete section fits a full-width layout at the same font sizes and spacing.
  const prepareFlow = (index: number) => {
    if (flow) return;
    if (family !== "editorial") {
      wideFlow = true;
      return;
    }
    wideFlow = false;
    const items: Prose[] = [];
    for (let offset = index; offset < model.blocks.length; offset++) {
      const next = prose(model.blocks[offset]);
      if (!next) break;
      items.push(...next);
    }
    const height = (width: number) =>
      items.reduce(
        (sum, item) =>
          sum +
          (wrapRuns(item.runs, item.size, proseWidth(width, item), fonts).length *
            item.size *
            1.29) /
            72 +
          0.19,
        0,
      ) -
      0.19 +
      0.035;
    if (
      items.length &&
      height(8.15) > 6.55 - 1.23 &&
      height(11.89) <= 6.55 - sectionTitle(undefined, true)
    )
      wideFlow = true;
  };
  const body = (
    runs: readonly DocumentRun[],
    size = 21,
    bullet?: { ordered: boolean; value: number; level: number },
    keepNext?: Prose,
  ) => {
    const indent = bullet ? Math.min(4, bullet.level) * 0.25 + 0.3 : 0;
    // Native numbering reserves 18pt inside the first text box. Measure its spacer
    // too, and give continuation lines the same text origin. Otherwise LibreOffice
    // wraps an already positioned line again and overlays the next line.
    const markerInset = bullet ? (18 + fonts.regular.widthOfTextAtSize("\u00a0", size)) / 72 : 0;
    const columnWidth =
        family === "signal" ? 10.73 : wideFlow || family === "briefing" ? 11.89 : 8.15,
      columnX = family === "signal" ? 1.16 : wideFlow || family === "briefing" ? 0.72 : 4.12,
      top = wideFlow || family !== "editorial" ? sectionTitle(undefined, true) : 1.23,
      width = columnWidth - indent - markerInset;
    const lines = wrapRuns(runs, size, width, fonts);
    const leading = (size * 1.29) / 72;
    const height = lines.length * leading + 0.035;
    const nextLines = keepNext
      ? wrapRuns(keepNext.runs, keepNext.size, proseWidth(columnWidth, keepNext), fonts).length
      : 0;
    const nextLeading = keepNext ? (keepNext.size * 1.29) / 72 : 0;
    const keepPrevious = splitAfterHeading;
    // If a heading and its next paragraph cannot share a whole page, the next
    // paragraph must use the space reserved here instead of moving away intact.
    splitAfterHeading = Boolean(keepNext && height + 0.19 + nextLines * nextLeading > 6.55 - top);
    const nextHeight = keepNext
      ? 0.19 +
        (height + 0.19 + nextLines * nextLeading <= 6.55 - top
          ? nextLines
          : Math.min(2, nextLines)) *
          nextLeading
      : 0;
    // A complete paragraph/list item stays together when it fits a fresh page.
    // For oversized blocks, leave at least two lines on either side of a break.
    if (
      !keepPrevious &&
      flow &&
      height + nextHeight <= 6.55 - top &&
      flow.y + height + nextHeight > 6.55
    )
      flow = flowSlide();
    for (const [index, line] of lines.entries()) {
      const capacity = flow ? Math.floor((6.55 - flow.y - 0.035 + 1e-8) / leading) : 0;
      if (!flow || capacity < 1 || (lines.length - index > capacity && capacity === 1))
        flow = flowSlide();
      else if (lines.length - index === capacity + 1 && capacity === 2) flow = flowSlide();
      text(
        flow.slide,
        index === 0 && bullet
          ? line.map((run, runIndex) =>
              runIndex === 0 ? { ...run, text: `\u00a0${run.text}` } : run,
            )
          : line,
        columnX + indent + (index === 0 ? 0 : markerInset),
        flow.y,
        index === 0 ? columnWidth - indent : width,
        leading + 0.035,
        size,
        index === 0 && bullet
          ? {
              wrap: false,
              bullet: bullet.ordered
                ? { type: "number", numberType: "arabicPeriod", startAt: bullet.value, indent: 18 }
                : { indent: 18 },
            }
          : { wrap: false },
      );
      flow.y += leading;
    }
    if (flow) flow.y += 0.19;
  };

  if (model.title && model.design.cover !== false) {
    if (family !== "editorial") {
      const signal = family === "signal";
      const slide = base(`${family}-cover`, signal ? ink : paper);
      const titleWidth = signal ? 11.25 : 7.2,
        titleSize = signal ? 48 : 38;
      const titleY = signal ? 2 : 1.6;
      const titleLines = wrapRuns([{ text: model.title }], titleSize, titleWidth, fonts, true);
      const titleHeight = (titleLines.length * titleSize * 1.29) / 72;
      if (titleY + titleHeight > 5.55)
        throw new Error("Presentation title is too long for its cover");
      rect(slide, 0.82, signal ? 0.65 : 1.25, signal ? 11.69 : 7.2, signal ? 0.08 : 0.025, accent);
      if (!signal) rect(slide, 8.55, 1.25, 0.018, 4.8, surface);
      if (model.design.eyebrow)
        text(
          slide,
          [{ text: model.design.eyebrow }],
          signal ? 0.82 : 9.02,
          signal ? 1 : 1.6,
          signal ? 11.25 : 3.2,
          0.4,
          12,
          { bold: true, color: signal ? paper : accentText },
        );
      lineText(slide, titleLines, 0.82, titleY, titleWidth, titleSize, {
        fontFace: displayFont,
        color: signal ? paper : ink,
      });
      if (model.design.subtitle) {
        const width = signal ? 10.7 : 3.1;
        const subtitle = wrapRuns([{ text: model.design.subtitle }], 20, width, fonts);
        const y = signal ? titleY + titleHeight + 0.35 : 2.4;
        if (y + (subtitle.length * 20 * 1.29) / 72 > 6.35)
          throw new Error("Presentation subtitle overflows the cover; shorten it");
        lineText(slide, subtitle, signal ? 0.85 : 9.02, y, width, 20, {
          color: signal ? paper : muted,
        });
      }
    } else {
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
  }

  for (const [blockIndex, block] of model.blocks.entries()) {
    // Only an immediately adjacent, short paragraph can occupy a figure's remaining space.
    // Headings, lists, explicit breaks and longer prose keep their existing slide flow.
    if (block.type === "paragraph" && captionArea) {
      const lines = shortCaption(block.runs);
      const area = captionArea;
      captionArea = undefined;
      if (lines && area.y + lines.length * captionLeading + 0.035 <= 6.55) {
        lineText(area.slide, lines, 0.72, area.y, 11.89, captionSize, { color: muted });
        continue;
      }
    }
    captionArea = undefined;
    if (prose(block)) prepareFlow(blockIndex);
    if (block.type === "heading") {
      if (block.level <= 2) {
        // Adjacent headings describe one hierarchy until content or an explicit
        // divider is encountered; they are not requests for empty slides.
        section = pendingSection ? [...section, block.text] : [block.text];
        continuation = false;
        flow = undefined;
        pendingSection = true;
      } else
        body(
          [{ text: block.text, bold: true }],
          23,
          undefined,
          model.blocks[blockIndex + 1] ? prose(model.blocks[blockIndex + 1])?.[0] : undefined,
        );
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
      if (pendingSection) sectionSlide();
      flow = undefined;
      continue;
    }
    flow = undefined;
    if (block.type === "code") {
      wideFlow = false;
      body([{ text: block.text, code: true }], 18);
    } else if (block.type === "quote") {
      const lines = wrapRuns(block.runs, 27, 9.6, fonts);
      for (let offset = 0; offset < lines.length; ) {
        const slide = base("pull-quote");
        const y = sectionTitle(slide);
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
        const y = sectionTitle(slide);
        const height = 6.45 - y - 0.2;
        let columns = Math.min(
          family === "signal" ? 1 : family === "briefing" ? 2 : 3,
          block.items.length - offset,
        );
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
      const measured = block.items.map((item) => {
        const title = wrapRuns([{ text: item.title, bold: true }], 23, 10.4, fonts);
        const detail = item.detail ? wrapRuns([{ text: item.detail }], 18, 10.4, fonts) : [];
        const titleHeight = (title.length * 23 * 1.29) / 72,
          detailHeight = (detail.length * 18 * 1.29) / 72;
        return {
          title,
          detail,
          height: Math.max(
            0.66,
            0.03 + titleHeight + 0.035,
            detail.length ? 0.1 + titleHeight + detailHeight + 0.035 : 0,
          ),
        };
      });
      const firstSlide = base("process"),
        y = sectionTitle(firstSlide),
        availableHeight = 6.45 - y;
      const next = model.blocks[blockIndex + 1];
      const caption = next?.type === "paragraph" ? shortCaption(next.runs) : undefined;
      const captionHeight = caption ? caption.length * captionLeading + 0.035 + captionGap : 0;
      // Keep a short takeaway with the last group, even if balancing must split
      // five steps as 3+2. A single oversized step may still need its own page.
      const reservedCaptionHeight =
        measured[measured.length - 1].height + captionHeight <= availableHeight ? captionHeight : 0;
      type StepPlan = {
        pages: { start: number; end: number; height: number }[];
        singletons: number;
        imbalance: number;
      };
      // The schema permits at most 12 steps. Choose contiguous measured groups:
      // fewest pages first, then avoid orphan steps, then balance occupied height.
      const plans: (StepPlan | undefined)[] = new Array(measured.length + 1);
      plans[measured.length] = { pages: [], singletons: 0, imbalance: 0 };
      for (let start = measured.length - 1; start >= 0; start--) {
        let height = 0;
        for (let end = start + 1; end <= measured.length; end++) {
          height += measured[end - 1].height + (end - start > 1 ? 0.1 : 0);
          if (height > availableHeight - (end === measured.length ? reservedCaptionHeight : 0))
            break;
          const rest = plans[end];
          if (!rest) continue;
          const candidate: StepPlan = {
            pages: [{ start, end, height }, ...rest.pages],
            singletons: rest.singletons + (end - start === 1 ? 1 : 0),
            imbalance: rest.imbalance + height ** 2,
          };
          const best = plans[start];
          if (
            !best ||
            candidate.pages.length < best.pages.length ||
            (candidate.pages.length === best.pages.length &&
              (candidate.singletons < best.singletons ||
                (candidate.singletons === best.singletons &&
                  (candidate.imbalance < best.imbalance - 1e-8 ||
                    (Math.abs(candidate.imbalance - best.imbalance) < 1e-8 &&
                      end > best.pages[0].end)))))
          )
            plans[start] = candidate;
        }
      }
      const plan = plans[0];
      if (!plan) throw new Error("Process step is too dense; use a separate prose section");
      for (const [pageIndex, page] of plan.pages.entries()) {
        const slide = pageIndex === 0 ? firstSlide : base("process");
        if (pageIndex > 0) sectionTitle(slide);
        const contentHeight = measured
          .slice(page.start, page.end)
          .reduce((sum, item) => sum + item.height, 0);
        const gap = Math.min(
          0.6,
          (availableHeight -
            (page.end === measured.length ? reservedCaptionHeight : 0) -
            contentHeight) /
            Math.max(1, page.end - page.start - 1),
        );
        let top = y,
          visibleBottom = y;
        for (let offset = page.start; offset < page.end; offset++) {
          const item = measured[offset];
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
          const height = lineText(slide, item.title, 1.65, top + 0.03, 10.4, 23);
          if (item.detail.length)
            lineText(slide, item.detail, 1.65, top + 0.1 + height, 10.4, 18, { color: muted });
          visibleBottom = top + item.height;
          top += item.height + gap;
        }
        captionArea = { slide, y: visibleBottom + captionGap };
      }
    } else if (block.type === "chart") {
      const slide = base("data-chart");
      let y = title(slide, block.title);
      if (pendingSection && (section.length > 1 || section[0] !== block.title)) {
        const label = wrapRuns(
          [{ text: section.filter((heading) => heading !== block.title).join("\n") }],
          12,
          11.89,
          fonts,
        );
        y += lineText(slide, label, 0.72, y, 11.89, 12, { color: muted }) + 0.18;
      }
      const labelLength = Math.max(...block.labels.map((label) => label.length));
      if (labelLength > 55)
        throw new Error(
          "Chart labels are too long for presentation axes; shorten labels and explain them in prose",
        );
      const next = model.blocks[blockIndex + 1];
      const caption = next?.type === "paragraph" ? shortCaption(next.runs) : undefined;
      const captionHeight = caption ? caption.length * captionLeading + 0.035 + captionGap : 0;
      const labelSize = block.labels.length > 8 ? 15 : 18;
      const minimumChartHeight = Math.max(
        2.4,
        (block.labels.length * labelSize * 1.29 * 1.2) / 72 + 0.75,
      );
      const fullHeight = 6.45 - y;
      const height =
        caption && fullHeight - captionHeight >= minimumChartHeight
          ? fullHeight - captionHeight
          : fullHeight;
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
          h: height,
          catAxisLabelFontFace: bodyFont,
          catAxisLabelFontSize: labelSize,
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
      captionArea = { slide, y: y + height + captionGap };
    } else if (block.type === "image") {
      const image = model.images.get(block.fileId);
      if (!image) throw new Error(`Document image is missing: ${block.fileId}`);
      const slide = base("image-caption");
      const y = sectionTitle(slide);
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
        const y = sectionTitle(slide);
        if (headerHeight > 2)
          throw new Error("Presentation table header is too dense; shorten its column headings");
        const cellRuns = (lines: Line[], color: string) =>
          styled(
            lines.flatMap((line, index) => [...(index ? [{ text: "\n" }] : []), ...line]),
            color,
          );
        const rows: PptxModule.default.TableRow[] = [
          headerLines.map((lines) => ({
            text: cellRuns(lines, paper),
            options: { bold: true, fill: { color: ink }, color: paper },
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
        captionArea = { slide, y: y + used + captionGap };
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
