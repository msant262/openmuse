import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PDFDocument, PDFString, rgb, StandardFonts } from "pdf-lib";

const require = createRequire(import.meta.url);
const mobileRequire = createRequire(resolve("apps/mobile/package.json"));
const workerRequire = createRequire(resolve("apps/worker/package.json"));
const { chromium }: typeof import("../apps/worker/node_modules/playwright/index.js") =
  workerRequire("playwright");

test("web PDF reader shows actual pages without a browser plugin and reuses its download for navigation", {
  timeout: 45_000,
}, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "okami-pdf-reader-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const bundlerUrl = new URL("../apps/mobile/scripts/bundle-pdf-reader.mjs", import.meta.url);
  const { bundlePdfReader } = (await import(bundlerUrl.href)) as {
    bundlePdfReader(options: {
      publicRoot: string;
      manifestPath: null;
    }): Promise<{ prefix: string }>;
  };
  const { PDF_READER_ASSET_ROOT } = await import("../apps/mobile/src/pdf-reader-assets.ts");
  const assets = await bundlePdfReader({
    publicRoot: join(temporary, "_expo/static/pdf-reader"),
    manifestPath: null,
  });
  assert.equal(
    assets.prefix,
    PDF_READER_ASSET_ROOT,
    "the committed manifest must match the built runtime and worker",
  );
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const [index, tint] of [rgb(0.1, 0.2, 0.8), rgb(0.1, 0.7, 0.2)].entries()) {
    const page = pdf.addPage([300, 400]);
    page.drawRectangle({ x: 30, y: 220, width: 240, height: 100, color: tint });
    page.drawText(`Observed page ${index + 1}`, { x: 30, y: 180, font, size: 18 });
    if (index === 0)
      page.node.addAnnot(
        pdf.context.register(
          pdf.context.obj({
            Type: "Annot",
            Subtype: "Link",
            Rect: [30, 175, 250, 200],
            Border: [0, 0, 0],
            A: { Type: "Action", S: "URI", URI: PDFString.of("https://example.org/source") },
          }),
        ),
      );
  }
  const bytes = Buffer.from(await pdf.save());
  const ui = join(temporary, "ui.tsx");
  await writeFile(
    ui,
    `
    import React from 'react';
    export const useUI=()=>({s:{row:{},between:{},small:{},muted:{}},colors:{blueDark:'#345'}});
    export function Button({children,onPress,disabled}){return <button disabled={disabled} onClick={onPress}>{children}</button>}
    export function ErrorNotice({error}){return error?<div role="alert">{error}</div>:null}
  `,
  );
  const i18n = join(temporary, "i18n.ts");
  await writeFile(
    i18n,
    `export const useI18n=()=>({t:(key,values)=>key.replace(/{([^}]+)}/g,(_,n)=>String(values?.[n]??'{'+n+'}'))});`,
  );
  const icons = join(temporary, "icons.ts");
  await writeFile(
    icons,
    "export const ChevronLeft=()=>null,ChevronRight=()=>null,Minus=()=>null,Plus=()=>null;",
  );
  const esbuild: typeof import("esbuild") = createRequire(require.resolve("tsx"))("esbuild");
  const bundle = await esbuild.build({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';
        import PdfReader from './src/PdfReader.web';
        const root=createRoot(document.getElementById('root'));
        window.closeReader=()=>root.unmount();
        window.showPdf=(url)=>root.render(<PdfReader url={url} token="fixture-pdf-token" pageCount={99} height={480}/>);
        window.showPdf('/document.pdf');`,
      resolveDir: resolve("apps/mobile"),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    nodePaths: [resolve("apps/mobile/node_modules"), resolve("node_modules")],
    alias: {
      "react-native": mobileRequire.resolve("react-native-web"),
      "lucide-react-native": icons,
    },
    plugins: [
      {
        name: "presentation-context",
        setup(build) {
          build.onResolve({ filter: /^\.\/(ui|i18n)$/ }, (args) =>
            args.importer.endsWith("PdfReader.web.tsx")
              ? { path: args.path === "./ui" ? ui : i18n }
              : undefined,
          );
        },
      },
    ],
    define: { "process.env.NODE_ENV": '"test"', __DEV__: "false" },
    logLevel: "silent",
  });
  let downloads = 0,
    unauthorized = 0;
  let failPdf = true;
  const server = createServer(async (req, res) => {
    if (req.url === "/document.pdf" || req.url === "/invalid.pdf") {
      downloads++;
      if (req.headers.authorization !== "Bearer fixture-pdf-token") {
        unauthorized++;
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
      const body = req.url === "/invalid.pdf" && failPdf ? Buffer.from("invalid PDF") : bytes;
      res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": body.length });
      res.end(body);
      return;
    }
    if (req.url === "/app.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(bundle.outputFiles[0].text);
      return;
    }
    if (req.url?.startsWith(PDF_READER_ASSET_ROOT) && !req.url.includes("..")) {
      try {
        const file = await readFile(resolve(temporary, req.url.slice(1)));
        res.setHeader("Content-Type", req.url.endsWith(".css") ? "text/css" : "text/javascript");
        res.end(file);
        return;
      } catch {
        res.writeHead(404);
        res.end();
        return;
      }
    }
    res.setHeader("Content-Type", "text/html");
    res.end('<div id="root"></div><script src="/app.js"></script>');
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(
    () =>
      new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 700, height: 700 },
    deviceScaleFactor: 2,
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`);
  const pixels = async () =>
    page.locator("canvas[role=img]").evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext("2d");
      if (!context) return null;
      return {
        width: canvas.width,
        height: canvas.height,
        hash: canvas.toDataURL(),
        marker: Array.from(context.getImageData(canvas.width / 2, canvas.height * 0.3, 1, 1).data),
      };
    });
  await page
    .getByRole("img", { name: "PDF page 1 of 2", exact: true })
    .waitFor({ timeout: 5_000 })
    .catch(async (error) => {
      console.log({
        body: await page.locator("body").innerText(),
        errors,
        downloads,
        unauthorized,
        workers: page.workers().length,
      });
      throw error;
    });
  assert.deepEqual(errors, []);
  const first = await pixels();
  assert.ok(first && first.width > 100 && first.height > 100);
  assert.deepEqual(
    first.marker,
    [26, 51, 204, 255],
    "the PDF's blue rectangle must be visible, not an empty canvas",
  );
  assert.equal(unauthorized, 0, "the browser reader must use its supplied authentication");
  assert.equal(downloads, 1);
  assert.equal(page.workers().length, 1, "PDF decoding must use the local worker");
  assert.equal(
    await page
      .getByRole("link", { name: "Open source: https://example.org/source", exact: true })
      .getAttribute("href"),
    "https://example.org/source",
  );
  assert.match(await page.locator(".okami-pdf-text").innerText(), /Observed page 1/);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("img", { name: "PDF page 2 of 2", exact: true }).waitFor();
  const second = await pixels();
  assert.ok(second && first.hash !== second.hash, "page two must have different rendered pixels");
  assert.ok(
    second.marker[1] > second.marker[2],
    "the second page's green rectangle must be visible",
  );
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await page.getByRole("img", { name: "PDF page 1 of 2", exact: true }).waitFor();
  assert.equal((await pixels())?.hash, first.hash);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction((width) => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas[role=img]");
    return (
      canvas?.parentElement &&
      canvas.width < width &&
      getComputedStyle(canvas.parentElement).visibility === "visible"
    );
  }, first.width);
  const mobile = await pixels();
  assert.ok(
    mobile && mobile.width < 780,
    "fit width must stay within a phone viewport at 2x density",
  );
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.waitForFunction((width) => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas[role=img]");
    return (
      canvas?.parentElement &&
      canvas.width > width &&
      getComputedStyle(canvas.parentElement).visibility === "visible"
    );
  }, mobile.width);
  assert.equal(downloads, 1, "changing page and zoom must not reload the document");
  assert.equal(await page.locator("iframe").count(), 0);
  await page.evaluate(() => {
    (window as unknown as { showPdf: (url: string) => void }).showPdf("/invalid.pdf");
  });
  await page.getByRole("alert").waitFor();
  assert.match(await page.getByRole("alert").innerText(), /Try again.*Open \/ download/);
  assert.deepEqual(
    await page.locator("canvas[role=img]").evaluate((c: HTMLCanvasElement) => [c.width, c.height]),
    [0, 0],
    "a failed document change must release the previous page bitmap",
  );
  failPdf = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.getByRole("img", { name: "PDF page 1 of 2", exact: true }).waitFor();
  assert.equal(downloads, 3, "the invalid document is retried once only after the user's action");
  const canvas = await page.locator("canvas[role=img]").elementHandle();
  assert.ok(canvas);
  await page.evaluate(() => {
    (window as unknown as { closeReader: () => void }).closeReader();
  });
  assert.equal(await page.locator("canvas[role=img]").count(), 0);
  assert.deepEqual(
    await canvas.evaluate((c: HTMLCanvasElement) => [c.width, c.height]),
    [0, 0],
    "closing the reader must release the allocated page bitmap",
  );
  assert.deepEqual(errors, []);
});
