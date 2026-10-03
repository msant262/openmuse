import { createHash, randomUUID } from "node:crypto";
import type { ElementHandle, Locator, Page } from "playwright";
import {
  type CaptchaPlan,
  captchaPlanSchema,
} from "../../../packages/domain/src/credential-challenge.ts";
import { paymentLabel } from "./agent-page.ts";
import { WorkerError } from "./errors.ts";

type Box = { x: number; y: number; width: number; height: number };
type Frame = {
  id: string;
  url: string;
  hash: string;
  box: Box;
  nodes: { locator: Locator; handle: ElementHandle }[];
  expiresAt: number;
};
const money = { test: paymentLabel };
/** Only a server-built adapter plan may enter here. The model never chooses
 * the origin, challenge region, success selector or sensitive selectors. */
export class BrowserChallenge {
  private frames = new Map<string, Frame>();
  private readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }
  private async region(plan: CaptchaPlan) {
    if (
      new URL(this.page.url()).origin !== plan.origin ||
      new URL(plan.origin).protocol !== "https:"
    )
      throw new WorkerError(
        "CHALLENGE_ORIGIN_CHANGED",
        "The verification page changed origin.",
        409,
      );
    const root = this.page.locator(plan.selector);
    if ((await root.count()) !== 1 || !(await root.isVisible()))
      throw new WorkerError(
        "CHALLENGE_UNAVAILABLE",
        "The challenge cannot be isolated. Use Take control.",
        409,
      );
    const box = await root.boundingBox(),
      viewport = this.page.viewportSize();
    if (
      !box ||
      !viewport ||
      box.width < 1 ||
      box.height < 1 ||
      box.x < 0 ||
      box.y < 0 ||
      box.x + box.width > viewport.width ||
      box.y + box.height > viewport.height
    )
      throw new WorkerError(
        "CHALLENGE_UNAVAILABLE",
        "The complete challenge is not visible. Use Take control.",
        409,
      );
    // Never reveal a credential even if its field has been switched to plain text.
    for (const selector of plan.sensitiveSelectors) {
      const sensitive = this.page.locator(selector);
      for (let i = 0; i < Math.min(await sensitive.count(), 30); i++) {
        const field = await sensitive.nth(i).boundingBox();
        if (
          field &&
          field.x < box.x + box.width &&
          field.x + field.width > box.x &&
          field.y < box.y + box.height &&
          field.y + field.height > box.y
        )
          throw new WorkerError(
            "CHALLENGE_UNAVAILABLE",
            "The challenge overlaps protected fields. Use Take control.",
            409,
          );
      }
    }
    const image = await this.page.screenshot({
      type: "png",
      scale: "css",
      clip: box,
      timeout: 8000,
    });
    if (image.length > 1024 * 1024)
      throw new WorkerError("CHALLENGE_TOO_LARGE", "The challenge image exceeds the limit.", 413);
    return { root, box, image, hash: createHash("sha256").update(image).digest("hex") };
  }
  async execute(raw: unknown, guard: () => void, protect: (selectors: string[]) => Promise<void>) {
    const plan = captchaPlanSchema.parse(raw);
    guard();
    await protect(plan.sensitiveSelectors);
    if (new URL(this.page.url()).origin !== plan.origin)
      throw new WorkerError(
        "CHALLENGE_ORIGIN_CHANGED",
        "The verification page changed origin.",
        409,
      );
    const success = this.page.locator(plan.authenticatedSelector);
    if ((await success.count()) === 1 && (await success.isVisible())) {
      this.frames.delete(plan.challengeId);
      return { status: "authenticated" as const };
    }
    if (plan.action.action === "help") return { status: "manual_required" as const };
    if (plan.action.action === "check") return { status: "pending" as const };
    if (Date.now() >= plan.expiresAt)
      throw new WorkerError(
        "CHALLENGE_BUDGET_EXHAUSTED",
        "The agent attempt window ended. Use Take control.",
        409,
      );
    const current = await this.region(plan);
    if (plan.action.action === "observe") {
      const candidates = current.root.locator(
        'button,input:not([type="hidden"]),select,a,[role="button"],[role="checkbox"]',
      );
      const nodes: Frame["nodes"] = [],
        elements: { number: number; label: string; type: string }[] = [];
      for (let i = 0; i < Math.min(await candidates.count(), 80); i++) {
        const node = candidates.nth(i);
        if (!(await node.isVisible())) continue;
        const type = (await node.getAttribute("type")) ?? "";
        if (
          type === "password" ||
          (await node.getAttribute("data-openmuse-credential-sensitive")) !== null
        )
          continue;
        const handle = await node.elementHandle();
        if (!handle) continue;
        nodes.push({ locator: node, handle });
        elements.push({
          number: nodes.length,
          label: (
            (await node.getAttribute("aria-label")) ||
            (await node.textContent()) ||
            type
          ).slice(0, 200),
          type,
        });
      }
      const id = randomUUID();
      // Keep one current observation per logical challenge; pixels themselves
      // leave via the owner's asset route and never enter a task journal.
      this.frames.clear();
      this.frames.set(plan.challengeId, {
        id,
        url: this.page.url(),
        hash: current.hash,
        box: current.box,
        nodes,
        expiresAt: plan.expiresAt,
      });
      return {
        status: "pending" as const,
        frameId: id,
        elements,
        image: current.image.toString("base64"),
        mimeType: "image/png",
        width: current.image.readUInt32BE(16),
        height: current.image.readUInt32BE(20),
        observedAt: new Date().toISOString(),
      };
    }
    const frame = this.frames.get(plan.challengeId);
    if (
      !frame ||
      frame.id !== plan.action.frameId ||
      frame.url !== this.page.url() ||
      frame.hash !== current.hash ||
      JSON.stringify(frame.box) !== JSON.stringify(current.box) ||
      Date.now() >= frame.expiresAt
    )
      throw new WorkerError(
        "STALE_CHALLENGE_FRAME",
        "The challenge changed. Observe it again before acting.",
        409,
      );
    let node: Locator | undefined;
    if ("element" in plan.action) {
      const observed = frame.nodes[plan.action.element - 1];
      if (
        observed &&
        (await observed.handle.evaluate((element) => element.isConnected)) &&
        (await observed.locator.evaluate(
          (element, original) => element === original,
          observed.handle,
        ))
      )
        node = observed.locator;
    }
    if (plan.action.action === "submit") {
      if (!plan.submitSelector)
        throw new WorkerError(
          "CHALLENGE_UNAVAILABLE",
          "This challenge has no configured submit control.",
          409,
        );
      node = this.page.locator(plan.submitSelector);
    }
    if (
      !["visual_click", "visual_drag"].includes(plan.action.action) &&
      (!node || (await node.count()) !== 1 || !(await node.isVisible()))
    )
      throw new WorkerError("STALE_CHALLENGE_FRAME", "The challenge control changed.", 409);
    if (node && money.test(`${await node.textContent()} ${await node.getAttribute("aria-label")}`))
      throw new WorkerError(
        "PAYMENT_APPROVAL_REQUIRED",
        "Financial controls cannot be used as CAPTCHA controls.",
        409,
      );
    if (
      plan.action.action === "click" &&
      plan.submitSelector &&
      node &&
      (await node.evaluate(
        (element, selector) => element.matches(selector) || Boolean(element.closest(selector)),
        plan.submitSelector,
      ))
    )
      throw new WorkerError(
        "CHALLENGE_SUBMIT_REQUIRED",
        "Use the counted submit action for this control.",
        409,
      );
    const action = plan.action;
    let dispatched = false;
    try {
      if (action.action === "visual_click" || action.action === "visual_drag") {
        const point = {
          x: frame.box.x + Math.min(action.x, 0.999999) * frame.box.width,
          y: frame.box.y + Math.min(action.y, 0.999999) * frame.box.height,
        };
        const end =
          action.action === "visual_drag"
            ? {
                x: frame.box.x + Math.min(action.toX, 0.999999) * frame.box.width,
                y: frame.box.y + Math.min(action.toY, 0.999999) * frame.box.height,
              }
            : point;
        for (let i = 0; i <= 20; i++) {
          const checkPoint = {
            x: point.x + ((end.x - point.x) * i) / 20,
            y: point.y + ((end.y - point.y) * i) / 20,
          };
          const safe = await this.page.evaluate(
            ({ point, selector, submit }) => {
              const target = document.elementFromPoint(point.x, point.y);
              const root = document.querySelector(selector);
              const control = target?.closest('button,input,a,[role="button"]') ?? target;
              return {
                inside: Boolean(
                  target &&
                    root?.contains(target) &&
                    !target.closest('[data-openmuse-credential-sensitive],input[type="password"]'),
                ),
                submit: Boolean(submit && target?.closest(submit)),
                label:
                  `${control?.textContent ?? ""} ${control?.getAttribute("aria-label") ?? ""}`.slice(
                    0,
                    500,
                  ),
              };
            },
            { point: checkPoint, selector: plan.selector, submit: plan.submitSelector },
          );
          if (!safe.inside || safe.submit || money.test(safe.label))
            throw new WorkerError(
              "CHALLENGE_TARGET_DENIED",
              "Choose a challenge control; use submit for the final answer.",
              409,
            );
        }
        guard();
        if (Date.now() >= plan.expiresAt)
          throw new WorkerError("CHALLENGE_BUDGET_EXHAUSTED", "Attempt window ended.", 409);
        this.frames.delete(plan.challengeId);
        if (action.action === "visual_click") {
          dispatched = true;
          await this.page.mouse.click(point.x, point.y);
        } else {
          await this.page.mouse.move(point.x, point.y);
          dispatched = true;
          await this.page.mouse.down();
          try {
            for (let i = 1; i <= 20; i++) {
              guard();
              if (Date.now() >= plan.expiresAt)
                throw new WorkerError(
                  "CHALLENGE_BUDGET_EXHAUSTED",
                  "Attempt window ended during gesture.",
                  409,
                );
              await this.page.mouse.move(
                point.x + ((end.x - point.x) * i) / 20,
                point.y + ((end.y - point.y) * i) / 20,
              );
            }
          } finally {
            await this.page.mouse.up();
          }
        }
      } else {
        guard();
        if (Date.now() >= plan.expiresAt)
          throw new WorkerError("CHALLENGE_BUDGET_EXHAUSTED", "Attempt window ended.", 409);
        this.frames.delete(plan.challengeId);
        dispatched = true;
        if (action.action === "fill") await node!.fill(action.value, { timeout: 8000 });
        else await node!.click({ timeout: 8000 });
      }
      guard();
      return {
        status:
          (await success.count()) === 1 && (await success.isVisible())
            ? ("authenticated" as const)
            : ("pending" as const),
      };
    } catch (error) {
      if (dispatched)
        throw new WorkerError(
          "OUTCOME_UNKNOWN",
          "The verification input may have reached the page. Inspect it before retrying.",
          409,
        );
      throw error;
    }
  }
}
