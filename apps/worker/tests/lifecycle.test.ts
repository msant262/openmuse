import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { signBrowserAuthorization } from "../../../packages/domain/src/browser-payment.ts";
import { createBrowserManager } from "../src/browser.ts";
import { BrowserDialogs } from "../src/browser-dialogs.ts";
import { nativeBrowserFailure } from "../src/native-errors.ts";
import { publicFixture } from "./public-fixture.ts";

let fixture: Awaited<ReturnType<typeof publicFixture>>;
before(async () => {
  fixture = await publicFixture();
});
after(async () => {
  await fixture?.close();
});

test("a reviewed click returns its pending confirmation without waiting for a second approval", {
  timeout: 20_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "okami-reviewed-modal-"));
  const token = "fixture-only-browser-token-at-least-32-chars";
  const browser = await createBrowserManager({ dataDir, token });
  try {
    const id = randomUUID();
    await browser.create(id, "https://browser.fixture.test/reviewed-dialog");
    const snap = await browser.snapshot(id);
    const button = snap.elements.find((item) => item.label === "Pay 10 euros");
    assert.ok(button);
    const action = {
      snapshotId: snap.snapshotId,
      element: button.number,
      action: "click" as const,
    };
    const intent = await browser.inspect(id, action);
    const authorization = signBrowserAuthorization(token, {
      sessionId: id,
      id: "c".repeat(64),
      expiresAt: Date.now() + 60_000,
      binding: intent.binding,
    });
    const receipt = await browser.reviewedAct(id, authorization);
    assert.equal(receipt.status, "succeeded");
    assert.equal(receipt.dialog?.message, "Confirm payment of 10 euros?");
    assert.equal(receipt.dialog?.requiresApproval, true);
    assert.equal(receipt.elements.length, 0);
    const denied = await browser.dialog(id, { dialogId: receipt.dialog.id, accept: false });
    assert.match(denied.text, /Payment cancelled/);
    assert.doesNotMatch(denied.text, /Paid once/);
    const replay = await browser.reviewedAct(id, authorization);
    assert.equal(replay.replayed, true);
    assert.match(replay.text, /Payment cancelled/);
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a dialog opening during a page read releases the observation without blocking or dismissing it", {
  timeout: 15_000,
}, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const dialogs = new BrowserDialogs(
      page,
      (text) => text,
      () => {},
    );
    const read = dialogs.observe(() =>
      page.evaluate(
        () =>
          new Promise<string>((resolve) => {
            setTimeout(() => {
              alert("Notice during read");
              resolve("Actual read");
            }, 0);
          }),
      ),
    );
    assert.equal(await read, undefined);
    const pending = dialogs.observation();
    assert.equal(pending?.message, "Notice during read");
    await dialogs.respond({ dialogId: pending!.id, accept: true }, () => {});
    assert.equal(await dialogs.observe(() => page.title()), "");
  } finally {
    await browser.close();
  }
});

