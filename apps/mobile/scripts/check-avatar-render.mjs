import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// The repository's browser worker already installs Playwright; no browser dependency in the app.
const { chromium } = createRequire(new URL("../../worker/package.json", import.meta.url))(
  "playwright",
);
const compiled = await build({
  stdin: {
    contents:
      'export { avatarNativeDocument } from "../src/avatar/native-document.ts"; export { AVATAR_PRESETS } from "../../../packages/domain/src/avatar.ts";',
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { avatarNativeDocument, AVATAR_PRESETS } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
const outputDir = process.env.OKAMI_AVATAR_ARTIFACT_DIR || "/tmp/okami-avatar-review";
await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.OKAMI_AVATAR_CHROMIUM
    ? { executablePath: process.env.OKAMI_AVATAR_CHROMIUM }
    : {}),
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const tracker = `<script>window.__avatarRaf={calls:0,pending:new Set()};const raf=window.requestAnimationFrame.bind(window),caf=window.cancelAnimationFrame.bind(window);window.requestAnimationFrame=function(fn){let id=raf(function(t){window.__avatarRaf.pending.delete(id);window.__avatarRaf.calls++;fn(t)});window.__avatarRaf.pending.add(id);return id};window.cancelAnimationFrame=function(id){window.__avatarRaf.pending.delete(id);caf(id)}</script>`;
async function setup(design, options = {}) {
  const page = await browser.newPage({
    viewport: { width: 400, height: 460 },
    deviceScaleFactor: 1,
  });
  const external = [];
  const errors = [];
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) external.push(request.url());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const html = avatarNativeDocument({ design, active: true, ...options });
  await page.setContent(html.replace("</head>", `${tracker}</head>`));
  await page.waitForFunction(() => !!window.__OKAMI_AVATAR__);
  return { page, external, errors, html };
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
try {
  for (const preset of AVATAR_PRESETS) {
    const { page, external, errors, html } = await setup(preset);
    await page.clock.runFor(100);
    const first = await page.screenshot({ omitBackground: true });
    await page.clock.runFor(1000);
    const second = await page.screenshot({ omitBackground: true });
    assert.notEqual(
      hash(first),
      hash(second),
      `${preset.species} changes actual rendered pixels while idling`,
    );
    assert.deepEqual(external, [], "The 3D scene makes no network requests");
    assert.deepEqual(errors, []);
    await writeFile(`${outputDir}/${preset.species}.png`, first);
    await writeFile(`${outputDir}/${preset.species}.html`, html);
    await page.close();
  }
  const { page } = await setup(AVATAR_PRESETS[1]);
  await page.clock.runFor(1000);
  await page.evaluate(() => window.__OKAMI_AVATAR__.update({ state: "thinking" }));
  await page.clock.runFor(300);
  const thinkingImage = await page.screenshot({ omitBackground: true });
  await writeFile(`${outputDir}/working.png`, thinkingImage);
  const thinking = hash(thinkingImage);
  await page.evaluate(() => window.__OKAMI_AVATAR__.update({ state: "talking" }));
  await page.clock.runFor(300);
  const respondingImage = await page.screenshot({ omitBackground: true });
  await writeFile(`${outputDir}/responding.png`, respondingImage);
  assert.notEqual(hash(respondingImage), thinking);
  await page.evaluate(() => window.__OKAMI_AVATAR__.update({ framing: "portrait" }));
  await page.clock.runFor(100);
  const portraitImage = await page.screenshot({ omitBackground: true });
  await writeFile(`${outputDir}/portrait.png`, portraitImage);
  assert.notEqual(
    hash(portraitImage),
    hash(respondingImage),
    "Conversation portrait changes the actual camera framing",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.runFor(200);
  const still = hash(await page.screenshot());
  const before = await page.evaluate(() => window.__avatarRaf.calls);
  await page.clock.runFor(2000);
  assert.equal(
    hash(await page.screenshot()),
    still,
    "Reduced motion keeps the same rendered pixels",
  );
  assert.equal(
    await page.evaluate(() => window.__avatarRaf.calls),
    before,
    "Reduced motion stops RAF",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.runFor(200);
  await page.evaluate(() => window.__OKAMI_AVATAR__.update({ active: false }));
  const paused = await page.evaluate(() => window.__avatarRaf.calls);
  await page.clock.runFor(1000);
  assert.equal(
    await page.evaluate(() => window.__avatarRaf.calls),
    paused,
    "Inactive avatar stops RAF",
  );
  await page.evaluate(() => window.__OKAMI_AVATAR__.update({ active: true }));
  await page.clock.runFor(200);
  await page.evaluate(() => window.__OKAMI_AVATAR__.dispose());
  assert.equal(await page.locator("canvas").count(), 0);
  assert.equal(
    await page.evaluate(() => window.__avatarRaf.pending.size),
    0,
    "Disposal cancels all pending RAF callbacks",
  );
  const disposed = await page.evaluate(() => window.__avatarRaf.calls);
  await page.clock.runFor(1000);
  assert.equal(await page.evaluate(() => window.__avatarRaf.calls), disposed);
  await page.close();
  const { page: customPage } = await setup({ ...AVATAR_PRESETS[0], preset: "custom" });
  await customPage.clock.runFor(200);
  await customPage.evaluate(() => window.__OKAMI_AVATAR__.update({ active: false }));
  const old = hash(await customPage.screenshot());
  await customPage.evaluate((design) => window.__OKAMI_AVATAR__.update({ design }), {
    ...AVATAR_PRESETS[3],
    preset: "custom",
    bodyColor: "#67AB9F",
    accessory: "headphones",
    bodyShape: "slender",
  });
  assert.notEqual(
    hash(await customPage.screenshot()),
    old,
    "Custom parameters change the actual local 3D model",
  );
  await customPage.close();
  const gallery = AVATAR_PRESETS.map(
    (preset) =>
      `<article><iframe src="${preset.species}.html" title="${preset.species}"></iframe><p>${preset.species}</p></article>`,
  ).join("");
  await writeFile(
    `${outputDir}/index.html`,
    `<!doctype html><meta charset="utf-8"><title>OkamiBot companions</title><style>body{margin:0;background:#f3f0eb;color:#322d3b;font:16px system-ui}h1{padding:20px 32px 0;font-weight:500}main{display:flex;gap:18px;padding:24px}article{background:#faf8f5;border:1px solid #d9d3cd;border-radius:24px;width:245px}iframe{border:0;width:245px;height:305px}p{text-align:center;text-transform:capitalize;margin:0 0 22px}</style><h1>OkamiBot · local animated 3D companions</h1><main>${gallery}</main>`,
  );
  console.log(
    "Verified 5 real 3D animations, state changes, custom controls, reduced motion, pause, no network access and disposal.",
  );
  console.log(`Rendered previews: ${outputDir}`);
} finally {
  await browser.close();
}
