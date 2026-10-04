import { readFile } from "node:fs/promises";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, type PDFPage, PDFString, rgb } from "pdf-lib";
import {
  composeDocument,
  type DocumentBlock,
  type DocumentModel,
  type DocumentRun,
} from "./document-model.ts";
import { PdfError } from "./pdf.ts";

const W = 595.28,
  H = 841.89,
  M = 52,
  BOTTOM = 62,
  AREA = W - 2 * M;
const fontCache = new Map<string, Promise<Buffer>>();
const fontData = (name: string) => {
  let data = fontCache.get(name);
  if (!data) {
    data = readFile(new URL(`../assets/${name}.ttf`, import.meta.url));
    fontCache.set(name, data);
  }
  return data;
};
const color = (hex: string) => {
  if (!/^#[a-f\d]{6}$/i.test(hex))
    throw new PdfError("Document palette colors must be six-digit hex values");
  return rgb(
    Number.parseInt(hex.slice(1, 3), 16) / 255,
    Number.parseInt(hex.slice(3, 5), 16) / 255,
    Number.parseInt(hex.slice(5, 7), 16) / 255,
  );
};
type Fragment = { text: string; font: PDFFont; width: number; href?: string };
type Line = Fragment[];

/** Native, deterministic composition. No network, scripts, executable markup or remote desktop. */
export async function createDesignedPdf(
  content: string | DocumentModel,
  title?: string,
): Promise<Uint8Array> {
  const model = typeof content === "string" ? composeDocument(content, title) : content;
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  doc.setCreator("OpenMuse");
  doc.setProducer("OpenMuse document design");
  if (model.title) doc.setTitle(model.title);
  doc.registerFontkit(fontkit);
  const load = async (name: string) =>
    doc.embedFont(await fontData(name), { subset: true, customName: `OpenMuse${name}` });
  // Embed in fixed order even on a cold font cache, preserving replay bytes.
  const fonts: PDFFont[] = [];
  for (const name of [
    "DejaVuSans",
    "DejaVuSans-Bold",
    "DejaVuSans-Oblique",
    "DejaVuSans-BoldOblique",
    "DejaVuSerif",
    "DejaVuSerif-Bold",
    "DejaVuSansMono",
  ])
    fonts.push(await load(name));
  const [regular, bold, italic, boldItalic, serif, serifBold, mono] = fonts;
  const display = model.theme.display === "serif" ? serif : bold;
  const heading = model.theme.display === "serif" ? serifBold : bold;
  const ink = color(model.theme.ink),
    paper = color(model.theme.paper),
    accent = color(model.theme.accent),
    muted = color(model.theme.muted),
    surface = color(model.theme.surface);
  const sets = new Map<PDFFont, Set<number>>();
  const lines = (
    runs: readonly DocumentRun[],
    size: number,
    available: number,
    forced?: PDFFont,
    preserveWhitespace = false,
  ): Line[] => {
    if (available <= 0) throw new PdfError("Document column is too narrow");
    const result: Line[] = [];
    let line: Line = [],
      used = 0;
    const flush = () => {
      result.push(line);
      line = [];
      used = 0;
    };
    const add = (text: string, font: PDFFont, href?: string) => {
      const width = font.widthOfTextAtSize(text, size);
      line.push({ text, font, width, href });
      used += width;
    };
    for (const run of runs) {
      const font =
        forced ??
        (run.code
          ? mono
          : run.bold && run.italic
            ? boldItalic
            : run.bold
              ? bold
              : run.italic
                ? italic
                : regular);
      let chars = sets.get(font);
      if (!chars) {
        chars = new Set(font.getCharacterSet());
        sets.set(font, chars);
      }
      for (const character of run.text)
        if (character !== "\n" && character !== "\t" && !chars.has(character.codePointAt(0) ?? 0))
          throw new PdfError(
            `PDF font does not support U+${character.codePointAt(0)?.toString(16).toUpperCase()}; revise that character or create a text/markdown document`,
          );
      for (const word of run.text
        .replace(/\t/g, "    ")
        .split(/(\n|[^\S\n]+)/u)
        .filter(Boolean)) {
        if (word === "\n") {
          flush();
          continue;
        }
        if (/^\s+$/.test(word)) {
          if (preserveWhitespace) {
            for (const space of word) {
              if (used + font.widthOfTextAtSize(space, size) > available) flush();
              add(space, font, run.href);
            }
          } else if (line.length) add(" ", font, run.href);
          continue;
        }
        if (word.length <= 512 && font.widthOfTextAtSize(word, size) <= available) {
          if (used + font.widthOfTextAtSize(word, size) > available) flush();
          add(word, font, run.href);
          continue;
        }
        // Avoid repeatedly shaping an arbitrarily long unbroken word.
        for (const { segment } of new Intl.Segmenter(undefined, {
          granularity: "grapheme",
        }).segment(word)) {
          if (segment.length > 256)
            throw new PdfError("PDF text contains an oversized combining sequence");
          const width = font.widthOfTextAtSize(segment, size);
          if (width > available)
            throw new PdfError("PDF text contains a glyph sequence wider than a column");
          if (used + width > available) flush();
          add(segment, font, run.href);
        }
      }
    }
    if (line.length || !result.length) flush();
    return result;
  };
  const plain = (text: string, size: number, width = AREA, font = regular) =>
    lines([{ text }], size, width, font);
  let page: PDFPage,
    y = H - 72;
  const draw = (line: Line, x: number, top: number, size: number, tint = ink) => {
    for (const part of line) {
      if (part.text.trim())
        page.drawText(part.text, { x, y: top - size, size, font: part.font, color: tint });
      if (part.href && part.text.trim()) {
        const annotation = doc.context.obj({
          Type: "Annot",
          Subtype: "Link",
          Rect: [x, top - size, x + part.width, top + 2],
          Border: [0, 0, 0],
          A: { Type: "Action", S: "URI", URI: PDFString.of(part.href) },
        });
        page.node.addAnnot(doc.context.register(annotation));
      }
      x += part.width;
    }
  };
  const newPage = () => {
    if (doc.getPageCount() >= 100)
      throw new PdfError("Document exceeds the 100-page authoring limit");
    page = doc.addPage([W, H]);
    y = H - 72;
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: paper });
    page.drawRectangle({ x: M, y: H - 35, width: 24, height: 3, color: accent });
    if (doc.getPageCount() > 1 && model.title)
      draw(plain(model.title, 7.5, AREA - 42, bold)[0], M + 34, H - 26, 7.5, muted);
  };
  const ensure = (height: number) => {
    if (height > H - 72 - BOTTOM)
      throw new PdfError("A document element is taller than a page; shorten or split it");
    if (y - height < BOTTOM) newPage();
  };
  const paragraph = (
    runs: DocumentRun[],
    size = 10.5,
    leading = 16.2,
    font?: PDFFont,
    tint = ink,
    after = 10,
  ) => {
    for (const line of lines(runs, size, AREA, font)) {
      ensure(leading);
      draw(line, M, y, size, tint);
      y -= leading;
    }
    y -= after;
  };
  newPage();
  if (model.design.cover && model.title) y = H - 152;
  if (model.design.eyebrow)
    paragraph([{ text: model.design.eyebrow.toLocaleUpperCase() }], 8, 12, bold, muted, 18);
  if (model.title) {
    const size = model.design.cover ? 42 : 32;
    paragraph([{ text: model.title }], size, size * 1.18, display, ink, 18);
  }
  if (model.design.subtitle)
    paragraph(
      [{ text: model.design.subtitle }],
      model.design.cover ? 15 : 12,
      model.design.cover ? 22 : 18,
      regular,
      muted,
      20,
    );
  page!.drawRectangle({ x: M, y: y + 1, width: 56, height: 3, color: accent });
  y -= 24;
  if (model.design.cover && model.title) {
    const chapters = model.blocks
      .filter(
        (block): block is Extract<DocumentBlock, { type: "heading" }> =>
          block.type === "heading" && block.level <= 2,
      )
      .slice(0, 6);
    if (chapters.length) {
      y = Math.min(y - 30, 360);
      for (const [index, chapter] of chapters.entries()) {
        const wrapped = plain(chapter.text, 10, AREA - 38);
        ensure(wrapped.length * 15 + 12);
        draw(plain(String(index + 1).padStart(2, "0"), 9, 30, bold)[0], M, y, 9, muted);
        for (const line of wrapped) {
          draw(line, M + 38, y, 10);
          y -= 15;
        }
        y -= 12;
      }
    }
    if (model.blocks.length) newPage();
  }
  const followingHeight = (next: DocumentBlock | undefined) => {
    if (!next) return 0;
    if (next.type === "table") {
      const cw = AREA / next.headers.length;
      const rowHeight = (cells: DocumentRun[][], head = false) =>
        Math.max(
          ...cells.map((cell) => lines(cell, 8.7, cw - 18, head ? bold : undefined).length),
          1,
        ) *
          13 +
        18;
      return rowHeight(next.headers, true) + (next.rows[0] ? rowHeight(next.rows[0]) : 0);
    }
    if (next.type === "metrics") {
      const cols = Math.min(3, next.items.length),
        cw = (AREA - 12 * (cols - 1)) / cols;
      return (
        Math.max(
          ...next.items
            .slice(0, cols)
            .map(
              (item) =>
                34 +
                plain(item.value, 27, cw - 28, display).length * 33 +
                plain(item.label, 9, cw - 28, bold).length * 14 +
                (item.detail ? plain(item.detail, 8.5, cw - 28).length * 13 + 8 : 0),
            ),
        ) + 12
      );
    }
    if (next.type === "chart")
      return (
        plain(next.title, 12, AREA, bold).length * 18 +
        36 +
        next.labels.reduce(
          (sum, label, index) =>
            sum +
            Math.max(
              29,
              plain(label, 9, 110).length * 13 + 10,
              plain(`${next.values[index]}${next.unit ? ` ${next.unit}` : ""}`, 8.5, 74, bold)
                .length *
                12 +
                10,
            ),
          0,
        )
      );
    if (next.type === "steps")
      return (
        18 +
        plain(next.items[0].title, 11, AREA - 44, bold).length * 16 +
        (next.items[0].detail ? plain(next.items[0].detail, 10, AREA - 44).length * 15 : 0)
      );
    if (next.type === "image") {
      const image = model.images.get(next.fileId);
      if (image)
        return (
          Math.min((AREA / image.width) * image.height, H - 72 - BOTTOM - 160) +
          (next.caption ? plain(next.caption, 8.5).length * 13 : 0) +
          28
        );
    }
    return 48;
  };
  for (const [blockIndex, block] of model.blocks.entries()) {
    if (block.type === "heading") {
      const size = block.level <= 2 ? 21 : block.level === 3 ? 14 : 11,
        wrapped = plain(block.text, size, AREA, heading);
      ensure(
        Math.min(
          H - 72 - BOTTOM,
          wrapped.length * size * 1.28 + 24 + followingHeight(model.blocks[blockIndex + 1]),
        ),
      );
      y -= 12;
      for (const line of wrapped) {
        ensure(size * 1.28);
        draw(line, M, y, size);
        y -= size * 1.28;
      }
      y -= 12;
    } else if (block.type === "paragraph") paragraph(block.runs);
    else if (block.type === "list") {
      for (const [index, item] of block.items.entries()) {
        const inset = 18 + Math.min(item.level, 8) * 14,
          wrapped = lines(item.runs, 10.5, AREA - inset);
        ensure(Math.min(2, wrapped.length) * 16.2);
        draw(
          plain(
            (item.ordered ?? block.ordered) ? `${item.number ?? block.start + index}.` : "•",
            10,
            inset - 4,
            bold,
          )[0],
          M + inset - 18,
          y,
          10,
          muted,
        );
        for (const line of wrapped) {
          ensure(16.2);
          draw(line, M + inset, y, 10.5);
          y -= 16.2;
        }
        y -= 5;
      }
      y -= 7;
    } else if (block.type === "quote" || block.type === "code") {
      const size = block.type === "code" ? 8.6 : 11.5,
        leading = block.type === "code" ? 13 : 17.5;
      const wrapped =
        block.type === "code"
          ? lines([{ text: block.text }], size, AREA - 34, mono, true)
          : lines(block.runs, size, AREA - 34);
      let offset = 0;
      while (offset < wrapped.length) {
        ensure(leading + 30);
        const take = Math.max(
            1,
            Math.min(wrapped.length - offset, Math.floor((y - BOTTOM - 28) / leading)),
          ),
          h = take * leading + 28;
        page!.drawRectangle({ x: M, y: y - h, width: AREA, height: h, color: surface });
        page!.drawRectangle({ x: M, y: y - h, width: 3, height: h, color: accent });
        y -= 14;
        for (const line of wrapped.slice(offset, offset + take)) {
          draw(line, M + 17, y, size);
          y -= leading;
        }
        y -= 24;
        offset += take;
      }
    } else if (block.type === "rule") {
      ensure(20);
      page!.drawLine({
        start: { x: M, y: y - 3 },
        end: { x: W - M, y: y - 3 },
        color: surface,
        thickness: 1,
      });
      y -= 22;
    } else if (block.type === "table") {
      const colWidth = AREA / block.headers.length;
      const rowLines = (cells: DocumentRun[][], head = false) =>
        cells.map((cell) => lines(cell, 8.7, colWidth - 18, head ? bold : undefined));
      const rowHeight = (cells: Line[][]) =>
        Math.max(...cells.map((cell) => cell.length), 1) * 13 + 18;
      const head = rowLines(block.headers, true),
        headHeight = rowHeight(head);
      const row = (cells: Line[][], header: boolean, alternate = false) => {
        const h = rowHeight(cells);
        page!.drawRectangle({
          x: M,
          y: y - h,
          width: AREA,
          height: h,
          color: header || alternate ? surface : paper,
          opacity: alternate && !header ? 0.45 : 1,
        });
        cells.forEach((cell, c) => {
          cell.forEach((line, i) => {
            draw(line, M + c * colWidth + 9, y - 9 - i * 13, 8.7);
          });
        });
        y -= h;
        page!.drawLine({
          start: { x: M, y },
          end: { x: W - M, y },
          color: surface,
          thickness: 0.6,
        });
      };
      ensure(headHeight + (block.rows[0] ? rowHeight(rowLines(block.rows[0])) : 0));
      row(head, true);
      for (const [index, cells] of block.rows.entries()) {
        const wrapped = rowLines(cells),
          h = rowHeight(wrapped);
        if (h + headHeight > H - 72 - BOTTOM)
          throw new PdfError("A table row is taller than a page; split that row");
        if (y - h < BOTTOM) {
          newPage();
          row(head, true);
        }
        row(wrapped, false, index % 2 === 1);
      }
      y -= 20;
    } else if (block.type === "metrics") {
      const cols = Math.min(3, block.items.length),
        gap = 12,
        cw = (AREA - gap * (cols - 1)) / cols;
      for (let start = 0; start < block.items.length; start += cols) {
        const cards = block.items.slice(start, start + cols).map((item) => ({
          value: plain(item.value, 27, cw - 28, display),
          label: plain(item.label, 9, cw - 28, bold),
          detail: item.detail ? plain(item.detail, 8.5, cw - 28) : [],
        }));
        const h = Math.max(
          ...cards.map(
            (card) =>
              34 +
              card.value.length * 33 +
              card.label.length * 14 +
              card.detail.length * 13 +
              (card.detail.length ? 8 : 0),
          ),
        );
        ensure(h + 12);
        cards.forEach((card, i) => {
          const x = M + i * (cw + gap);
          let top = y - 16;
          page!.drawRectangle({ x, y: y - h, width: cw, height: h, color: surface });
          page!.drawRectangle({ x, y: y - 3, width: 24, height: 3, color: accent });
          for (const line of card.value) {
            draw(line, x + 14, top, 27);
            top -= 33;
          }
          top -= 6;
          for (const line of card.label) {
            draw(line, x + 14, top, 9);
            top -= 14;
          }
          top -= 8;
          for (const line of card.detail) {
            draw(line, x + 14, top, 8.5, muted);
            top -= 13;
          }
        });
        y -= h + 12;
      }
      y -= 6;
    } else if (block.type === "steps") {
      for (const [index, item] of block.items.entries()) {
        const titles = plain(item.title, 11, AREA - 44, bold),
          details = item.detail ? plain(item.detail, 10, AREA - 44) : [];
        const h = Math.max(34, titles.length * 16 + details.length * 15 + 18);
        ensure(h);
        page!.drawCircle({ x: M + 12, y: y - 12, size: 12, color: surface });
        const label = String(index + 1);
        page!.drawText(label, {
          x: M + 12 - bold.widthOfTextAtSize(label, 9) / 2,
          y: y - 15,
          font: bold,
          size: 9,
          color: ink,
        });
        let top = y;
        for (const line of titles) {
          draw(line, M + 44, top, 11);
          top -= 16;
        }
        for (const line of details) {
          draw(line, M + 44, top, 10, muted);
          top -= 15;
        }
        y -= h;
      }
      y -= 8;
    } else if (block.type === "chart") {
      const labels = block.labels.map((label) => plain(label, 9, 110)),
        rowHeights = labels.map((label, index) =>
          Math.max(
            29,
            label.length * 13 + 10,
            plain(`${block.values[index]}${block.unit ? ` ${block.unit}` : ""}`, 8.5, 74, bold)
              .length *
              12 +
              10,
          ),
        ),
        titles = plain(block.title, 12, AREA, bold);
      ensure(rowHeights.reduce((a, b) => a + b, 0) + titles.length * 18 + 36);
      for (const line of titles) {
        draw(line, M, y, 12);
        y -= 18;
      }
      y -= 14;
      const low = Math.min(0, ...block.values),
        high = Math.max(0, ...block.values),
        range = high - low || 1;
      const plotX = M + 124,
        plotWidth = AREA - 204,
        zero = plotX + (-low / range) * plotWidth;
      block.values.forEach((value, i) => {
        labels[i].forEach((line, j) => {
          draw(line, M, y - j * 13, 9);
        });
        const endpoint = plotX + ((value - low) / range) * plotWidth;
        page!.drawRectangle({
          x: Math.min(zero, endpoint),
          y: y - 16,
          width: Math.abs(endpoint - zero),
          height: 13,
          color: [accent, ink, muted][i % 3],
        });
        const values = plain(`${value}${block.unit ? ` ${block.unit}` : ""}`, 8.5, 74, bold);
        values.forEach((line, j) => {
          draw(line, plotX + plotWidth + 8, y - 2 - j * 12, 8.5);
        });
        y -= Math.max(rowHeights[i], values.length * 12 + 10);
      });
      y -= 18;
    } else if (block.type === "image") {
      const image = model.images.get(block.fileId);
      if (!image)
        throw new PdfError("An owned image attachment was not resolved for this document");
      const embedded =
        image.mimeType === "image/png"
          ? await doc.embedPng(image.bytes)
          : await doc.embedJpg(image.bytes);
      const captions = block.caption ? plain(block.caption, 8.5) : [],
        maxHeight = H - 72 - BOTTOM - captions.length * 13 - 160;
      const scale = Math.min(AREA / embedded.width, maxHeight / embedded.height),
        w = embedded.width * scale,
        h = embedded.height * scale;
      ensure(h + captions.length * 13 + 28);
      page!.drawImage(embedded, { x: M + (AREA - w) / 2, y: y - h, width: w, height: h });
      y -= h + 9;
      for (const line of captions) {
        draw(line, M, y, 8.5, muted);
        y -= 13;
      }
      y -= 18;
    }
  }
  for (const [index, sheet] of doc.getPages().entries()) {
    page = sheet;
    sheet.drawLine({
      start: { x: M, y: 42 },
      end: { x: W - M, y: 42 },
      thickness: 0.5,
      color: surface,
    });
    const folio = `${index + 1} / ${doc.getPageCount()}`;
    sheet.drawText(folio, {
      x: W - M - regular.widthOfTextAtSize(folio, 8),
      y: 25,
      size: 8,
      font: regular,
      color: muted,
    });
    if (model.design.footer) {
      const footer = plain(model.design.footer, 7.5, AREA - 62);
      if (footer.length > 3) throw new PdfError("Document footer exceeds three lines; shorten it");
      footer.forEach((line, index) => {
        draw(line, M, 39 - index * 9, 7.5, muted);
      });
    }
  }
  return doc.save();
}
