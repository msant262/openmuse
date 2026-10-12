import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test, { after, before } from "node:test";
import { setTimeout } from "node:timers/promises";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createBrowserManager } from "../src/browser.ts";
import { WorkerError } from "../src/errors.ts";
import { publicFixture } from "./public-fixture.ts";

let fixture: Awaited<ReturnType<typeof publicFixture>>;
before(async () => {
  fixture = await publicFixture();
});
after(async () => {
  await fixture?.close();
});
const scope = { owner: "qa", conversation: "manager-thread", name: "research" };

async function managed(
  t: test.TestContext,
  protect?: Parameters<typeof createBrowserManager>[0]["protect"],
) {
  const directory = await mkdtemp(join(tmpdir(), "okami-harness-manager-"));
  const manager = await createBrowserManager({
    dataDir: directory,
    protect,
    // Trusted, controlled QA policy only. Native approval integration is a separate gate.
    scriptPolicy: async (_scope, _page, method) => {
      if (method === "DOM.setFileInputFiles")
        throw new WorkerError("UPLOAD_NOT_GRANTED", "Upload grant is required", 403);
    },
  });
  t.after(async () => {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(
    typeof manager.script,
    "function",
    "The helper driver is not connected to BrowserManager",
  );
  const id = randomUUID();
  const command = (request: unknown, selected = scope, timeoutMs = 5000) =>
    manager.script(id, selected, request, timeoutMs);
  const evaluate = async (expression: string) => {
    const response = await command({
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true },
    });
    assert.equal(response.error, undefined);
    return (response.result as { result: { value: unknown } }).result.value;
  };
  const navigate = async (url: string, title: string) => {
    await command({ method: "Page.navigate", params: { url } });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if ((await manager.snapshot(id)).title === title) return;
      await setTimeout(15);
    }
    assert.equal(
      (await manager.snapshot(id)).title,
      title,
      "The owned page did not finish navigation",
    );
  };
  await command({ meta: "session" });
  return { id, manager, command, evaluate, navigate };
}

