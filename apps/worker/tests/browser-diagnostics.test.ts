import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import type { Page } from "playwright";
import { createBrowserManager } from "../src/browser.ts";
import { BrowserDiagnostics } from "../src/browser-diagnostics.ts";
import { publicFixture } from "./public-fixture.ts";

let fixture: Awaited<ReturnType<typeof publicFixture>>;
before(async () => {
  fixture = await publicFixture();
});
after(async () => {
  await fixture?.close();
});

test("console reads actual Chromium logs and exceptions with pagination and session isolation", {
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "okami-diagnostics-"));
  const browser = await createBrowserManager({ dataDir: directory });
  try {
    const id = randomUUID(),
      other = randomUUID();
    await browser.create(id, "https://browser.fixture.test/diagnostics");
    await browser.create(other, "https://browser.fixture.test/");
    const first = await browser.console(id, { limit: 1 });
    assert.equal(first.sessionId, id);
    assert.equal(first.entries[0].text, "fixture log");
    assert.ok(first.nextAfter !== null);
    const rest = await browser.console(id, { after: first.nextAfter });
    assert.ok(
      rest.entries.some((entry) => entry.level === "warning" && entry.text === "fixture warning"),
    );
    assert.ok(
      rest.entries.some(
        (entry) => entry.source === "exception" && entry.text.includes("fixture exception"),
      ),
    );
    assert.equal(JSON.stringify(await browser.console(other)).includes("fixture log"), false);
    await browser.console(id, { clear: true });
    assert.equal((await browser.console(id)).entries.length, 0);
    await assert.rejects(browser.console(id, { expression: "fetch('/delete')" }), {
      code: "INVALID_BROWSER_DIAGNOSTICS",
    });
    await browser.closeSession(id);
    await assert.rejects(browser.console(id), { code: "SESSION_CLOSED" });
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CDP observes the actual owned page and blocks unsafe commands, protected fields and human control", {
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "okami-cdp-"));
  const browser = await createBrowserManager({ dataDir: directory });
  try {
    const id = randomUUID();
    await browser.create(id, "https://browser.fixture.test/diagnostics");
    const version = await browser.cdp(id, { method: "Browser.getVersion" });
    assert.match(String(version.result.product), /Chrome/);
    const document = await browser.cdp(id, { method: "DOM.getDocument", params: { depth: 1 } });
    const root = document.result.root as { nodeId: number };
    const node = await browser.cdp(id, {
      method: "DOM.querySelector",
      params: { nodeId: root.nodeId, selector: "#answer" },
    });
    const html = await browser.cdp(id, {
      method: "DOM.getOuterHTML",
      params: { nodeId: node.result.nodeId },
    });
    assert.match(String(html.result.outerHTML), /Actual Chromium content/);
    for (const method of [
      "Page.navigate",
      "Runtime.evaluate",
      "Network.getAllCookies",
      "DOM.setFileInputFiles",
      "Target.createTarget",
    ]) {
      await assert.rejects(browser.cdp(id, { method, params: {} }), {
        code: "INVALID_BROWSER_DIAGNOSTICS",
      });
    }
    await browser.setControl(id, "human");
    await assert.rejects(browser.cdp(id, { method: "DOM.getDocument" }), {
      code: "BROWSER_CONTROLLED",
    });
    await browser.setControl(id, "agent");
    await browser.navigate(id, "https://browser.fixture.test/protected-diagnostics");
    await assert.rejects(browser.cdp(id, { method: "DOM.getDocument" }), {
      code: "SENSITIVE_PROGRAMMATIC_OBSERVATION",
    });
    await assert.rejects(browser.console(id), { code: "SENSITIVE_PROGRAMMATIC_OBSERVATION" });
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("noisy pages have a bounded console buffer with explicit dropped and truncated evidence", {
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "okami-noisy-console-"));
  const browser = await createBrowserManager({ dataDir: directory });
  try {
    const id = randomUUID();
    await browser.create(id, "https://browser.fixture.test/diagnostics-flood");
    let after = 0,
      count = 0,
      truncated = false;
    do {
      const result = await browser.console(id, { after, limit: 100 });
      assert.equal(result.dropped, 6);
      count += result.entries.length;
      truncated ||= result.entries.some((entry) => entry.truncated && entry.text.length === 8192);
      if (result.nextAfter === null) break;
      assert.ok(result.nextAfter > after);
      after = result.nextAfter;
    } while (count <= 1000);
    assert.equal(count, 1000);
    assert.equal(truncated, true);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("console secrets are masked both before capture and when a credential is registered later", () => {
  const page = new EventEmitter();
  const diagnostics = new BrowserDiagnostics(page as unknown as Page);
  const input = { after: 0, limit: 50, clear: false };
  page.emit("console", { type: () => "log", text: () => "password=private-before-token" });
  diagnostics.protectSecrets(["private-before-token", "private-after-token"]);
  page.emit("pageerror", new Error("login failed for private-after-token"));
  const result = diagnostics.console(input);
  assert.equal(JSON.stringify(result).includes("private-before-token"), false);
  assert.equal(JSON.stringify(result).includes("private-after-token"), false);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].text, "password=[redacted]");
});
