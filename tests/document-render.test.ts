import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PDFDocument, rgb } from "pdf-lib";
import { getDesignProfile } from "../apps/server/src/design-catalog.ts";
import { createDocumentDocx } from "../packages/integrations/src/document-docx.ts";
import { composeDocument } from "../packages/integrations/src/document-model.ts";
import { createDesignedPdf } from "../packages/integrations/src/document-pdf.ts";
import { createDocumentPptx } from "../packages/integrations/src/document-pptx.ts";
import { renderDocument } from "../packages/integrations/src/document-render.ts";

async function pages(count = 3) {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < count; index++) {
    const page = pdf.addPage([400, 400]);
    page.drawRectangle({
      x: 0,
      y: 0,
      width: 400,
      height: 400,
      color: index % 2 ? rgb(0, 1, 0) : rgb(1, 0, 0),
    });
  }
  return pdf.save();
}

test("actual PDF preview contains requested page pixels and bounded complete page coverage", async () => {
  const bytes = await pages();
  const result = await renderDocument(bytes, "pdf", 2, 4);
  assert.equal(result.pageCount, 3);
  assert.deepEqual(result.pages, [2, 3]);
  assert.ok(result.width * result.height <= 9_000_000);
  const image = await loadImage(result.bytes),
    canvas = createCanvas(image.width, image.height),
    context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const pixel = (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data];
  assert.deepEqual(
    pixel(100, 100),
    [0, 255, 0, 255],
    "First tile must render requested page 2, not a placeholder",
  );
  assert.deepEqual(pixel(result.width - 100, 100), [255, 0, 0, 255]);
  await assert.rejects(renderDocument(bytes, "pdf", 4, 1), /range/i);
  await assert.rejects(renderDocument(bytes, "pdf", 1, 5), /1 to 4/);
  await assert.rejects(renderDocument(await pages(101), "pdf"), /100 pages/);
  await assert.rejects(renderDocument(new Uint8Array(10 * 1024 * 1024 + 1), "pdf"), /10 (MB|MiB)/);
  await assert.rejects(renderDocument(new Uint8Array(25 * 1024 * 1024 + 1), "docx"), /25 (MB|MiB)/);
});

test("pre-cancelled rendering does not start a job", async () => {
  await assert.rejects(
    renderDocument(
      await pages(),
      "pdf",
      1,
      1,
      AbortSignal.abort(new Error("Cancelled before start")),
    ),
    /Cancelled before start/,
  );
});

test("real authored DOCX and PPTX produce actual bounded runtime preview images", async () => {
  const model = composeDocument(
    "## Conteúdo\n\nSão Paulo: uma página com conteúdo editável.",
    "Verificação visual",
    { cover: true },
  );
  for (const [format, generate] of [
    ["docx", createDocumentDocx],
    ["pptx", createDocumentPptx],
  ] as const) {
    const result = await renderDocument(await generate(model), format, 1, 2);
    assert.equal(result.pageCount, 2);
    assert.deepEqual(result.pages, [1, 2]);
    assert.ok(result.width * result.height <= 9_000_000);
    const image = await loadImage(result.bytes),
      canvas = createCanvas(image.width, image.height),
      ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(30, 55, image.width - 60, image.height - 80).data;
    let dark = 0;
    for (let index = 0; index < pixels.length; index += 4)
      if (pixels[index] < 150 && pixels[index + 1] < 150 && pixels[index + 2] < 150) dark++;
    assert.ok(dark > 1000, `${format} preview must contain rendered page content`);
  }
});

test("PDF section headings remain on the same page as their following table header and first row", async () => {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const content = `${Array.from({ length: 20 }, () => "Uma observação confirmada preserva o contexto da tarefa.").join("\n\n")}\n\n## Conferência final\n\n| Categoria | Evidência |\n|---|---|\n| Documento | Conteúdo confirmado |`;
  for (const id of ["claude", "ibm", "spotify"]) {
    const profile = await getDesignProfile(id);
    assert.ok(profile);
    const pdf = getDocument({
      data: await createDesignedPdf(
        composeDocument(
          content,
          "Guia",
          {},
          { id, label: profile.label, display: profile.display, ...profile.tokens },
        ),
      ),
      disableFontFace: true,
      verbosity: 0,
    });
    try {
      const document = await pdf.promise;
      assert.ok(document.numPages > 1);
      let found = false;
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
        const page = await document.getPage(pageNumber),
          content = await page.getTextContent();
        const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
        if (text.includes("Conferência final")) {
          found = true;
          assert.ok(
            text.includes("Categoria") && text.includes("Conteúdo confirmado"),
            `${id} section heading cannot be stranded before a page break`,
          );
        }
        page.cleanup();
      }
      assert.equal(found, true);
    } finally {
      await pdf.destroy();
    }
  }
});

test("queued cancellation is prompt and does not let a following renderer overtake the active Office process", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-render-cancel-test-"));
  const oldPath = process.env.PATH;
  const executable = join(directory, "libreoffice"),
    marker = join(directory, "started");
  await writeFile(
    executable,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));\nsetInterval(()=>{},1000);\n`,
    { mode: 0o700 },
  );
  process.env.PATH = `${directory}:${oldPath ?? ""}`;
  const activeController = new AbortController(),
    queuedController = new AbortController();
  const active = renderDocument(new Uint8Array([1]), "docx", 1, 1, activeController.signal);
  const activeRejected = assert.rejects(active, /cancel/i);
  t.after(async () => {
    activeController.abort();
    await activeRejected;
    process.env.PATH = oldPath;
    await rm(directory, { recursive: true, force: true });
  });
  let pid = 0;
  for (let attempt = 0; attempt < 100 && !pid; attempt++) {
    try {
      pid = Number(await readFile(marker, "utf8"));
    } catch {
      await delay(10);
    }
  }
  assert.ok(pid, "Controlled Office process should be running");
  const pdf = await pages();
  const queued = renderDocument(pdf, "pdf", 1, 1, queuedController.signal);
  const cancelled = queued.then(
    () => false,
    () => true,
  );
  queuedController.abort(new Error("Queued rendering cancelled"));
  const promptlyCancelled = await Promise.race([cancelled, delay(150).then(() => false)]);
  assert.equal(
    promptlyCancelled,
    true,
    "A cancelled queued job must reject without waiting for LibreOffice",
  );
  let followingFinished = false;
  const following = renderDocument(pdf, "pdf", 1, 1).then((result) => {
    followingFinished = true;
    return result;
  });
  await delay(40);
  assert.equal(
    followingFinished,
    false,
    "Queue cancellation must preserve serialization of later jobs",
  );
  activeController.abort();
  await activeRejected;
  await following;
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "Cancelled Office process must be terminated");
});
