import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const workerRequire = createRequire(resolve("apps/worker/package.json"));
const mobileRequire = createRequire(resolve("apps/mobile/package.json"));
const { chromium }: typeof import("../apps/worker/node_modules/playwright/index.js") =
  workerRequire("playwright");

test("mounted viewer preserves pixels without permitting stale input across takeover and capture recovery", {
  timeout: 45_000,
}, async (t) => {
  if (!existsSync(chromium.executablePath())) {
    t.skip("Install the workspace's pinned Playwright Chromium to run the component regression");
    return;
  }
  const temporary = await mkdtemp(join(tmpdir(), "okami-desktop-viewer-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const crypto = join(temporary, "crypto.mjs");
  await writeFile(
    crypto,
    "let n=0;export const randomUUID=()=> '00000000-0000-4000-8000-'+(++n).toString(16).padStart(12,'0');",
  );
  const icons = join(temporary, "icons.mjs");
  await writeFile(
    icons,
    "export const ArrowUpRight=()=>null,Check=()=>null,ChevronRight=()=>null,X=()=>null;",
  );
  const esbuild = createRequire(require.resolve("tsx"))("esbuild");
  const bundle = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {DesktopViewer} from './src/desktop';
        import {WorkspaceContext} from './src/workspace';
        import {ApiError} from './src/api-errors';
        const api={request:async(path,body)=>{
          const result=await window.desktopRequest(path,body);
          if(result.error)throw new ApiError(result.error,result.status,result.code);
          return result.value;
        }};
        createRoot(document.getElementById('root')).render(
          <WorkspaceContext.Provider value={{api,refresh:async()=>{}}}>
            <DesktopViewer/>
          </WorkspaceContext.Provider>
        );`,
      resolveDir: resolve("apps/mobile"),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: { ".png": "dataurl" },
    resolveExtensions: [".web.tsx", ".web.ts", ".web.js", ".tsx", ".ts", ".jsx", ".js"],
    alias: {
      "react-native": mobileRequire.resolve("react-native-web"),
      "expo-crypto": crypto,
      "lucide-react-native": icons,
    },
    define: { "process.env.NODE_ENV": '"test"', __DEV__: "false" },
    logLevel: "silent",
  });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const session = {
    id: randomUUID(),
    browserSessionId: randomUUID(),
    sessionGeneration: randomUUID(),
    profileId: "test",
    width: 1280,
    height: 720,
  };
  const viewerId = randomUUID(),
    grantId = randomUUID(),
    imageHash = "a".repeat(64);
  const image =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI3UAAAAASUVORK5CYII=";
  let control = "agent",
    revision = 0,
    opened = 0,
    heartbeats = 0,
    takes = 0,
    observations = 0;
  let failCapture = false,
    rejectHeartbeat = false;
  let held!: () => void, release!: () => void;
  let freshStarted!: () => void, releaseFresh!: () => void;
  let inputStarted!: () => void, releaseInputFrame!: () => void;
  let generationStarted!: () => void, releaseGeneration!: () => void;
  const oldPollStarted = new Promise<void>((resolve) => {
    held = resolve;
  });
  const oldPollReleased = new Promise<void>((resolve) => {
    release = resolve;
  });
  const freshPollStarted = new Promise<void>((resolve) => {
    freshStarted = resolve;
  });
  const freshPollReleased = new Promise<void>((resolve) => {
    releaseFresh = resolve;
  });
  const inputPollStarted = new Promise<void>((resolve) => {
    inputStarted = resolve;
  });
  const inputPollReleased = new Promise<void>((resolve) => {
    releaseInputFrame = resolve;
  });
  const generationPollStarted = new Promise<void>((resolve) => {
    generationStarted = resolve;
  });
  const generationPollReleased = new Promise<void>((resolve) => {
    releaseGeneration = resolve;
  });
  t.after(() => {
    release();
    releaseFresh();
    releaseInputFrame();
    releaseGeneration();
  });
  const previousImages: (string | undefined)[] = [];
  const inputs: Record<string, unknown>[] = [];
  const effects: string[] = [];
  let inputPollHeld = false;
  let generationChanged = false;
  await page.exposeFunction(
    "desktopRequest",
    async (path: string, body?: Record<string, unknown>) => {
      if (path === "/api/desktop")
        return { value: { ...session, enabled: true, control, revision, runtimePaused: false } };
      if (path === "/api/desktop/viewers") {
        opened++;
        return { value: { viewerId, session } };
      }
      if (path.endsWith("/take-control")) {
        takes++;
        control = "human";
        revision++;
        return { value: { control, revision, grantId, expiresAt: Date.now() + 30_000 } };
      }
      if (path.endsWith("/heartbeat")) {
        heartbeats++;
        if (rejectHeartbeat)
          return { error: "Desktop device or control grant changed", status: 403 };
        assert.equal(body?.grantId, grantId);
        return { value: { control, revision, grantId, expiresAt: Date.now() + 30_000 } };
      }
      if (path.endsWith("/input")) {
        assert.equal(body?.grantId, grantId);
        inputs.push(body?.input as Record<string, unknown>);
        return { value: { control, revision } };
      }
      if (path.endsWith("/observe")) {
        const sequence = ++observations;
        previousImages.push(body?.previousImage as string | undefined);
        if (sequence === 2) {
          held();
          await oldPollReleased;
        }
        if (sequence === 3) {
          freshStarted();
          await freshPollReleased;
        }
        if (inputs.length && !inputPollHeld) {
          inputPollHeld = true;
          inputStarted();
          await inputPollReleased;
        }
        if (generationChanged) {
          generationStarted();
          await generationPollReleased;
        }
        if (failCapture) return { error: "Capture temporarily unavailable", status: 503 };
        const unchanged = body?.previousImage === imageHash;
        return {
          value: {
            sessionGeneration: session.sessionGeneration,
            frameId: randomUUID(),
            sequence,
            observedAt: new Date().toISOString(),
            width: 1280,
            height: 720,
            imageHash,
            imageUnchanged: unchanged,
            ...(unchanged ? {} : { mimeType: "image/png", image }),
          },
        };
      }
      if (path.endsWith("/close")) return { value: { closed: true } };
      effects.push(path);
      return { error: "Unexpected input in observation regression", status: 409 };
    },
  );
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const desktopImage = page.getByLabel("Current masked agent desktop", { exact: true });
  const enter = page.getByRole("button", { name: "Enter", exact: true });
  const readyInput = () =>
    enter.and(page.locator(':not([aria-disabled="true"]):not([disabled])')).waitFor();
  const visibleImage = async () => {
    assert.equal(await desktopImage.isVisible(), true);
    assert.equal(
      await page.getByText("Waiting for a fresh desktop frame…", { exact: true }).count(),
      0,
    );
  };
  await desktopImage.waitFor();
  await page.waitForFunction(() => {
    const image = document.querySelector("img");
    return image?.complete && image.naturalWidth > 0;
  });
  const originalImage = await desktopImage.elementHandle();
  await page.evaluate(
    "window.desktopImageLoads=0;document.querySelector('img').addEventListener('load',()=>window.desktopImageLoads++)",
  );
  await oldPollStarted;
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  await page.getByRole("button", { name: "Hand back to agent", exact: true }).waitFor();
  await visibleImage();
  assert.equal(await enter.isDisabled(), true);
  release();
  await freshPollStarted;
  await visibleImage();
  assert.equal(await enter.isDisabled(), true);
  assert.equal(inputs.length, 0);
  releaseFresh();
  await readyInput();
  assert.equal(
    await page.getByRole("button", { name: "Hand back to agent", exact: true }).count(),
    1,
  );
  assert.ok(heartbeats > 0, "the acknowledged grant must be renewed after the old poll finishes");
  assert.equal(previousImages[2], undefined, "takeover requires complete fresh pixels");
  assert.equal(opened, 1);
  assert.equal(takes, 1);
  assert.equal(
    await page.evaluate("window.desktopImageLoads"),
    0,
    "same pixels must regain input without another onLoad",
  );

  await desktopImage.click({ position: { x: 25, y: 25 } });
  await inputPollStarted;
  await visibleImage();
  assert.equal(
    await originalImage?.evaluate((image) => image.isConnected),
    true,
    "input cannot replace the displayed image node",
  );
  assert.equal(await enter.isDisabled(), true);
  await desktopImage.click({ position: { x: 30, y: 30 }, force: true });
  assert.equal(
    inputs.length,
    1,
    "no second input may use the old frame while fresh observation is pending",
  );
  assert.equal((inputs[0].action as { action: string }).action, "click");
  releaseInputFrame();
  await readyInput();
  assert.equal(await page.evaluate("window.desktopImageLoads"), 0);

  failCapture = true;
  await page.getByText("Capture temporarily unavailable", { exact: true }).waitFor();
  await visibleImage();
  assert.equal(
    await page.getByRole("button", { name: "Hand back to agent", exact: true }).count(),
    1,
  );
  assert.equal(await page.getByRole("button", { name: "Enter", exact: true }).isDisabled(), true);
  assert.equal(opened, 1, "a capture failure must not reopen or revoke the viewer");
  failCapture = false;
  await page.getByRole("button", { name: "Refresh frame", exact: true }).click();
  await visibleImage();
  await readyInput();

  generationChanged = true;
  session.sessionGeneration = randomUUID();
  await page.getByRole("button", { name: "Refresh frame", exact: true }).click();
  await generationPollStarted;
  assert.equal(
    await desktopImage.count(),
    0,
    "a changed session generation must drop the old pixels",
  );
  assert.equal(
    await page.getByRole("button", { name: "Hand back to agent", exact: true }).count(),
    0,
  );
  releaseGeneration();
  await desktopImage.waitFor();
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  await readyInput();
  rejectHeartbeat = true;
  await page.getByText("Desktop device or control grant changed", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Hand back to agent", exact: true }).count(),
    0,
  );
  assert.equal(await desktopImage.count(), 0, "authorization changes must drop the old pixels");
  assert.equal(inputs.length, 1);
  assert.deepEqual(effects, [], "capture recovery cannot dispatch or replay input/handback");
});
