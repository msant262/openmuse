import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { browserConsole } from "../../server/src/browser-console.ts";
import { AgentPage, browserAction, paymentLabel } from "../src/agent-page.ts";

const fixture = `<!doctype html><title>Browser fixture</title><style>body{height:2400px}label,input,button,select{display:block;margin:15px}</style>
<label>Name<input name="name"></label><label>Password<input type="password" value="secret-login"></label>
<input type="hidden" value="hidden-secret"><select aria-label="Language"><option value="pt">Português</option><option value="de">Deutsch</option></select>
<button id="greet" onclick="this.textContent='Done'">Greet</button><input type="checkbox" aria-label="Remember">
<form onsubmit="event.preventDefault();document.title='Money sent'"><label>Amount<input name="amount" value="10"></label><button>Confirmar pagamento</button></form>
<iframe title="Embedded form" srcdoc="&lt;label&gt;Frame name&lt;input name=frame-name&gt;&lt;/label&gt;"></iframe>
<button onclick="document.title='Paid'">Jetzt bezahlen</button><a href="https://example.com/other">Next page</a>`;

test("real Playwright numbered controls act, reject drift and gate multilingual money submission", {
  timeout: 30_000,
}, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.route("https://example.com/**", (route) =>
      route.fulfill({ contentType: "text/html", body: fixture }),
    );
    await page.goto("https://example.com/fixture");
    const agent = new AgentPage(page);
    let snapshot = await agent.snapshot();
    const named = (label: string) => {
      const element = snapshot.elements.find((item) => item.label === label);
      assert.ok(element, label);
      return element;
    };
    assert.equal(named("Password").value, undefined);
    assert.equal(
      snapshot.elements.some((item) => item.type === "hidden"),
      false,
    );
    assert.ok(!JSON.stringify(snapshot).includes("secret-login"));
    const frameName = named("Frame name");
    await agent.act(
      {
        snapshotId: snapshot.snapshotId,
        element: frameName.number,
        action: "fill",
        value: "Embedded",
      },
      () => {},
    );
    assert.equal(await page.frameLocator("iframe").getByRole("textbox").inputValue(), "Embedded");
    snapshot = await agent.snapshot();
    const old = {
      snapshotId: snapshot.snapshotId,
      element: named("Name").number,
      action: "fill" as const,
      value: "Ana",
    };
    await agent.act(old, () => {});
    assert.equal(
      await page.getByRole("textbox", { name: "Name", exact: true }).inputValue(),
      "Ana",
    );
    await assert.rejects(
      agent.act(old, () => {}),
      { code: "STALE_SNAPSHOT" },
    );
    snapshot = await agent.snapshot();
    await agent.act(
      {
        snapshotId: snapshot.snapshotId,
        element: named("Language").number,
        action: "select",
        value: "de",
      },
      () => {},
    );
    assert.equal(await page.getByRole("combobox").inputValue(), "de");
    snapshot = await agent.snapshot();
    await agent.act(
      { snapshotId: snapshot.snapshotId, element: named("Greet").number, action: "click" },
      () => {},
    );
    assert.equal(await page.locator("#greet").innerText(), "Done");
    snapshot = await agent.snapshot();
    await agent.act(
      { snapshotId: snapshot.snapshotId, element: named("Remember").number, action: "click" },
      () => {},
    );
    assert.equal(await page.getByRole("checkbox").isChecked(), true);
    snapshot = await agent.snapshot();
    const replaced = {
      snapshotId: snapshot.snapshotId,
      element: named("Done").number,
      action: "click" as const,
    };
    await page.locator("#greet").evaluate((node) => {
      node.outerHTML = '<button id="greet">Done</button>';
    });
    await assert.rejects(
      agent.act(replaced, () => {}),
      { code: "STALE_SNAPSHOT" },
    );
    snapshot = await agent.snapshot();
    const changed = {
      snapshotId: snapshot.snapshotId,
      element: named("Done").number,
      action: "click" as const,
    };
    await page.locator("#greet").evaluate((node) => {
      node.textContent = "Different";
    });
    await assert.rejects(
      agent.act(changed, () => {}),
      { code: "STALE_SNAPSHOT" },
    );
    snapshot = await agent.snapshot();
    for (const [label, action, key] of [
      ["Confirmar pagamento", "click", undefined],
      ["Jetzt bezahlen", "click", undefined],
      ["Amount", "press", "Enter"],
    ] as const) {
      await assert.rejects(
        agent.act(
          browserAction({
            snapshotId: snapshot.snapshotId,
            element: named(label).number,
            action,
            ...(key ? { key } : {}),
          }),
          () => {},
        ),
        { code: "PAYMENT_APPROVAL_REQUIRED" },
      );
    }
    assert.equal(await page.title(), "Browser fixture", "money controls never execute");
    const inspected = await agent.inspect({
      snapshotId: snapshot.snapshotId,
      element: named("Confirmar pagamento").number,
      action: "click",
    });
    await page.locator('[name="amount"]').fill("200");
    const changedAmount = await agent.inspect({
      snapshotId: snapshot.snapshotId,
      element: named("Confirmar pagamento").number,
      action: "click",
    });
    assert.notEqual(
      inspected.binding.formDigest,
      changedAmount.binding.formDigest,
      "approval binding observes changed amount",
    );
    snapshot = await agent.snapshot();
    await agent.act(
      {
        snapshotId: snapshot.snapshotId,
        element: named("Name").number,
        action: "press",
        key: "Tab",
      },
      () => {},
    );
    snapshot = await agent.snapshot();
    await agent.act(
      {
        snapshotId: snapshot.snapshotId,
        element: named("Remember").number,
        action: "scroll",
        deltaY: 600,
      },
      () => {},
    );
    await page.waitForTimeout(100);
    assert.ok((await page.evaluate(() => window.scrollY)) > 0);
    const image = await page.screenshot({ type: "jpeg", quality: 60 });
    assert.equal(image[0], 0xff);
    assert.ok(image.length < 1024 * 1024);
    snapshot = await agent.snapshot();
    const navigated = {
      snapshotId: snapshot.snapshotId,
      element: named("Name").number,
      action: "fill" as const,
      value: "Wrong page",
    };
    await page.goto("https://example.com/other");
    await assert.rejects(
      agent.act(navigated, () => {}),
      { code: "STALE_SNAPSHOT" },
    );
    snapshot = await agent.snapshot();
    await assert.rejects(
      agent.act(
        {
          snapshotId: snapshot.snapshotId,
          element: named("Name").number,
          action: "fill",
          value: "Unsafe",
        },
        () => {
          throw new Error("human takeover");
        },
      ),
      /human takeover/,
    );
    assert.equal(await page.locator('[name="name"]').inputValue(), "");
    await agent.invalidate();
  } finally {
    await browser.close();
  }
});

