import { readFile } from "node:fs/promises";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, rgb } from "pdf-lib";
import { PdfError } from "./pdf.ts";

export const documentCharacterLimit = 120000;
const pageLimit = 100;
let fontBytes: Promise<Buffer> | undefined;
const fontData = () =>
  (fontBytes ??= readFile(new URL("../assets/DejaVuSans.ttf", import.meta.url)));

function wrap(line: string, font: PDFFont, size: number, width: number): string[] {
  const output: string[] = [];
  let current = "";
  for (const word of line.split(/\s+/u).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      current = candidate;
      continue;
    }
    if (current) output.push(current);
    if (font.widthOfTextAtSize(word, size) <= width) {
      current = word;
      continue;
    }
    const glyphs = Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(word),
      (entry) => entry.segment,
    );
    if (glyphs.some((glyph) => glyph.length > 256))
      throw new PdfError("PDF text contains an oversized combining sequence");
    let offset = 0;
    while (offset < glyphs.length) {
      // Bound each measurement instead of repeatedly shaping the entire
      // remaining (possibly 120000-character) unbroken word.
      let lower = 1,
        upper = Math.min(256, glyphs.length - offset);
      while (lower < upper) {
        const middle = Math.ceil((lower + upper) / 2);
        if (font.widthOfTextAtSize(glyphs.slice(offset, offset + middle).join(""), size) <= width)
          lower = middle;
        else upper = middle - 1;
      }
      current = glyphs.slice(offset, offset + lower).join("");
      if (font.widthOfTextAtSize(current, size) > width)
        throw new PdfError("PDF text contains a glyph sequence wider than a page");
      offset += lower;
      if (offset < glyphs.length) output.push(current);
    }
  }
  return [...output, current];
}

/** Local, deterministic authoring: no network, executable markup or remote desktop. */
export async function createDocumentPdf(content: string, title?: string): Promise<Uint8Array> {
  if (!content.trim() || content.length > documentCharacterLimit || (title?.length ?? 0) > 200)
    throw new PdfError(
      "Document content must be nonempty and at most 120000 characters; title at most 200",
    );
  const body = content.normalize("NFC").replace(/\r\n?/g, "\n");
  const heading = title?.normalize("NFC");
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  doc.setCreator("OpenMuse");
  doc.setProducer("OpenMuse document authoring");
  if (heading) doc.setTitle(heading);
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(await fontData(), {
    subset: true,
    customName: "OpenMuseDejaVuSans",
  });
  const characters = new Set(font.getCharacterSet());
  for (const character of (heading ?? "") + body) {
    if (character === "\n" || character === "\t") continue;
    const codepoint = character.codePointAt(0) ?? 0;
    if (!characters.has(codepoint))
      throw new PdfError(
        `PDF font does not support U+${codepoint.toString(16).toUpperCase()}; revise that character or create a text/markdown document`,
      );
  }
  const margin = 48,
    width = 595.28,
    height = 841.89;
  let page = doc.addPage([width, height]),
    y = height - margin;
  const draw = (text: string, size: number, leading: number) => {
    if (y < margin + leading) {
      if (doc.getPageCount() >= pageLimit)
        throw new PdfError("Document exceeds the 100-page authoring limit");
      page = doc.addPage([width, height]);
      y = height - margin;
    }
    if (text)
      page.drawText(text, { x: margin, y: y - size, size, font, color: rgb(0.12, 0.15, 0.2) });
    y -= leading;
  };
  if (heading) {
    for (const line of wrap(heading.replace(/\s+/gu, " "), font, 18, width - 2 * margin))
      draw(line, 18, 25);
    y -= 12;
  }
  for (const paragraph of body.split("\n"))
    for (const line of wrap(paragraph, font, 11, width - 2 * margin)) draw(line, 11, 16);
  for (const [index, sheet] of doc.getPages().entries())
    sheet.drawText(`${index + 1} / ${doc.getPageCount()}`, {
      x: margin,
      y: 24,
      size: 9,
      font,
      color: rgb(0.4, 0.44, 0.48),
    });
  return doc.save();
}
