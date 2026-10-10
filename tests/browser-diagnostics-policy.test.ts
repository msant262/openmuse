import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { BrowserService } from "../apps/server/src/browser.ts";
import type { ComputerBackend } from "../apps/server/src/computer-contract.ts";
import { computerTools } from "../apps/server/src/computer-tools.ts";
import type { Files } from "../apps/server/src/files.ts";
import { browserTools } from "../apps/server/src/browser-tools.ts";
import { ToolDiscovery } from "../apps/server/src/engine/tool-discovery.ts";
import { classifyBrowserOperation } from "../apps/server/src/executors/capability-router.ts";
import {
  nativeBrowserArgsSchema,
  nativeInspection,
} from "../apps/server/src/executors/graphical-policy.ts";

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