test("payment labels and agent action arguments are bounded and cannot carry approval bypass", () => {
  for (const label of [
    "Pay now",
    "Checkout",
    "Confirm order",
    "Transfer money",
    "Pagar",
    "Finalizar compra",
    "Enviar dinheiro",
    "Jetzt bezahlen",
    "Bestellung bestätigen",
    "Überweisen",
  ])
    assert.ok(paymentLabel(label), label);
  assert.equal(paymentLabel("Read today's agenda"), false);
  assert.throws(
    () =>
      browserAction({
        snapshotId: "00000000-0000-4000-8000-000000000001",
        element: 1,
        action: "click",
        approved: true,
      }),
    { code: "INVALID_ACTION" },
  );
});

test("real phone console can watch, take control, type, and explicitly hand back", {
  timeout: 30_000,
}, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const remote = await browser.newPage();
    await remote.setContent("<h1>Live agent page</h1>");
    const png = await remote.screenshot();
    const consolePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    let control = "agent";
    const inputs: unknown[] = [];
    await consolePage.route("https://example.com/preview", (route) =>
      route.fulfill({ contentType: "image/png", body: png }),
    );
    await consolePage.route("https://example.com/console", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          contentType: "text/html",
          body: browserConsole("https://example.com/preview"),
        });
        return;
      }
      const body = route.request().postDataJSON();
      if (body.control) control = body.control;
      else if (!body.operation) inputs.push(body);
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ control }) });
    });
    await consolePage.goto("https://example.com/console");
    await consolePage.getByText("Live", { exact: true }).waitFor();
    assert.equal(await consolePage.getByRole("button", { name: "Send text" }).isDisabled(), true);
    await consolePage.getByRole("button", { name: "Take control", exact: true }).click();
    await consolePage.getByText("You are in control", { exact: true }).waitFor();
    await consolePage.getByRole("textbox").fill("Olá Ana");
    await consolePage.getByRole("button", { name: "Send text" }).click();
    await consolePage.waitForFunction(
      () => (document.querySelector("#text") as HTMLInputElement).value === "",
    );
    assert.deepEqual(inputs, [{ type: "text", text: "Olá Ana" }]);
    await consolePage.getByRole("button", { name: "Hand back to agent" }).click();
    await consolePage.getByText("Watching the agent", { exact: true }).waitFor();
    assert.equal(await consolePage.getByRole("button", { name: "Send text" }).isDisabled(), true);
    assert.equal(control, "agent");
  } finally {
    await browser.close();
  }
});

