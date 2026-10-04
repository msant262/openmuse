import { inspectPdf, PdfError } from "./pdf.ts";

/** Extract actual page drawing text, never document title/subject/other metadata.
 * Only the text API is used: no rendering, scripting, URLs or external assets.
 */
export async function readPdfText(bytes: Uint8Array): Promise<string> {
  await inspectPdf(bytes);
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    stopAtErrors: true,
    verbosity: 0,
  });
  try {
    const pdf = await task.promise;
    const pages: string[] = [];
    let size = 0;
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
        .join("");
      size += text.length;
      if (size > 1000000)
        throw new PdfError("PDF text exceeds the 1000000-character inspection limit");
      pages.push(text);
      page.cleanup();
    }
    return pages.join("\n");
  } catch (error) {
    if (error instanceof PdfError) throw error;
    throw new PdfError("Cannot read PDF page text");
  } finally {
    await task.destroy();
  }
}
