import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import test from "node:test";
import { BrowserHarnessDriver } from "../apps/worker/src/browser-harness-driver.ts";

const require = createRequire(import.meta.url);
const { chromium } =
  require("../apps/worker/node_modules/playwright") as typeof import("../apps/worker/node_modules/playwright/index.js");

test("unchanged Python helpers type, switch named tabs and save actual PNG bytes through the owned CDP driver", {
  timeout: 45_000,
}, async () => {
  // Isolated local regression fixture. This launch does not prove native sandbox/control policy.
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--enable-automation"],
  });
  const context = await browser.newContext();
  const cdp = await browser.newBrowserCDPSession();
  const scope = { owner: "qa", conversation: "sdk-conversation", name: "sdk-test" };
  let commands = 0;
  const driver = new BrowserHarnessDriver({
    cdp,
    createPage: async () => {
      const page = await context.newPage();
      const probe = await context.newCDPSession(page);
      try {
        const { targetInfo } = await probe.send("Target.getTargetInfo");
        return { page, targetId: targetInfo.targetId };
      } finally {
        await probe.detach();
      }
    },
    guard: () => {},
    authorize: async () => {},
    screenshot: async (_, page, params) => ({
      data: (
        await page.screenshot({ type: "png", fullPage: params.captureBeyondViewport === true })
      ).toString("base64"),
    }),
    redact: (value) => value,
  });
  const child = spawn("python3", ["tests/helpers/browser-harness-python.py"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const ended = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const text = "a".repeat(120);
  const pageUrl = `data:text/html,${encodeURIComponent('<title>First owned page</title><textarea id="message"></textarea>')}`;
  const code = [
    "import json, pathlib",
    `goto_url(${JSON.stringify(pageUrl)})`,
    "wait_for_load()",
    "first = current_tab()",
    `fill_input('#message', ${JSON.stringify(text)})`,
    "observed = js(\"document.querySelector('#message').value\")",
    "second = new_tab('data:text/html,<title>Second owned page</title><p>Second</p>')",
    "wait_for_load()",
    "second_title = current_tab()['title']",
    "switch_tab(first)",
    "first_title = current_tab()['title']",
    "path = capture_screenshot()",
    "png = pathlib.Path(path).read_bytes()",
    "tabs = list_tabs()",
    "print(json.dumps({'value':observed, 'firstTitle':first_title,'secondTitle':second_title, 'tabs':len(tabs),'pngHeader':png[:8].hex(),'pngBytes':len(png)}))",
  ].join("\n");
  child.stdin.write(`${JSON.stringify({ code })}\n`);
  let result: Record<string, unknown> | undefined;
  try {
    for await (const line of lines) {
      const value = JSON.parse(line);
      if (value.kind === "result") {
        result = value;
        break;
      }
      assert.equal(value.kind, "browser");
      assert.equal(value.args.session, scope.name);
      commands++;
      try {
        child.stdin.write(
          `${JSON.stringify({ result: await driver.handle(scope, value.args.request, value.args.timeoutMs) })}\n`,
        );
      } catch (error) {
        child.stdin.write(`${JSON.stringify({ error: String(error) })}\n`);
      }
    }
    assert.ok(result, stderr);
    const execution = result.result as {
      status: string;
      stdout: string;
      cleanup_confirmed: boolean;
      tool_calls: unknown[];
      browser_outcome_unknown: boolean;
    };
    assert.equal(execution.status, "ok", JSON.stringify(result));
    const observed = JSON.parse(execution.stdout);
    assert.deepEqual(
      {
        value: observed.value,
        firstTitle: observed.firstTitle,
        secondTitle: observed.secondTitle,
        tabs: observed.tabs,
      },
      {
        value: text,
        firstTitle: "First owned page",
        secondTitle: "Second owned page",
        tabs: 2,
      },
    );
    assert.equal(observed.pngHeader, "89504e470d0a1a0a");
    assert.ok(observed.pngBytes > 1000);
    assert.ok(commands > 200);
    assert.equal(execution.tool_calls.length, 0);
    assert.equal(execution.browser_outcome_unknown, false);
    assert.equal(execution.cleanup_confirmed, true);
    assert.equal(result.liveChildren, 0);
    child.stdin.end();
    assert.equal(await ended, 0, stderr);
  } finally {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await ended;
    lines.close();
    await driver.close();
    await browser.close();
  }
});