test("referenced accessible payment names block click and Enter; name drift invalidates references", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<title>UNPAID</title><span id="pay-label">Pay now</span>
      <button id="pay" aria-labelledby="pay-label" onclick="document.title='PAID'">💳</button>
      <form onsubmit="event.preventDefault();document.title='PAID'"><input aria-label="Quantity"><button aria-labelledby="pay-label">✓</button></form>`);
    const agent = new AgentPage(page);
    let snapshot = await agent.snapshot();
    assert.equal(snapshot.elements[0].label, "Pay now");
    await assert.rejects(
      agent.act({ snapshotId: snapshot.snapshotId, element: 1, action: "click" }, () => {}),
      { code: "PAYMENT_APPROVAL_REQUIRED" },
    );
    const quantity = snapshot.elements.find((element) => element.label === "Quantity");
    assert.ok(quantity);
    await assert.rejects(
      agent.act(
        {
          snapshotId: snapshot.snapshotId,
          element: quantity.number,
          action: "press",
          key: "Enter",
        },
        () => {},
      ),
      { code: "PAYMENT_APPROVAL_REQUIRED" },
    );
    assert.equal(await page.title(), "UNPAID");
    snapshot = await agent.snapshot();
    await page.locator("#pay-label").evaluate((node) => {
      node.textContent = "Confirm order";
    });
    await assert.rejects(
      agent.act({ snapshotId: snapshot.snapshotId, element: 1, action: "click" }, () => {}),
      { code: "STALE_SNAPSHOT" },
    );
  } finally {
    await browser.close();
  }
});

test("child-frame pushState and hash navigation invalidate old controls and bindings", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://example.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: route.request().url().endsWith("/main")
          ? '<iframe src="/frame"></iframe>'
          : "<button onclick=\"document.title='CLICKED'\">Continue</button>",
      }),
    );
    await page.goto("https://example.com/main");
    const frame = page.frames().find((frame) => frame !== page.mainFrame());
    assert.ok(frame);
    const agent = new AgentPage(page);
    let snapshot = await agent.snapshot();
    await frame.evaluate(() => history.pushState({}, "", "/different-context"));
    await assert.rejects(
      agent.inspect({ snapshotId: snapshot.snapshotId, element: 1, action: "click" }),
      { code: "STALE_SNAPSHOT" },
    );
    await assert.rejects(
      agent.act({ snapshotId: snapshot.snapshotId, element: 1, action: "click" }, () => {}),
      { code: "STALE_SNAPSHOT" },
    );
    snapshot = await agent.snapshot();
    assert.equal(snapshot.elements[0].frameUrl, "https://example.com/different-context");
    await frame.evaluate(() => {
      location.hash = "changed";
    });
    await assert.rejects(
      agent.act({ snapshotId: snapshot.snapshotId, element: 1, action: "click" }, () => {}),
      { code: "STALE_SNAPSHOT" },
    );
    assert.notEqual(await frame.title(), "CLICKED");
  } finally {
    await browser.close();
  }
});
