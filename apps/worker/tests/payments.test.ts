import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { signBrowserAuthorization } from "../../../packages/domain/src/browser-payment.ts";
import { AgentPage } from "../src/agent-page.ts";
import { WorkerError } from "../src/errors.ts";
import { ReviewedActions } from "../src/reviewed-actions.ts";

const secret = "fake-worker-key-with-at-least-32-chars";
const html = `<form action="https://shop.example/charge" method="post" onsubmit="event.preventDefault();window.count=(window.count||0)+1"><label>Amount<input name="amount" value="10"></label><button>Confirmar pagamento</button></form>`;

for (const fixture of [
  { operation: "Enter", destination: "pay", approval: true },
  { operation: "click", destination: "pay", approval: true },
  { operation: "Enter", destination: "continue", approval: false },
  { operation: "click", destination: "continue", approval: false },
]) {
  test(`neutral external Continue submitter to /${fixture.destination} ${fixture.operation} ${fixture.approval ? "requires review" : "remains autonomous"}`, async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      // Only the actual submission destination supplies the financial signal.
      // The button is outside the form, with no checkout/payment name or label.
      await page.setContent(
        `<form id="request" action="https://shop.example/continue" onsubmit="event.preventDefault();window.count=(window.count||0)+1"><input name="request" aria-label="Request" value="example"></form><button form="request" formaction="https://shop.example/${fixture.destination}" formmethod="post">Continue</button>`,
      );
      const agent = new AgentPage(page);
      const snap = await agent.snapshot();
      const target = snap.elements.find((element) =>
        fixture.operation === "Enter" ? element.tag === "input" : element.tag === "button",
      );
      assert.ok(target);
      const action =
        fixture.operation === "Enter"
          ? {
              snapshotId: snap.snapshotId,
              element: target.number,
              action: "press" as const,
              key: "Enter",
            }
          : { snapshotId: snap.snapshotId, element: target.number, action: "click" as const };
      assert.equal((await agent.inspect(action)).requiresApproval, fixture.approval);
      if (fixture.approval) {
        await assert.rejects(
          agent.act(action, () => {}),
          { code: "PAYMENT_APPROVAL_REQUIRED" },
        );
      } else await agent.act(action, () => {});
      assert.equal(
        await page.evaluate(() => (window as unknown as { count?: number }).count ?? 0),
        fixture.approval ? 0 : 1,
        "unreviewed financial submission has no external effect; ordinary Continue dispatches once",
      );
    } finally {
      await browser.close();
    }
  });
}

