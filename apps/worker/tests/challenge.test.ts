import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { chromium } from "playwright";
import type {
  CaptchaAction,
  CaptchaPlan,
} from "../../../packages/domain/src/credential-challenge.ts";
import { BrowserChallenge } from "../src/challenge.ts";

const html = `<!doctype html><style>body{margin:0}#challenge{position:absolute;left:20px;top:100px;width:400px;height:140px;background:white}input,button{margin:5px}#canvas{height:80px;width:100px;background:cyan}</style>
<input id=password value="private-canary"><div id=challenge><input id=answer aria-label=Answer><button id=tile onclick="this.textContent='Selected'">Tile</button><button id=submit onclick="if(document.querySelector('#answer').value==='4') document.querySelector('#signed').hidden=false">Verify</button><div id=canvas onmousedown="this.dataset.down='yes'" onmouseup="this.dataset.up='yes'"></div></div><div id=signed hidden>Account</div>`;
async function fixture(t: TestContext) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  await page.route("https://challenge.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await page.goto("https://challenge.test/login");
  const challenge = new BrowserChallenge(page);
  const plan: CaptchaPlan = {
    challengeId: randomUUID(),
    origin: "https://challenge.test",
    selector: "#challenge",
    authenticatedSelector: "#signed",
    submitSelector: "#submit",
    sensitiveSelectors: ["#password"],
    expiresAt: Date.now() + 60_000,
    action: { action: "observe" },
  };
  const execute = (action: CaptchaAction) =>
    challenge.execute(
      { ...plan, action },
      () => {},
      async () => {},
    );
  return { page, plan, challenge, execute };
}
test("real Chromium solves a DOM challenge, rejects replay and verifies the site's result", async (t) => {
  const { page, execute } = await fixture(t);
  let frame = await execute({ action: "observe" });
  assert.equal(frame.status, "pending");
  assert.ok(frame.frameId);
  assert.equal(frame.width, 400);
  assert.equal(JSON.stringify(frame).includes("private-canary"), false);
  const answer = frame.elements!.find((item) => item.label === "Answer")!;
  await execute({ action: "fill", frameId: frame.frameId!, element: answer.number, value: "4" });
  await assert.rejects(execute({ action: "submit", frameId: frame.frameId! }), {
    code: "STALE_CHALLENGE_FRAME",
  });
  frame = await execute({ action: "observe" });
  assert.equal(
    (await execute({ action: "submit", frameId: frame.frameId! })).status,
    "authenticated",
  );
  assert.equal(await page.locator("#signed").isVisible(), true);
});
test("visual click/drag are limited to fresh challenge pixels and cannot submit or buy", async (t) => {
  const { page, execute } = await fixture(t);
  let frame = await execute({ action: "observe" });
  const tile = await page.locator("#tile").boundingBox();
  assert.ok(tile);
  const x = (tile.x + tile.width / 2 - 20) / 400,
    y = (tile.y + tile.height / 2 - 100) / 140;
  await execute({ action: "visual_click", frameId: frame.frameId!, x, y });
  assert.equal(await page.locator("#tile").textContent(), "Selected");
  frame = await execute({ action: "observe" });
  await execute({
    action: "visual_drag",
    frameId: frame.frameId!,
    x: 0.05,
    y: 0.6,
    toX: 0.2,
    toY: 0.6,
  });
  assert.equal(await page.locator("#canvas").getAttribute("data-up"), "yes");
  frame = await execute({ action: "observe" });
  await page.locator("#tile").evaluate((node) => (node.textContent = "Confirmar pagamento"));
  await assert.rejects(execute({ action: "visual_click", frameId: frame.frameId!, x, y }), {
    code: "STALE_CHALLENGE_FRAME",
  });
  frame = await execute({ action: "observe" });
  await assert.rejects(execute({ action: "click", frameId: frame.frameId!, element: 2 }), {
    code: "PAYMENT_APPROVAL_REQUIRED",
  });
});
test("same-looking replacement, secret overlap, origin drift and expired windows dispatch nothing", async (t) => {
  const { page, execute, plan, challenge } = await fixture(t);
  const frame = await execute({ action: "observe" });
  await page.locator("#tile").evaluate((node) => node.replaceWith(node.cloneNode(true)));
  await assert.rejects(execute({ action: "click", frameId: frame.frameId!, element: 2 }), {
    code: "STALE_CHALLENGE_FRAME",
  });
  await assert.rejects(
    challenge.execute(
      { ...plan, expiresAt: Date.now() - 1 },
      () => {},
      async () => {},
    ),
    { code: "CHALLENGE_BUDGET_EXHAUSTED" },
  );
  await page
    .locator("#password")
    .evaluate((node) => document.querySelector("#challenge")!.append(node));
  await assert.rejects(execute({ action: "observe" }), { code: "CHALLENGE_UNAVAILABLE" });
  await page.route("https://different.test/**", (route) => route.fulfill({ body: html }));
  await page.goto("https://different.test");
  await assert.rejects(execute({ action: "observe" }), { code: "CHALLENGE_ORIGIN_CHANGED" });
});
test("lost authority after mouse input reports uncertainty and releases the button", async (t) => {
  const { page, execute, plan, challenge } = await fixture(t);
  const frame = await execute({ action: "observe" });
  let guards = 0;
  await assert.rejects(
    challenge.execute(
      {
        ...plan,
        action: {
          action: "visual_drag",
          frameId: frame.frameId!,
          x: 0.05,
          y: 0.6,
          toX: 0.2,
          toY: 0.6,
        },
      },
      () => {
        if (++guards === 4) throw new Error("authority lost");
      },
      async () => {},
    ),
    { code: "OUTCOME_UNKNOWN" },
  );
  assert.equal(await page.locator("#canvas").getAttribute("data-up"), "yes");
});
