import { createHash, randomUUID } from "node:crypto";
import type { ElementHandle, Frame, Page } from "playwright";
import { WorkerError } from "./errors.ts";

export type BrowserAction =
  | { snapshotId: string; element: number; action: "click" }
  | { snapshotId: string; element: number; action: "fill"; value: string }
  | { snapshotId: string; element: number; action: "select"; value: string }
  | { snapshotId: string; element: number; action: "press"; key: string }
  | { snapshotId: string; element: number; action: "scroll"; deltaY: number };
export const PRESS_KEYS =
  /^(Enter|Space|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Control\+a|Meta\+a|Shift\+Tab)$/;
export function browserAction(value: Record<string, unknown>): BrowserAction {
  const { snapshotId, element, action } = value;
  const allowed = [
    "snapshotId",
    "element",
    "action",
    action === "press" ? "key" : action === "scroll" ? "deltaY" : "value",
  ];
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    typeof snapshotId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(snapshotId) ||
    typeof element !== "number" ||
    !Number.isInteger(element) ||
    element < 1 ||
    element > 150
  )
    throw new WorkerError(
      "INVALID_ACTION",
      "Use a current snapshot ID and numbered element; unsupported arguments are rejected.",
    );
  if (action === "click") return { snapshotId, element, action };
  if (
    (action === "fill" || action === "select") &&
    typeof value.value === "string" &&
    value.value.length <= 10_000
  )
    return { snapshotId, element, action, value: value.value };
  if (action === "press" && typeof value.key === "string" && PRESS_KEYS.test(value.key))
    return { snapshotId, element, action, key: value.key };
  if (
    action === "scroll" &&
    typeof value.deltaY === "number" &&
    Number.isFinite(value.deltaY) &&
    Math.abs(value.deltaY) <= 5000
  )
    return { snapshotId, element, action, deltaY: value.deltaY };
  throw new WorkerError("INVALID_ACTION", "Unsupported browser action, value or key.");
}

/** A heuristic guard, evaluated against actual DOM controls, including form submission. */
export function paymentLabel(label: string) {
  const normalized = label.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  return /\b(pay(?:ment)?|checkout|check out|purchase|buy(?: now)?|place order|confirm (?:order|purchase|payment)|send money|transfer money|pagar|pagamento|comprar|finalizar (?:compra|pedido)|confirmar (?:compra|pedido|pagamento)|transferir|enviar dinheiro|bezahlen|zahlung|kaufen|bestellen|bestellung (?:bestatigen|abschlie[ßs]en)|zahlungspflichtig|uberweisen|geld senden)\b/.test(
    normalized,
  );
}