test("real reviewed payment executes once, retains receipt across executor restart and rejects forged authorization", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openmuse-payment-"));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    const agent = new AgentPage(page);
    const snap = await agent.snapshot();
    const button = snap.elements.find((e) => e.tag === "button");
    assert.ok(button);
    const element = button.number;
    const action = { snapshotId: snap.snapshotId, element, action: "click" as const };
    await assert.rejects(
      agent.act(action, () => {}),
      { code: "PAYMENT_APPROVAL_REQUIRED" },
    );
    const binding = (await agent.inspect(action)).binding;
    const sessionId = randomUUID();
    const id = createHash("sha256").update("once").digest("hex");
    const authorization = signBrowserAuthorization(secret, {
      sessionId,
      id,
      expiresAt: Date.now() + 60000,
      binding,
    });
    const first = await new ReviewedActions(dir, secret).execute(
      sessionId,
      authorization,
      agent,
      () => {},
    );
    assert.equal(first.status, "succeeded");
    assert.equal(await page.evaluate(() => (window as unknown as { count: number }).count), 1);
    const second = await new ReviewedActions(dir, secret).execute(
      sessionId,
      authorization,
      agent,
      () => {
        throw new Error("replay must not dispatch");
      },
    );
    assert.equal(second.replayed, true);
    assert.equal(await page.evaluate(() => (window as unknown as { count: number }).count), 1);
    await assert.rejects(
      new ReviewedActions(dir, secret).execute(sessionId, `${authorization}x`, agent, () => {}),
      { code: "INVALID_APPROVAL" },
    );
    await assert.rejects(
      new ReviewedActions(dir, secret).execute(randomUUID(), authorization, agent, () => {}),
      { code: "INVALID_APPROVAL" },
    );
    const path = join(dir, sessionId, "reviewed-actions", `${id}.json`);
    const receipt = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...receipt, status: "executing" }));
    await assert.rejects(
      new ReviewedActions(dir, secret).execute(sessionId, authorization, agent, () => {}),
      { code: "OUTCOME_UNKNOWN" },
    );
    assert.equal(await page.evaluate(() => (window as unknown as { count: number }).count), 1);
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("real review rejects amount/form target/submitter drift, expiry and takeover before payment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openmuse-payment-drift-"));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const agent = new AgentPage(page);
    const sessionId = randomUUID();
    for (const change of [
      "amount",
      "action",
      "method",
      "target",
      "formaction",
      "formmethod",
      "formtarget",
      "takeover",
      "expiry",
      "restart",
    ]) {
      await page.setContent(html);
      const snap = await agent.snapshot();
      const button = snap.elements.find((e) => e.tag === "button");
      assert.ok(button);
      const action = {
        snapshotId: snap.snapshotId,
        element: button.number,
        action: "click" as const,
      };
      const binding = (await agent.inspect(action)).binding;
      const authorization = signBrowserAuthorization(secret, {
        sessionId,
        id: createHash("sha256").update(change).digest("hex"),
        expiresAt: Date.now() + (change === "expiry" ? -1 : 60000),
        binding,
      });
      if (change === "amount") await page.locator("input").fill("100");
      else if (["action", "method", "target"].includes(change))
        await page
          .locator("form")
          .evaluate(
            (node, name) =>
              node.setAttribute(name, name === "action" ? "https://other.example/pay" : "changed"),
            change,
          );
      else if (change.startsWith("form"))
        await page
          .locator("button")
          .evaluate((node, name) => node.setAttribute(name, "changed"), change);
      else if (change === "takeover") await agent.invalidate();
      const target = change === "restart" ? new AgentPage(page) : agent;
      await assert.rejects(
        new ReviewedActions(dir, secret).execute(sessionId, authorization, target, () => {
          if (change === "takeover")
            throw new WorkerError("BROWSER_CONTROLLED", "Human is controlling", 409);
        }),
        (error) =>
          error instanceof WorkerError &&
          ["STALE_SNAPSHOT", "INVALID_APPROVAL", "BROWSER_CONTROLLED"].includes(error.code),
        change,
      );
      assert.equal(
        await page.evaluate(() => (window as unknown as { count?: number }).count ?? 0),
        0,
      );
    }
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("owning-frame price, password-masked values and external implicit submitter overrides bind the exact review", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openmuse-payment-context-"));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const agent = new AgentPage(page);
    const sessionId = randomUUID();
    const nested = `<span id="price">Total 10 EUR for Alice</span><form id="checkout" onsubmit="event.preventDefault();window.count=(window.count||0)+1"><input name="amount" aria-label="Amount" value="10"><input name="cvv" aria-label="Card code" type="password" value="123"></form><button form="checkout" formaction="https://shop.example/pay" formmethod="post">Pay now</button>`;
    for (const change of ["price", "password", "formaction", "formmethod", "formtarget"]) {
      await page.setContent(`<iframe title="checkout"></iframe>`);
      const frame = page.frames().find((frame) => frame !== page.mainFrame());
      assert.ok(frame);
      await frame.setContent(nested);
      const snap = await agent.snapshot();
      const amount = snap.elements.find((e) => e.label === "Amount");
      assert.ok(amount);
      const action = {
        snapshotId: snap.snapshotId,
        element: amount.number,
        action: "press" as const,
        key: "Enter",
      };
      const inspected = await agent.inspect(action);
      assert.equal(
        inspected.requiresApproval,
        true,
        "external associated Pay submitter guards implicit Enter",
      );
      const authorization = signBrowserAuthorization(secret, {
        sessionId,
        id: createHash("sha256").update(`context-${change}`).digest("hex"),
        expiresAt: Date.now() + 60000,
        binding: inspected.binding,
      });
      assert.equal(
        JSON.stringify(snap).includes('"123"'),
        false,
        "password is absent from public snapshot",
      );
      assert.equal(
        JSON.stringify(inspected.binding).includes('"123"'),
        false,
        "password is hashed, not stored in binding",
      );
      if (change === "price")
        await frame.locator("#price").evaluate((node) => {
          node.textContent = "Total 100 EUR for Mallory";
        });
      else if (change === "password") await frame.locator('[type="password"]').fill("987");
      else
        await frame
          .locator("button")
          .evaluate(
            (node, name) =>
              node.setAttribute(
                name,
                name === "formaction"
                  ? "https://other.example/pay"
                  : name === "formmethod"
                    ? "get"
                    : "other",
              ),
            change,
          );
      await assert.rejects(
        new ReviewedActions(dir, secret).execute(sessionId, authorization, agent, () => {}),
        { code: "STALE_SNAPSHOT" },
        change,
      );
      assert.equal(
        await frame.evaluate(() => (window as unknown as { count?: number }).count ?? 0),
        0,
      );
    }
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});
