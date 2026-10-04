import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Canvas, createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { inspectPdf, PdfError } from "./pdf.ts";

export const documentRendererVersion = "openmuse-document-render-v2";
let renderQueue: Promise<unknown> = Promise.resolve();
const maxPdfBytes = 10 * 1024 * 1024,
  maxOfficeBytes = 25 * 1024 * 1024;
const maxPagePixels = 1350 * 1550,
  maxPreviewPixels = 9_000_000;

/** Observe the original promise after cancellation too, so later rejection is never unhandled. */
function cancellable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new PdfError("Document rendering was cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) abort();
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) {
      signal.removeEventListener("abort", abort);
      abort();
    }
  });
}

function boundedCanvas(width: number, height: number, limit: number): Canvas {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw new PdfError("Document page has invalid dimensions");
  const w = Math.ceil(width),
    h = Math.ceil(height);
  if (!Number.isSafeInteger(w * h) || w * h > limit)
    throw new PdfError("Document preview exceeds its pixel limit");
  return createCanvas(w, h);
}

async function officePdf(bytes: Uint8Array, format: "docx" | "pptx", signal?: AbortSignal) {
  const dir = await mkdtemp(join(tmpdir(), "openmuse-document-"));
  try {
    const source = join(dir, `document.${format}`),
      output = join(dir, "out");
    await mkdir(output);
    await writeFile(source, bytes, { mode: 0o600 });
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "libreoffice",
        [
          `-env:UserInstallation=${pathToFileURL(join(dir, "profile")).href}`,
          "--headless",
          "--nologo",
          "--nodefault",
          "--norestore",
          "--convert-to",
          "pdf",
          "--outdir",
          output,
          source,
        ],
        {
          detached: true,
          stdio: ["ignore", "ignore", "pipe"],
          env: { ...process.env, SAL_USE_VCLPLUGIN: "svp" },
        },
      );
      let stderr = "",
        failure: Error | undefined;
      child.stderr?.on("data", (part: Buffer) => {
        stderr = (stderr + part.toString()).slice(-4000);
      });
      const stop = (reason: Error) => {
        failure = reason;
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      };
      const timeout = setTimeout(
        () => stop(new PdfError("Office document rendering exceeded 120 seconds")),
        120000,
      );
      const abort = () => stop(new PdfError("Document rendering was cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      };
      child.on("error", () => {
        cleanup();
        reject(new PdfError("Office renderer unavailable; install LibreOffice Writer and Impress"));
      });
      child.on("close", (code) => {
        cleanup();
        if (failure) reject(failure);
        else if (code !== 0)
          reject(new PdfError(`Office rendering failed (${code}): ${stderr.slice(-500)}`));
        else resolve();
      });
    });
    const path = join(output, "document.pdf");
    if ((await stat(path)).size > maxPdfBytes) throw new PdfError("Rendered PDF exceeds 10 MB");
    return new Uint8Array(await readFile(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Render only server-authored, owned inputs; external input authorization is the caller's job. */
export async function renderDocument(
  bytes: Uint8Array,
  format: "pdf" | "docx" | "pptx",
  startPage = 1,
  count = 2,
  signal?: AbortSignal,
): Promise<{
  bytes: Uint8Array;
  pageCount: number;
  pages: number[];
  width: number;
  height: number;
}> {
  if (
    !Number.isInteger(startPage) ||
    startPage < 1 ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 4
  )
    throw new PdfError("Inspect 1 to 4 pages starting at a positive page number");
  if (bytes.length > (format === "pdf" ? maxPdfBytes : maxOfficeBytes))
    throw new PdfError(`Document exceeds ${format === "pdf" ? 10 : 25} MB`);
  signal?.throwIfAborted();
  const previous = renderQueue.catch(() => {});
  let release!: () => void;
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  // An abandoned slot still follows its predecessor, preserving serialization.
  renderQueue = previous.then(() => slot);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await cancellable(previous, signal);
    signal?.throwIfAborted();
    const deadline = new AbortController();
    timeout = setTimeout(
      () => deadline.abort(new PdfError("Document rendering exceeded 120 seconds")),
      120000,
    );
    signal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    const pdfBytes = format === "pdf" ? bytes : await officePdf(bytes, format, signal);
    const info = await cancellable(inspectPdf(pdfBytes), signal);
    if (info.pageCount < 1 || info.pageCount > 100 || startPage > info.pageCount)
      throw new PdfError("Document page range is invalid or exceeds 100 pages");
    // PDF.js uses these Canvas primitives when rasterizing native PDF paths.
    const platform = globalThis as unknown as Record<string, unknown>;
    platform.DOMMatrix ??= DOMMatrix;
    platform.Path2D ??= Path2D;
    platform.ImageData ??= ImageData;
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    signal.throwIfAborted();
    const task = getDocument({
      data: new Uint8Array(pdfBytes),
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      stopAtErrors: true,
      verbosity: 0,
    });
    let destruction: Promise<void> | undefined;
    const destroy = () => (destruction ??= task.destroy());
    const abortTask = () => {
      void destroy().catch(() => {});
    };
    signal.addEventListener("abort", abortTask, { once: true });
    if (signal.aborted) abortTask();
    try {
      const pdf = await cancellable(task.promise, signal);
      const pages = Array.from(
        { length: Math.min(count, pdf.numPages - startPage + 1) },
        (_, index) => startPage + index,
      );
      const tiles: { canvas: Canvas; page: number }[] = [];
      for (const pageNumber of pages) {
        signal.throwIfAborted();
        const page = await cancellable(pdf.getPage(pageNumber), signal),
          base = page.getViewport({ scale: 1 });
        if (
          !Number.isFinite(base.width) ||
          !Number.isFinite(base.height) ||
          base.width <= 0 ||
          base.height <= 0
        )
          throw new PdfError("Document page has invalid dimensions");
        const viewport = page.getViewport({
          scale: Math.min(1.8, 1350 / base.width, 1550 / base.height),
        });
        const canvas = boundedCanvas(viewport.width, viewport.height, maxPagePixels);
        signal.throwIfAborted();
        const rendering = page.render({
          canvas: canvas as unknown as HTMLCanvasElement,
          canvasContext: canvas.getContext("2d") as unknown as CanvasRenderingContext2D,
          viewport,
        });
        const abort = () => rendering.cancel();
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        try {
          await cancellable(rendering.promise, signal);
        } finally {
          signal.removeEventListener("abort", abort);
          page.cleanup();
        }
        tiles.push({ canvas, page: pageNumber });
      }
      const columns = tiles.length > 1 ? 2 : 1,
        rows = Math.ceil(tiles.length / columns),
        gap = 18,
        label = 28;
      const cellWidth = Math.max(...tiles.map((tile) => tile.canvas.width)),
        cellHeight = Math.max(...tiles.map((tile) => tile.canvas.height));
      const sheet = boundedCanvas(
        columns * cellWidth + (columns + 1) * gap,
        rows * (cellHeight + label) + (rows + 1) * gap,
        maxPreviewPixels,
      );
      const ctx = sheet.getContext("2d");
      ctx.fillStyle = "#DADAD6";
      ctx.fillRect(0, 0, sheet.width, sheet.height);
      ctx.font = "18px DejaVu Sans";
      ctx.fillStyle = "#262626";
      tiles.forEach((tile, index) => {
        const x = gap + (index % columns) * (cellWidth + gap),
          y = gap + Math.floor(index / columns) * (cellHeight + label + gap);
        ctx.fillText(`${tile.page} / ${pdf.numPages}`, x, y + 20);
        ctx.drawImage(tile.canvas, x, y + label);
      });
      const png = sheet.toBuffer("image/png");
      if (png.length > 8 * 1024 * 1024)
        throw new PdfError("Page preview exceeds 8 MB; inspect fewer pages at once");
      signal.throwIfAborted();
      return {
        bytes: png,
        pageCount: pdf.numPages,
        pages,
        width: sheet.width,
        height: sheet.height,
      };
    } finally {
      signal.removeEventListener("abort", abortTask);
      await destroy();
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    release();
  }
}