test("real browser dialogs remain pending and ordinary prompts resume without repeating the click", {
  timeout: 30_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "okami-browser-dialogs-"));
  const browser = await createBrowserManager({ dataDir });
  try {
    const id = randomUUID();
    await browser.create(id, "https://browser.fixture.test/dialogs");
    const initial = await browser.snapshot(id);
    const button = initial.elements.find((element) => element.label === "Name document");
    assert.ok(button);
    const pending = await browser.act(id, {
      snapshotId: initial.snapshotId,
      element: button.number,
      action: "click",
    });
    assert.equal(pending.dialog?.type, "prompt");
    assert.equal(pending.dialog?.message, "Name this document");
    assert.equal(pending.dialog?.defaultValue, "Untitled");
    assert.equal(
      pending.elements.length,
      0,
      "blocked DOM controls must not be presented as usable",
    );
    const observed = await browser.snapshot(id);
    assert.equal(observed.dialog?.id, pending.dialog.id);
    await assert.rejects(browser.back(id), (error: unknown) => {
      const failure = nativeBrowserFailure(
        { operation: "perform", envelope: { args: { operation: "back", body: {} } } },
        error,
      );
      assert.equal(failure.code, "BROWSER_DIALOG_PENDING");
      assert.equal(
        failure.dispatched,
        false,
        "a pending dialog guard cannot become an uncertain navigation",
      );
      assert.equal(failure.cleanupConfirmed, true);
      return true;
    });
    await assert.rejects(browser.dialog(id, { dialogId: randomUUID(), accept: true }), {
      code: "STALE_DIALOG",
    });
    await browser.setControl(id, "human");
    await assert.rejects(browser.dialog(id, { dialogId: pending.dialog.id, accept: true }), {
      code: "BROWSER_CONTROLLED",
    });
    await browser.setControl(id, "agent");
    const resumed = await browser.dialog(id, {
      dialogId: pending.dialog.id,
      accept: true,
      promptText: "Quarterly report",
    });
    assert.equal(resumed.dialog, undefined);
    assert.match(resumed.text, /Quarterly report/);
    await assert.rejects(browser.dialog(id, { dialogId: pending.dialog.id, accept: true }), {
      code: "STALE_DIALOG",
    });
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("destructive confirmation cannot be accepted through the ordinary browser tool", {
  timeout: 30_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "okami-browser-dialog-review-"));
  const browser = await createBrowserManager({ dataDir });
  try {
    const id = randomUUID();
    await browser.create(id, "https://browser.fixture.test/dialogs");
    const initial = await browser.snapshot(id);
    const button = initial.elements.find((element) => element.label === "Delete document");
    assert.ok(button);
    const pending = await browser.act(id, {
      snapshotId: initial.snapshotId,
      element: button.number,
      action: "click",
    });
    assert.equal(pending.dialog?.requiresApproval, true);
    await assert.rejects(browser.dialog(id, { dialogId: pending.dialog.id, accept: true }), {
      code: "DIALOG_APPROVAL_REQUIRED",
    });
    await assert.rejects(
      browser.dialog(id, { dialogId: pending.dialog.id, accept: true, approved: true }),
      { code: "INVALID_DIALOG" },
    );
    const dismissed = await browser.dialog(id, { dialogId: pending.dialog.id, accept: false });
    assert.match(dismissed.text, /Kept/);
    assert.doesNotMatch(dismissed.text, /Deleted/);
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("navigation and chained alerts return promptly and each response binds the current dialog", {
  timeout: 30_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "okami-browser-chained-dialogs-"));
  const browser = await createBrowserManager({ dataDir });
  try {
    const id = randomUUID();
    await browser.create(id, "https://browser.fixture.test/navigation-dialog");
    const navigation = await browser.snapshot(id);
    assert.equal(navigation.dialog?.message, "Notice during navigation");
    const loaded = await browser.dialog(id, { dialogId: navigation.dialog.id, accept: true });
    assert.match(loaded.text, /Loaded after notice/);
    await browser.navigate(id, "https://browser.fixture.test/dialogs");
    const initial = await browser.snapshot(id);
    const button = initial.elements.find((element) => element.label === "Two notices");
    assert.ok(button);
    const first = await browser.act(id, {
      snapshotId: initial.snapshotId,
      element: button.number,
      action: "click",
    });
    assert.equal(first.dialog?.message, "First notice");
    const second = await browser.dialog(id, { dialogId: first.dialog.id, accept: true });
    assert.equal(second.dialog?.message, "Second notice");
    assert.notEqual(first.dialog.id, second.dialog.id);
    const finished = await browser.dialog(id, { dialogId: second.dialog.id, accept: true });
    assert.match(finished.text, /Both notices acknowledged/);
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("trusted reviewed dialog dispatch changes the actual page once and pending dialogs close cleanly", {
  timeout: 30_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "okami-browser-reviewed-dialog-"));
  const browser = await createBrowserManager({ dataDir });
  try {
    const id = randomUUID();
    await browser.create(id, "https://browser.fixture.test/dialogs");
    const initial = await browser.snapshot(id);
    const button = initial.elements.find((element) => element.label === "Delete document");
    assert.ok(button);
    const pending = await browser.act(id, {
      snapshotId: initial.snapshotId,
      element: button.number,
      action: "click",
    });
    const reviewed = { dialogId: pending.dialog!.id, accept: true, approvalId: "a".repeat(64) };
    const result = await browser.dialog(id, reviewed, true);
    assert.match(result.text, /Deleted/);
    assert.equal(result.response.dialogId, reviewed.dialogId);
    await assert.rejects(browser.dialog(id, reviewed, true), { code: "STALE_DIALOG" });
    const prompt = result.elements.find((element) => element.label === "Name document");
    assert.ok(prompt);
    const blocking = await browser.act(id, {
      snapshotId: result.snapshotId,
      element: prompt.number,
      action: "click",
    });
    assert.ok(blocking.dialog);
    await browser.closeSession(id);
    await browser.create(id, "https://browser.fixture.test/dialogs");
    assert.equal(
      (await browser.snapshot(id)).dialog,
      undefined,
      "closed renderer dialogs cannot survive a new browser lifecycle",
    );
    await assert.rejects(browser.dialog(id, reviewed, true), { code: "STALE_DIALOG" });
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a dialog may wait longer than the click timeout without losing the observed action", {
  timeout: 30_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "okami-browser-dialog-wait-"));
  const browser = await createBrowserManager({ dataDir });
  try {
    const id = randomUUID();
    await browser.create(id, "https://browser.fixture.test/dialogs");
    const initial = await browser.snapshot(id);
    const button = initial.elements.find((element) => element.label === "Name document");
    assert.ok(button);
    const pending = await browser.act(id, {
      snapshotId: initial.snapshotId,
      element: button.number,
      action: "click",
    });
    assert.ok(pending.dialog);
    await new Promise((resolve) => setTimeout(resolve, 11_000));
    assert.equal((await browser.snapshot(id)).dialog?.id, pending.dialog.id);
    const result = await browser.dialog(id, {
      dialogId: pending.dialog.id,
      accept: true,
      promptText: "Still available",
    });
    assert.match(result.text, /Still available/);
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("browser images are observed from the actual page, paginated and omit protected credential regions", {
  timeout: 30_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "okami-browser-images-"));
  const browser = await createBrowserManager({ dataDir });
  try {
    const id = randomUUID();
    await browser.create(id, "https://browser.fixture.test/images");
    const first = await browser.images(id, { limit: 2 });
    assert.equal(first.sessionId, id);
    assert.equal(first.url, "https://browser.fixture.test/images");
    assert.equal(first.total, 3);
    assert.equal(first.nextOffset, 2);
    assert.deepEqual(
      first.images.map((image) => image.alt),
      ["Course cover", "Second cover"],
    );
    assert.equal(first.images[0].src, "https://browser.fixture.test/picture.svg");
    const last = await browser.images(id, { offset: first.nextOffset, limit: 2 });
    assert.deepEqual(
      last.images.map((image) => image.alt),
      ["Last cover"],
    );
    assert.equal(last.nextOffset, null);
    assert.equal(JSON.stringify([first, last]).includes("private"), false);
    assert.equal(JSON.stringify([first, last]).includes("data:image"), false);
    await assert.rejects(browser.images(id, { expression: "fetch('/delete')" }), {
      code: "INVALID_IMAGES",
    });
    await browser.closeSession(id);
    await assert.rejects(browser.images(id), { code: "SESSION_CLOSED" });
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("browser back traverses real history with fresh controls and respects human takeover", {
  timeout: 30_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "okami-browser-history-"));
  const browser = await createBrowserManager({ dataDir });
  try {
    const id = randomUUID();
    await browser.create(id, "https://browser.fixture.test/");
    await browser.navigate(id, "https://browser.fixture.test/json-results");
    const before = await browser.snapshot(id);
    await browser.setControl(id, "human");
    await assert.rejects(browser.back(id), { code: "BROWSER_CONTROLLED" });
    assert.equal((await browser.control(id)).url, before.url);
    await browser.setControl(id, "agent");
    const previous = await browser.back(id);
    assert.equal(previous.url, "https://browser.fixture.test/");
    assert.equal(previous.historyMoved, true);
    assert.match(previous.text, /Local fixture content/);
    assert.notEqual(previous.snapshotId, before.snapshotId);
    const download = previous.elements.find((element) => element.label === "Download");
    assert.ok(download);
    await assert.rejects(
      browser.act(id, {
        snapshotId: before.snapshotId,
        element: download.number,
        action: "click",
      }),
      { code: "STALE_SNAPSHOT" },
    );
    await browser.closeSession(id);
    await assert.rejects(browser.back(id), { code: "SESSION_CLOSED" });
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("browser back observes same-document history and reports an exhausted history", {
  timeout: 30_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "okami-browser-spa-history-"));
  const browser = await createBrowserManager({ dataDir });
  try {
    const id = randomUUID();
    await browser.create(id, "https://browser.fixture.test/history");
    const initial = await browser.snapshot(id);
    const next = initial.elements.find((element) => element.label === "Next section");
    assert.ok(next);
    const second = await browser.act(id, {
      snapshotId: initial.snapshotId,
      element: next.number,
      action: "click",
    });
    assert.equal(second.url, "https://browser.fixture.test/history#second");
    const previous = await browser.back(id);
    assert.equal(previous.url, initial.url);
    assert.equal(previous.historyMoved, true, "SPA history has no HTTP response but still moves");
    await browser.back(id);
    const exhausted = await browser.back(id);
    assert.equal(exhausted.historyMoved, false);
    assert.equal(exhausted.url, "about:blank");
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("headless reading follows pending data requests and exposes their actual API URL", {
  timeout: 20_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "okami-data-request-"));
  const browser = await createBrowserManager({ dataDir });
  try {
    const id = randomUUID();
    await browser.create(id, "https://browser.fixture.test/json-results");
    const page = await browser.read(id);
    assert.match(page.text, /Votes: 12345/);
    assert.ok(
      page.dataSources.some((source) => source.url === "https://browser.fixture.test/count.json"),
    );
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("public read waits for delayed application data instead of reporting its loading shell", {
  timeout: 20_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "okami-delayed-results-"));
  const browser = await createBrowserManager({ dataDir });
  try {
    const id = randomUUID();
    await browser.create(id, "https://browser.fixture.test/delayed-results");
    const page = await browser.read(id);
    assert.match(page.text, /Candidate A: 52% of 12345 votes/);
    assert.doesNotMatch(page.text, /Location 0/);
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("real HTTP and HTTPS CONNECT carry downloads that survive browser restart", {
  timeout: 30_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "okami-browser-wire-download-"));
  let browser = await createBrowserManager({ dataDir });
  const id = randomUUID();
  const start = fixture.requests.length;
  try {
    await browser.create(id, "http://browser.fixture.test/");
    assert.match((await browser.read(id)).text, /Local fixture content/);
    await browser.navigate(id, "https://browser.fixture.test/");
    const snapshot = await browser.snapshot(id);
    const downloadLink = snapshot.elements.find((element) => element.label === "Download");
    assert.ok(downloadLink);
    await browser.act(id, {
      snapshotId: snapshot.snapshotId,
      element: downloadLink.number,
      action: "click",
    });
    // Closing waits for actual Playwright transfer publication; the restarted
    // manager must serve the original bytes and stable download ID.
    await browser.close();
    browser = await createBrowserManager({ dataDir });
    const result = await browser.downloads(id);
    assert.equal(result.downloads.length, 1);
    assert.deepEqual(result.failures, []);
    const item = await browser.download(id, result.downloads[0].id);
    assert.equal(item.bytes.toString(), "%PDF-1.4\nfixture download\n%%EOF\n");
    assert.equal(item.metadata.name, "fixture.pdf");
    const requests = fixture.requests.slice(start);
    assert.ok(requests.some((request) => request.path === "/" && !request.secure));
    assert.ok(requests.some((request) => request.path === "/download.pdf" && request.secure));
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("real Chromium cleans failed profiles and restores a saved UUID after worker restart", {
  timeout: 90_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-browser-lifecycle-"));
  let browser = await createBrowserManager({ dataDir });
  const id = randomUUID();
  const failedId = randomUUID();
  try {
    await assert.rejects(
      browser.create(failedId, "https://browser.fixture.test/redirect-private"),
      { code: "NAVIGATION_FAILED" },
    );
    assert.equal(browser.list().length, 0, "failed creation must release its saved-profile slot");
    assert.equal(
      (await readdir(dataDir)).includes(failedId),
      false,
      "unclaimed profile is removed",
    );
    await browser.create(id, "https://browser.fixture.test/");
    await browser.closeSession(id);
    const context = await chromium.launchPersistentContext(join(dataDir, id, "profile"), {
      headless: true,
      proxy: { server: fixture.proxyUrl, bypass: "<-loopback>" },
    });
    try {
      const page = await context.newPage();
      await page.goto("https://browser.fixture.test/");
      await page.evaluate(() => localStorage.setItem("openmuse-profile-test", "retained"));
    } finally {
      await context.close();
    }
    await browser.close();
    browser = await createBrowserManager({ dataDir });
    assert.equal(browser.list()[0]?.status, "closed");
    const reopened = await browser.create(id, "https://browser.fixture.test/");
    assert.equal(reopened.id, id);
    assert.equal(reopened.title, "Browser fixture");
    const read = await browser.read(id);
    assert.match(read.text, /Local fixture content/);
    await browser.navigate(id, "https://browser.fixture.test/large.txt");
    const largeRead = await browser.read(id);
    assert.equal(largeRead.text.length, 100_000);
    assert.equal(largeRead.truncated, true);
    assert.equal(largeRead.url, "https://browser.fixture.test/large.txt");
    await browser.closeSession(id);
    const state = JSON.parse(await readFile(join(dataDir, id, "storage.json"), "utf8"));
    assert(
      state.origins
        .find((origin: { origin: string }) => origin.origin === "https://browser.fixture.test")
        ?.localStorage.some(
          (item: { name: string; value: string }) =>
            item.name === "openmuse-profile-test" && item.value === "retained",
        ),
    );
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("real manager persists human takeover and preempts queued agent mutations until handback", {
  timeout: 60_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-browser-control-"));
  let browser = await createBrowserManager({ dataDir });
  const id = randomUUID();
  try {
    await browser.create(id, "https://browser.fixture.test/");
    const snapshot = await browser.snapshot(id);
    const link = snapshot.elements.find((item) => item.tag === "a");
    assert.ok(link);
    // All calls are issued without awaiting: takeover closes the gate ahead of queued work.
    const watching = browser.screenshot(id);
    const pending = browser.act(id, {
      snapshotId: snapshot.snapshotId,
      element: link.number,
      action: "click",
    });
    const rejected = assert.rejects(pending, { code: "BROWSER_CONTROLLED" });
    await browser.setControl(id, "human");
    await rejected;
    await watching;
    assert.equal((await browser.control(id)).control, "human");
    await assert.rejects(browser.navigate(id, "https://browser.fixture.test/"), {
      code: "BROWSER_CONTROLLED",
    });
    await browser.input(id, { type: "scroll", deltaY: 100 });
    await browser.close();
    browser = await createBrowserManager({ dataDir });
    assert.equal((await browser.control(id)).control, "human");
    await assert.rejects(browser.create(id, "https://browser.fixture.test/"), {
      code: "BROWSER_CONTROLLED",
    });
    await browser.create(id, "https://browser.fixture.test/", false);
    const restored = await browser.snapshot(id);
    assert.equal(restored.control, "human");
    await browser.setControl(id, "agent");
    await assert.rejects(
      browser.act(id, {
        snapshotId: restored.snapshotId,
        element: restored.elements[0].number,
        action: "click",
      }),
      { code: "STALE_SNAPSHOT" },
    );
    const fresh = await browser.snapshot(id);
    assert.equal(fresh.control, "agent");
    assert.ok((await browser.agentScreenshot(id)).image.length > 0);
    await assert.rejects(browser.input(id, { type: "key", key: "Enter" }), {
      code: "CONTROL_REQUIRED",
    });
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

// A test-only preload stages/observes real website state without weakening worker SSRF.
async function processFixture(dataDir: string, stage: boolean) {
  const preload = join(dataDir, stage ? "stage.mjs" : "observe.mjs");
  await writeFile(
    preload,
    `
    import { installFixtureTransport } from ${JSON.stringify(new URL("./public-fixture.ts", import.meta.url).href)};
    installFixtureTransport(${JSON.stringify(fixture.transport)});
    import { chromium } from ${JSON.stringify(import.meta.resolve("playwright"))};
    const launch = chromium.launchPersistentContext.bind(chromium);
    chromium.launchPersistentContext = async (...args) => {
      const context = await launch(...args);
      await context.addInitScript(() => {
        if (location.origin !== "https://browser.fixture.test") return;
        ${
          stage
            ? `localStorage.setItem("openmuse-shutdown-test", "fresh");
        document.cookie = "openmuse_shutdown_cookie=fresh;Max-Age=86400;SameSite=Lax;Secure";`
            : `
        addEventListener("DOMContentLoaded", () => {
          document.body.textContent = JSON.stringify({
            value: localStorage.getItem("openmuse-shutdown-test"), cookie: document.cookie,
          });
        });`
        }
      });
      return context;
    };
  `,
  );
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--import",
      preload,
      fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: "C.UTF-8",
        ...(process.env.PLAYWRIGHT_BROWSERS_PATH
          ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }
          : {}),
        WORKER_TOKEN: "isolated-shutdown-test-token-with-no-personal-keys",
        WORKER_HOST: "127.0.0.1",
        WORKER_DATA_DIR: join(dataDir, "profiles"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  async function api(path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:8790${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer isolated-shutdown-test-token-with-no-personal-keys",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    assert.ok(response.ok, `${response.status} ${await response.clone().text()}`);
    return response.json();
  }
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      await api("/sessions");
      break;
    } catch (error) {
      if (child.exitCode !== null || Date.now() > deadline) {
        child.kill("SIGKILL");
        throw new Error(`Worker startup failed: ${output}`, { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return { child, api, output: () => output, exited };
}
async function terminate(child: ChildProcess, exited: Promise<number | null>) {
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 35_000);
  try {
    return await exited;
  } finally {
    clearTimeout(timeout);
  }
}

test("active worker SIGTERM flushes real cookies/localStorage and human mode before clean exit", {
  timeout: 90_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-browser-signal-"));
  let worker: Awaited<ReturnType<typeof processFixture>> | undefined;
  const id = randomUUID();
  try {
    worker = await processFixture(dataDir, true);
    await worker.api("/sessions/human", { id, url: "https://browser.fixture.test/" });
    const directory = join(dataDir, "profiles", id);
    assert.equal(
      JSON.parse(await readFile(join(directory, "session.json"), "utf8")).status,
      "active",
    );
    assert.equal(await terminate(worker.child, worker.exited), 0, worker.output());
    const saved = JSON.parse(await readFile(join(directory, "session.json"), "utf8"));
    assert.equal(saved.status, "closed", "SIGTERM itself must persist closed metadata");
    assert.equal(saved.control, "human");
    const state = JSON.parse(await readFile(join(directory, "storage.json"), "utf8"));
    assert.ok(
      state.cookies.some(
        (cookie: { name: string; value: string }) =>
          cookie.name === "openmuse_shutdown_cookie" && cookie.value === "fresh",
      ),
    );
    assert.ok(
      state.origins.some((origin: { localStorage: { name: string; value: string }[] }) =>
        origin.localStorage.some(
          (item) => item.name === "openmuse-shutdown-test" && item.value === "fresh",
        ),
      ),
    );
    worker = await processFixture(dataDir, false);
    const restored = await worker.api("/sessions");
    assert.equal(restored[0].control, "human");
    assert.equal(restored[0].status, "closed");
    await worker.api("/sessions/human", { id, url: "https://browser.fixture.test/" });
    const observed = JSON.parse((await worker.api(`/sessions/${id}/read`)).text);
    assert.equal(observed.value, "fresh");
    assert.match(observed.cookie, /openmuse_shutdown_cookie=fresh/);
    assert.equal((await worker.api(`/sessions/${id}/control`)).control, "human");
    assert.equal(await terminate(worker.child, worker.exited), 0, worker.output());
  } finally {
    if (worker && worker.child.exitCode === null) {
      worker.child.kill("SIGKILL");
      await worker.exited;
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("profile flush failure makes SIGTERM nonzero and cannot report a closed session", {
  timeout: 60_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-browser-signal-failure-"));
  let worker: Awaited<ReturnType<typeof processFixture>> | undefined;
  const id = randomUUID();
  try {
    worker = await processFixture(dataDir, true);
    await worker.api("/sessions/human", { id, url: "https://browser.fixture.test/" });
    const directory = join(dataDir, "profiles", id);
    // A real filesystem failure at the state publication boundary, not a mocked close.
    await mkdir(join(directory, "storage.json"));
    assert.notEqual(await terminate(worker.child, worker.exited), 0, worker.output());
    assert.equal(
      JSON.parse(await readFile(join(directory, "session.json"), "utf8")).status,
      "error",
    );
    assert.match(worker.output(), /shutdown failed/i);
  } finally {
    if (worker && worker.child.exitCode === null) {
      worker.child.kill("SIGKILL");
      await worker.exited;
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("worker shutdown deadline rejects a hung flush rather than reporting success", {
  timeout: 5000,
}, async () => {
  const shutdown = new URL("../src/shutdown.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `import { installShutdownHandlers } from ${JSON.stringify(shutdown)};
     installShutdownHandlers(() => new Promise(() => {}), 100);
     setInterval(() => {}, 1000);
     console.log("ready");`,
    ],
    {
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const cleanup = setTimeout(() => child.kill("SIGKILL"), 4000);
  try {
    await Promise.race([
      new Promise<void>((resolve) => child.stdout.once("data", () => resolve())),
      exited.then(() => {
        throw new Error(`Shutdown fixture exited before readiness: ${output}`);
      }),
    ]);
    child.kill("SIGTERM");
    assert.equal(await exited, 1);
    assert.match(output, /shutdown timed out/i);
  } finally {
    clearTimeout(cleanup);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  }
});

test("shutdown retains an earlier reported profile flush failure", {
  timeout: 60_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-browser-prior-flush-failure-"));
  let worker: Awaited<ReturnType<typeof processFixture>> | undefined;
  const id = randomUUID();
  try {
    worker = await processFixture(dataDir, true);
    await worker.api("/sessions/human", { id, url: "https://browser.fixture.test/" });
    await mkdir(join(dataDir, "profiles", id, "storage.json"));
    await assert.rejects(worker.api(`/sessions/${id}/close`, {}), /SESSION_CLOSE_FAILED/);
    await assert.rejects(worker.api(`/sessions/${id}/close`, {}), /SESSION_CLOSE_FAILED/);
    assert.notEqual(await terminate(worker.child, worker.exited), 0, worker.output());
    assert.match(worker.output(), /shutdown failed/i);
  } finally {
    if (worker && worker.child.exitCode === null) {
      worker.child.kill("SIGKILL");
      await worker.exited;
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