function details(node: Element) {
  const input = node as HTMLInputElement;
  const tag = node.tagName.toLowerCase();
  // Keep this function self-contained: Playwright serializes it into every frame.
  // The same resolver names snapshots, fingerprints and associated submitters.
  function accessibleName(control: Element): string {
    const field = control as HTMLInputElement;
    const root = control.getRootNode() as Document | ShadowRoot;
    const references = control
      .getAttribute("aria-labelledby")
      ?.split(/\s+/)
      .map(
        (id) =>
          (typeof root.getElementById === "function"
            ? root.getElementById(id)
            : control.ownerDocument.getElementById(id)
          )?.textContent ?? "",
      )
      .join(" ")
      .trim();
    return (
      references ||
      control.getAttribute("aria-label") ||
      (field.labels
        ? Array.from(field.labels)
            .map((label) => label.textContent)
            .join(" ")
        : "") ||
      control.getAttribute("title") ||
      control.getAttribute("placeholder") ||
      (control as HTMLElement).innerText ||
      (control.tagName === "INPUT" && ["submit", "button", "reset"].includes(field.type)
        ? field.value
        : "") ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
  }
  const label = accessibleName(node);
  const form = input.form;
  return {
    tag,
    role: node.getAttribute("role") || tag,
    type: tag === "input" ? input.type : undefined,
    label,
    href: node.getAttribute("href") || undefined,
    disabled: input.disabled === true || node.getAttribute("aria-disabled") === "true",
    form: form
      ? `${form.id}|${form.getAttribute("action")}|${form.getAttribute("method")}`
      : undefined,
    value:
      tag === "input" && input.type === "password"
        ? undefined
        : ["input", "textarea", "select"].includes(tag)
          ? input.value.slice(0, 1000)
          : undefined,
    options:
      tag === "select"
        ? Array.from((node as HTMLSelectElement).options)
            .slice(0, 100)
            .map((o) => ({ value: o.value.slice(0, 1000), label: o.text.slice(0, 300) }))
        : undefined,
    connected: node.isConnected,
    submitterLabels: form
      ? Array.from(form.querySelectorAll('button,input[type="submit"]'))
          .map(accessibleName)
          .join(" ")
          .slice(0, 10_000)
      : "",
    formText: form?.innerText.slice(0, 10_000) ?? "",
    submits: Boolean(
      form && (input.type === "submit" || (tag === "button" && input.type !== "button")),
    ),
  };
}
type Details = ReturnType<typeof details>;
function fingerprint(value: Details) {
  const { value: _value, formText: _formText, ...identity } = value;
  return JSON.stringify(identity);
}
type Target = {
  handle: ElementHandle;
  fingerprint: string;
  document: ElementHandle;
  frameUrl: string;
  frame: Frame;
};

/** Fixed Playwright DOM operations. The browser manager owns network guards and its queue. */
export class AgentPage {
  private snapshotId?: string;
  private url?: string;
  private targets = new Map<number, Target>();
  private readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }
  async invalidate() {
    this.snapshotId = undefined;
    const targets = [...this.targets.values()];
    this.targets.clear();
    await Promise.allSettled(targets.flatMap((t) => [t.handle.dispose(), t.document.dispose()]));
  }
  async snapshot() {
    await this.invalidate();
    const snapshotId = randomUUID();
    const elements = [];
    let truncatedElements = false;
    const selector =
      'a[href],button,input:not([type="hidden"]),select,textarea,[contenteditable="true"],[role="button"],[role="link"],[role="checkbox"],[role="textbox"],[role="combobox"],[role="radio"],[role="tab"],[role="menuitem"],[role="slider"],[role="spinbutton"],[tabindex]:not([tabindex="-1"])';
    for (const frame of this.page.frames()) {
      if (frame !== this.page.mainFrame()) {
        const frameElement = await frame.frameElement().catch(() => undefined);
        const visible = frameElement && (await frameElement.isVisible());
        await frameElement?.dispose();
        if (!visible) continue;
      }
      const handles = await frame.$$(selector);
      for (const handle of handles) {
        if (!(await handle.isVisible())) {
          await handle.dispose();
          continue;
        }
        if (elements.length >= 150) {
          truncatedElements = true;
          await handle.dispose();
          continue;
        }
        const value = await handle.evaluate(details);
        const document = await frame.$("html");
        if (!document) {
          await handle.dispose();
          continue;
        }
        const number: number = elements.length + 1;
        this.targets.set(number, {
          handle,
          document,
          frameUrl: frame.url(),
          frame,
          fingerprint: fingerprint(value),
        });
        const {
          connected: _connected,
          form: _form,
          submitterLabels: _submitters,
          formText: _formText,
          submits: _submits,
          ...safe
        } = value;
        elements.push({ number, ...safe, frameUrl: frame.url() });
      }
    }
    const page = await this.page.evaluate(() => ({
      url: location.href,
      title: document.title.slice(0, 300),
      text: (document.body?.innerText ?? "").slice(0, 30_000),
      truncated: (document.body?.innerText.length ?? 0) > 30_000,
    }));
    this.snapshotId = snapshotId;
    this.url = page.url;
    return { ...page, snapshotId, elements, truncatedElements };
  }
  async inspect(action: BrowserAction) {
    const target = this.targets.get(action.element);
    const stale = () =>
      new WorkerError(
        "STALE_SNAPSHOT",
        "The page or numbered element changed. Take a fresh snapshot before acting.",
        409,
      );
    if (
      !target ||
      action.snapshotId !== this.snapshotId ||
      this.url !== this.page.url() ||
      target.frame.isDetached() ||
      target.frame.url() !== target.frameUrl
    )
      throw stale();
    try {
      if (
        !(await target.document.evaluate((node) => node === document.documentElement)) ||
        !(await target.handle.isVisible()) ||
        !(await target.handle.isEnabled())
      )
        throw stale();
      const live = await target.handle.evaluate(details);
      if (!live.connected || fingerprint(live) !== target.fingerprint) throw stale();
      const activates =
        action.action === "click" ||
        (action.action === "press" && ["Enter", "Space"].includes(action.key));
      const submits =
        live.submits || (action.action === "press" && action.key === "Enter" && Boolean(live.form));
      const payment = activates
        ? `${live.label} ${submits ? live.submitterLabels : ""} ${submits ? live.formText : ""}`
        : "";
      // Bind form values internally to prevent quantity/amount/payee changes after review.
      const formState = await target.handle.evaluate((node) => {
        const form = (node as HTMLInputElement).form;
        return JSON.stringify(
          form
            ? Array.from(form.elements).map((e) => {
                const field = e as HTMLInputElement;
                return [
                  field.name,
                  field.type,
                  field.type === "password" ? "<redacted>" : field.value,
                  field.checked,
                ];
              })
            : [],
        );
      });
      const pageDigest = createHash("sha256")
        .update(await this.page.evaluate(() => (document.body?.innerText ?? "").slice(0, 100_000)))
        .digest("hex");
      const finalIdentity = await target.handle.evaluate(details);
      if (
        !finalIdentity.connected ||
        fingerprint(finalIdentity) !== target.fingerprint ||
        this.page.url() !== this.url ||
        target.frame.isDetached() ||
        target.frame.url() !== target.frameUrl
      )
        throw stale();
      return {
        target,
        live,
        requiresApproval: paymentLabel(payment),
        binding: {
          snapshotId: action.snapshotId,
          element: action.element,
          action,
          url: this.url,
          frameUrl: target.frameUrl,
          fingerprint: target.fingerprint,
          formDigest: createHash("sha256").update(formState).digest("hex"),
          pageDigest,
        },
      };
    } catch (error) {
      if (error instanceof WorkerError) throw error;
      throw stale();
    }
  }
  async act(action: BrowserAction, guard: () => void) {
    const inspected = await this.inspect(action);
    if (inspected.requiresApproval)
      throw new WorkerError(
        "PAYMENT_APPROVAL_REQUIRED",
        "This control may pay, buy or transfer money. Native approval is required before proceeding.",
        409,
        inspected.binding,
      );
    guard();
    if (
      action.snapshotId !== this.snapshotId ||
      inspected.target.frame.isDetached() ||
      inspected.target.frame.url() !== inspected.target.frameUrl ||
      this.page.url() !== this.url
    )
      throw new WorkerError(
        "STALE_SNAPSHOT",
        "The page or target frame changed before dispatch. Take a fresh snapshot.",
        409,
      );
    const { handle } = inspected.target;
    // Invalidate before dispatch: a timed-out action may already have changed the page.
    this.snapshotId = undefined;
    try {
      if (action.action === "click") await handle.click({ timeout: 10_000 });
      else if (action.action === "fill") await handle.fill(action.value, { timeout: 10_000 });
      else if (action.action === "select")
        await handle.selectOption(action.value, { timeout: 10_000 });
      else if (action.action === "press") await handle.press(action.key, { timeout: 10_000 });
      else {
        await handle.hover();
        guard();
        await this.page.mouse.wheel(0, action.deltaY);
      }
    } finally {
      await this.invalidate();
    }
  }
}
