import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { BrowserService } from "../apps/server/src/browser.ts";
import { browserTools } from "../apps/server/src/browser-tools.ts";
import type { ComputerBackend } from "../apps/server/src/computer-contract.ts";
import { computerTools } from "../apps/server/src/computer-tools.ts";
import { ToolDiscovery } from "../apps/server/src/engine/tool-discovery.ts";
import { classifyBrowserOperation } from "../apps/server/src/executors/capability-router.ts";
import {
  nativeBrowserArgsSchema,
  nativeInspection,
} from "../apps/server/src/executors/graphical-policy.ts";
import type { Files } from "../apps/server/src/files.ts";
import { WorkerError } from "../apps/worker/src/errors.ts";
import { nativeBrowserFailure } from "../apps/worker/src/native-errors.ts";
import { browserDiagnosticInspection } from "../packages/domain/src/browser-diagnostics.ts";

test("native diagnostic inspection validates concrete commands before granting reading authority", () => {
  const args = {
    sessionId: randomUUID(),
    sessionGeneration: randomUUID(),
    controlRevision: 0,
    browserSessionId: randomUUID(),
    actor: "agent",
    operation: "cdp",
    body: { method: "Browser.getVersion" },
  };
  assert.equal(nativeInspection("browser", args), true);
  assert.equal(classifyBrowserOperation("cdp", false), "authenticated_read");
  assert.equal(classifyBrowserOperation("cdp", true), "public_read");
  for (const body of [
    { method: "Runtime.evaluate", params: { expression: "fetch('/delete')" } },
    { method: "Browser.getVersion", params: { targetId: "another-owner" } },
    { method: "DOM.getDocument", params: { depth: -1 } },
  ])
    assert.equal(nativeBrowserArgsSchema.safeParse({ ...args, body }).success, false);
  assert.equal(
    nativeInspection("browser", { ...args, operation: "console", body: { after: 0 } }),
    true,
  );
  assert.equal(
    nativeBrowserArgsSchema.safeParse({
      ...args,
      operation: "console",
      body: { expression: "alert('delete')" },
    }).success,
    false,
  );
});

test("dialog responses use native mutation authority and cannot inject their own approval", () => {
  const args = {
    sessionId: randomUUID(),
    sessionGeneration: randomUUID(),
    controlRevision: 0,
    browserSessionId: randomUUID(),
    actor: "agent",
    operation: "dialog",
    body: { dialogId: randomUUID(), accept: true },
  };
  assert.equal(nativeBrowserArgsSchema.safeParse(args).success, true);
  assert.equal(nativeInspection("browser", args), false);
  assert.equal(classifyBrowserOperation("dialog", false), "mutable");
  assert.equal(classifyBrowserOperation("dialog", true), "mutable");
  assert.equal(
    nativeBrowserArgsSchema.safeParse({ ...args, body: { ...args.body, approved: true } }).success,
    false,
  );
  assert.equal(
    nativeBrowserArgsSchema.safeParse({
      ...args,
      operation: "reviewed-dialog",
      body: { ...args.body, approvalId: "a".repeat(64) },
    }).success,
    true,
  );
  const tools = browserTools({} as BrowserService, "owner");
  const discovery = new ToolDiscovery(tools);
  assert.ok(
    discovery
      .search("respond pending browser dialog confirmation prompt")
      .tools.some((tool) => tool.name === "browser_dialog"),
  );
  assert.deepEqual(discovery.describe(["browser_dialog"]).loaded, ["browser_dialog"]);
});

test("the actual diagnostics tools participate in progressive schema discovery", () => {
  const tools = [
    ...browserTools({} as BrowserService, "owner"),
    ...computerTools({} as ComputerBackend, {} as Files, "owner", "scope"),
  ];
  const discovery = new ToolDiscovery(tools);
  assert.equal(discovery.enabled, true);
  assert.equal(
    discovery.select(tools).some((tool) => tool.name === "browser_cdp"),
    false,
  );
  assert.ok(
    discovery
      .search("console JavaScript exceptions")
      .tools.some((tool) => tool.name === "browser_console"),
  );
  const described = discovery.describe(["browser_console", "browser_cdp"]);
  assert.deepEqual(described.loaded, ["browser_console", "browser_cdp"]);
  assert.equal(
    discovery.select(tools).filter((tool) => ["browser_console", "browser_cdp"].includes(tool.name))
      .length,
    2,
  );
  assert.match(JSON.stringify(described), /DOM.getDocument/);
});

test("native errors confirm no input cleanup only for validated diagnostic reads", () => {
  const request = (operation: string, body: unknown) => ({
    operation: "perform",
    envelope: { args: { operation, body } },
  });
  assert.equal(browserDiagnosticInspection(request("cdp", { method: "Browser.getVersion" })), true);
  assert.equal(browserDiagnosticInspection(request("console", {})), true);
  assert.equal(
    browserDiagnosticInspection(
      request("cdp", { method: "Page.navigate", params: { url: "https://example.com/" } }),
    ),
    false,
  );
  assert.equal(
    browserDiagnosticInspection(
      request("cdp", { method: "Browser.getVersion", params: { expression: "fetch('/delete')" } }),
    ),
    false,
  );
  assert.equal(browserDiagnosticInspection(request("act", {})), false);
});

test("native pending-dialog preflight preserves recovery while mutable failures retain uncertainty", () => {
  const request = {
    operation: "perform",
    envelope: { args: { operation: "navigate", body: { url: "https://example.com/" } } },
  };
  const pending = nativeBrowserFailure(request, new WorkerError("BROWSER_DIALOG_PENDING", "guard"));
  assert.equal(pending.dispatched, false);
  assert.equal(pending.cleanupConfirmed, true);
  assert.match(pending.message, /browser_snapshot/);
  for (const error of [
    new Error("lost response"),
    new WorkerError("OUTCOME_UNKNOWN", "input may have occurred"),
    { code: "BROWSER_DIALOG_PENDING" },
  ]) {
    const uncertain = nativeBrowserFailure(request, error);
    assert.equal(uncertain.dispatched, true);
    assert.equal(uncertain.cleanupConfirmed, false);
  }
});