test("manager rejects helper execution before browser launch when its host policy is unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "okami-harness-manager-"));
  const manager = await createBrowserManager({ dataDir: directory });
  try {
    assert.equal(
      typeof manager.script,
      "function",
      "The helper driver is not connected to BrowserManager",
    );
    await assert.rejects(
      manager.script(
        randomUUID(),
        { owner: "owner", conversation: "thread", name: "research" },
        { meta: "session" },
      ),
      /policy|unavailable/i,
    );
    assert.deepEqual(manager.list(), []);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("manager preserves helper tabs and the selected page while containing unowned popups", {
  timeout: 30_000,
}, async (t) => {
  const { manager, id, command, evaluate, navigate } = await managed(t);
  const first = (await command({ meta: "session" })).session_id;
  await navigate("https://browser.fixture.test/diagnostics", "Diagnostics fixture");
  assert.equal(await evaluate("document.title"), "Diagnostics fixture");
  const created = await command({ method: "Target.createTarget", params: { url: "about:blank" } });
  const secondTarget = (created.result as { targetId: string }).targetId;
  const attached = await command({
    method: "Target.attachToTarget",
    params: { targetId: secondTarget },
  });
  const secondSession = (attached.result as { sessionId: string }).sessionId;
  await command({ meta: "set_session", session_id: secondSession, target_id: secondTarget });
  await navigate("https://browser.fixture.test/other", "Browser fixture");
  assert.equal(await evaluate("document.title"), "Browser fixture");
  assert.equal((await manager.snapshot(id)).title, "Browser fixture");
  await command({ meta: "set_session", session_id: first });
  assert.equal((await manager.snapshot(id)).title, "Diagnostics fixture");
  const listed = await command({ method: "Target.getTargets" });
  assert.equal((listed.result as { targetInfos: unknown[] }).targetInfos.length, 2);
  await assert.rejects(
    command(
      { method: "Target.attachToTarget", params: { targetId: secondTarget } },
      { ...scope, conversation: "other-thread" },
    ),
    { code: "BROWSER_SCRIPT_FOREIGN_TARGET" },
  );
  await command({
    method: "Runtime.evaluate",
    params: {
      expression: "Boolean(window.open('https://browser.fixture.test/other'))",
      userGesture: true,
      returnByValue: true,
    },
  });
  const deadline = Date.now() + 5000;
  while ((await manager.snapshot(id)).interruptions.popupsBlocked < 1 && Date.now() < deadline)
    await setTimeout(15);
  assert.ok((await manager.snapshot(id)).interruptions.popupsBlocked >= 1);
  assert.equal((await command({ method: "Target.getTargets" })).error, undefined);
});

test("manager applies screenshot protection and blocks raw DOM reads on credential pages", {
  timeout: 30_000,
}, async (t) => {
  let protections = 0;
  const { command, evaluate, navigate } = await managed(t, async () => {
    protections++;
  });
  await navigate("https://browser.fixture.test/protected-diagnostics", "Protected fixture");
  await assert.rejects(evaluate("document.querySelector('input').value"), {
    code: "SENSITIVE_PROGRAMMATIC_OBSERVATION",
  });
  const before = protections;
  const screenshot = await command({ method: "Page.captureScreenshot", params: { format: "png" } });
  assert.ok(protections > before, "The screenshot bypassed the physical protection hook");
  const bytes = Buffer.from((screenshot.result as { data: string }).data, "base64");
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.ok(bytes.length > 1000);
  const decoded = await loadImage(bytes);
  const canvas = createCanvas(decoded.width, decoded.height);
  const pixels = canvas.getContext("2d");
  pixels.drawImage(decoded, 0, 0);
  assert.deepEqual(
    [...pixels.getImageData(12, 12, 1, 1).data],
    [0, 0, 0, 255],
    "The credential field was not blacked out in the actual PNG",
  );
});

test("manager rechecks human control and rejects private navigation and ungranted uploads before effects", {
  timeout: 30_000,
}, async (t) => {
  const { id, manager, command, evaluate, navigate } = await managed(t);
  await navigate("https://browser.fixture.test/other", "Browser fixture");
  await assert.rejects(
    command({ method: "Page.navigate", params: { url: "http://127.0.0.1/private" } }),
    { code: "BLOCKED_URL" },
  );
  assert.equal(await evaluate("location.href"), "https://browser.fixture.test/other");
  await assert.rejects(
    command({ method: "DOM.setFileInputFiles", params: { files: ["/etc/passwd"], nodeId: 1 } }),
    { code: "UPLOAD_NOT_GRANTED" },
  );
  await manager.setControl(id, "human");
  await assert.rejects(evaluate("document.title = 'Unapproved change'"), {
    code: "BROWSER_CONTROLLED",
  });
  await manager.setControl(id, "agent");
  assert.equal(await evaluate("document.title"), "Browser fixture");
});

test("a denied script host policy creates no browser session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "okami-harness-manager-denied-"));
  const manager = await createBrowserManager({
    dataDir: directory,
    scriptPolicy: async () => {
      throw new WorkerError("HOST_DENIED", "Program is not authorized", 403);
    },
  });
  try {
    assert.equal(
      typeof manager.script,
      "function",
      "The helper driver is not connected to BrowserManager",
    );
    await assert.rejects(manager.script(randomUUID(), scope, { meta: "session" }), {
      code: "HOST_DENIED",
    });
    assert.deepEqual(manager.list(), []);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("manager retains credential redaction after the credential tab closes", {
  timeout: 30_000,
}, async (t) => {
  const { manager, id, command, navigate } = await managed(t, async () => {});
  await navigate("https://browser.fixture.test/other", "Browser fixture");
  const first = await command({ meta: "current_tab" });
  await manager.credentials(id, {
    adapterId: "qa",
    origin: "https://browser.fixture.test",
    allowedRedirectOrigins: ["https://browser.fixture.test"],
    fields: [{ selector: 'input[name="name"]', value: "profile-only-fixture-secret" }],
    sensitiveSelectors: ['input[name="name"]'],
    submitSelector: "button",
    // A controlled already-authenticated signal; this test does not prove login.
    authenticatedSelector: "body",
  });
  const created = await command({ method: "Target.createTarget", params: { url: "about:blank" } });
  const targetId = (created.result as { targetId: string }).targetId;
  const attached = await command({ method: "Target.attachToTarget", params: { targetId } });
  await command({
    meta: "set_session",
    session_id: (attached.result as { sessionId: string }).sessionId,
  });
  await command({ method: "Target.closeTarget", params: { targetId: first.targetId } });
  const read = await command({
    method: "Runtime.evaluate",
    params: {
      expression:
        "({nested: {text: 'profile-only-fixture-secret', authorization: 'Basic fixture-token'}})",
      returnByValue: true,
    },
  });
  assert.deepEqual((read.result as { result: { value: unknown } }).result.value, {
    nested: { text: "[redacted]", authorization: "[redacted]" },
  });
});

test("a credential page in another conversation cannot block this conversation's event stream", {
  timeout: 30_000,
}, async (t) => {
  const { command, navigate } = await managed(t);
  await navigate("https://browser.fixture.test/protected-diagnostics", "Protected fixture");
  const other = { ...scope, conversation: "independent-research" };
  await command({ meta: "session" }, other);
  const drained = await command({ meta: "drain_events" }, other);
  assert.ok(Array.isArray(drained.events));
  assert.doesNotMatch(JSON.stringify(drained.events), /private-fixture-value/);
});

test("helper dialog responses use the existing destructive approval guard", {
  timeout: 30_000,
}, async (t) => {
  const { manager, id, command, navigate, evaluate } = await managed(t);
  await navigate("https://browser.fixture.test/dialogs", "Dialog fixture");
  let snap = await manager.snapshot(id);
  const prompt = snap.elements.find((element) => element.label === "Name document");
  assert.ok(prompt);
  await manager.act(id, { snapshotId: snap.snapshotId, element: prompt.number, action: "click" });
  await command({
    method: "Page.handleJavaScriptDialog",
    params: { accept: true, promptText: "Confirmed document" },
  });
  assert.equal(
    await evaluate("document.querySelector('output').textContent"),
    "Confirmed document",
  );
  snap = await manager.snapshot(id);
  const destructive = snap.elements.find((element) => element.label === "Delete document");
  assert.ok(destructive);
  await manager.act(id, {
    snapshotId: snap.snapshotId,
    element: destructive.number,
    action: "click",
  });
  await assert.rejects(
    command({ method: "Page.handleJavaScriptDialog", params: { accept: true } }),
    { code: "DIALOG_APPROVAL_REQUIRED" },
  );
  await command({ method: "Page.handleJavaScriptDialog", params: { accept: false } });
  assert.equal(await evaluate("document.querySelector('output').textContent"), "Kept");
});

test("copied Python helpers execute through BrowserManager with real typing, tabs and protected PNG", {
  timeout: 45_000,
}, async (t) => {
  const { command } = await managed(t);
  const selected = { owner: "qa", conversation: "sdk-conversation", name: "sdk-test" };
  const child = spawn("python3", ["tests/helpers/browser-harness-python.py"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const ended = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const text = "a".repeat(120);
  const code = [
    "import json, pathlib",
    "goto_url('https://browser.fixture.test/other')",
    "wait_for_load()",
    "first = current_tab()",
    `fill_input('input[name=name]', ${JSON.stringify(text)})`,
    "value = js(\"document.querySelector('input[name=name]').value\")",
    "new_tab('https://browser.fixture.test/diagnostics')",
    "wait_for_load()",
    "second_title = current_tab()['title']",
    "switch_tab(first)",
    "png = pathlib.Path(capture_screenshot()).read_bytes()",
    "print(json.dumps({'value':value,'firstTitle':current_tab()['title'],'secondTitle':second_title,'tabs':len(list_tabs()),'pngHeader':png[:8].hex(),'pngBytes':len(png)}))",
  ].join("\n");
  child.stdin.write(`${JSON.stringify({ code })}\n`);
  let result:
    | {
        result: {
          status: string;
          stdout: string;
          tool_calls: unknown[];
          cleanup_confirmed: boolean;
          browser_outcome_unknown: boolean;
        };
        liveChildren: number;
      }
    | undefined;
  let commands = 0;
  try {
    for await (const line of lines) {
      const value = JSON.parse(line);
      if (value.kind === "result") {
        result = value;
        break;
      }
      assert.equal(value.kind, "browser");
      commands++;
      try {
        child.stdin.write(
          `${JSON.stringify({ result: await command(value.args.request, selected, value.args.timeoutMs) })}\n`,
        );
      } catch (error) {
        child.stdin.write(`${JSON.stringify({ error: String(error) })}\n`);
      }
    }
    assert.ok(result, stderr);
    assert.equal(result.result.status, "ok", JSON.stringify(result));
    const observed = JSON.parse(result.result.stdout);
    assert.equal(observed.value, text);
    assert.equal(observed.firstTitle, "Browser fixture");
    assert.equal(observed.secondTitle, "Diagnostics fixture");
    assert.equal(observed.tabs, 2);
    assert.equal(observed.pngHeader, "89504e470d0a1a0a");
    assert.ok(observed.pngBytes > 1000);
    assert.ok(commands > 200);
    assert.equal(result.result.tool_calls.length, 0);
    assert.equal(result.result.cleanup_confirmed, true);
    assert.equal(result.result.browser_outcome_unknown, false);
    assert.equal(result.liveChildren, 0);
    child.stdin.end();
    assert.equal(await ended, 0, stderr);
  } finally {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await ended;
    lines.close();
  }
});
