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

test("mounted viewer ignores an older poll after takeover and keeps the grant through capture failure", async (t) => {
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
  const oldPollStarted = new Promise<void>((resolve) => {
    held = resolve;
  });
  const oldPollReleased = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previousImages: (string | undefined)[] = [];
  const effects: string[] = [];
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
      if (path.endsWith("/observe")) {
        const sequence = ++observations;
        previousImages.push(body?.previousImage as string | undefined);
        if (sequence === 2) {
          held();
          await oldPollReleased;
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
  await page.getByLabel("Current masked agent desktop", { exact: true }).waitFor();
  await oldPollStarted;
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  await page.getByRole("button", { name: "Hand back to agent", exact: true }).waitFor();
  release();
  await page.getByLabel("Current masked agent desktop", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Hand back to agent", exact: true }).count(),
    1,
  );
  assert.ok(heartbeats > 0, "the acknowledged grant must be renewed after the old poll finishes");
  assert.equal(previousImages[2], undefined, "takeover requires complete fresh pixels");
  assert.equal(opened, 1);
  assert.equal(takes, 1);

  failCapture = true;
  await page.getByText("Capture temporarily unavailable", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Hand back to agent", exact: true }).count(),
    1,
  );
  assert.equal(await page.getByRole("button", { name: "Enter", exact: true }).isDisabled(), true);
  assert.equal(opened, 1, "a capture failure must not reopen or revoke the viewer");
  failCapture = false;
  await page.getByRole("button", { name: "Refresh frame", exact: true }).click();
  await page.getByLabel("Current masked agent desktop", { exact: true }).waitFor();
  rejectHeartbeat = true;
  await page.getByText("Desktop device or control grant changed", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Hand back to agent", exact: true }).count(),
    0,
  );
  assert.deepEqual(effects, [], "capture recovery cannot dispatch or replay input/handback");
});
