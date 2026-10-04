import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createBrowserManager } from "../src/browser.ts";
import { publicFixture } from "./public-fixture.ts";

let fixture: Awaited<ReturnType<typeof publicFixture>>;
before(async () => {
  fixture = await publicFixture();
});
after(async () => {
  await fixture?.close();
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
