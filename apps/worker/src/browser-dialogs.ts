import { randomUUID } from "node:crypto";
import type { Dialog, Page } from "playwright";
import type { z } from "zod";
import type { browserDialogInputSchema } from "../../../packages/domain/src/browser-dialog.ts";
import { paymentLabel } from "./agent-page.ts";
import { WorkerError } from "./errors.ts";

/** A JS dialog suspends the renderer. Never evaluate/snapshot its DOM while
 * pending, and never wait for the click to finish before returning the dialog. */
export class BrowserDialogs {
  private current?: { id: string; dialog: Dialog; opener: string };
  private opener = "";
  private inflight?: Promise<{ error?: unknown }>;
  private interruptedByDialog = false;
  private opened = new Set<() => void>();
  private readonly redact: (text: string) => string;
  constructor(page: Page, redact: (text: string) => string, invalidate: () => void) {
    this.redact = redact;
    page.on("dialog", (dialog) => {
      if (this.inflight) this.interruptedByDialog = true;
      this.current = { id: randomUUID(), dialog, opener: this.opener };
      invalidate();
      for (const resolve of this.opened) resolve();
    });
  }
  setOpener(label: string) {
    this.opener = label;
  }
  get pending() {
    return Boolean(this.current);
  }
  async observe<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (this.pending) return undefined;
    let resolve!: () => void;
    const opened = new Promise<undefined>((done) => {
      resolve = () => done(undefined);
      this.opened.add(resolve);
    });
    try {
      const value = await Promise.race([operation(), opened]);
      return this.pending ? undefined : value;
    } finally {
      this.opened.delete(resolve);
    }
  }
  observation() {
    if (!this.current) return undefined;
    const { id, dialog, opener } = this.current;
    const message = this.redact(dialog.message()),
      defaultValue = this.redact(dialog.defaultValue());
    const label = `${opener} ${dialog.message()}`
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase();
    return {
      id,
      type: dialog.type() as "alert" | "confirm" | "prompt" | "beforeunload",
      message: message.slice(0, 8192),
      defaultValue: defaultValue.slice(0, 1000),
      truncated: message.length > 8192 || defaultValue.length > 1000,
      requiresApproval:
        paymentLabel(label) ||
        /\b(delete|remove|erase|trash|destroy|excluir|apagar|remover|eliminar|deletar|loschen|entfernen)\b/.test(
          label,
        ),
    };
  }
  private async settle() {
    if (this.pending || !this.inflight) return;
    let resolve!: () => void;
    const opened = new Promise<void>((done) => {
      resolve = done;
      this.opened.add(done);
    });
    try {
      const result = await Promise.race([this.inflight, opened.then(() => undefined)]);
      // Playwright's click/navigation wait expires while a person reviews a
      // visible JS dialog. That timeout cannot undo the observed dispatch.
      // Only this exact timeout is discharged by a successful dialog response;
      // other failures remain uncertain, and the caller still reads the page.
      if (
        result?.error &&
        !(
          this.interruptedByDialog &&
          result.error instanceof Error &&
          result.error.name === "TimeoutError"
        )
      )
        throw result.error;
    } finally {
      this.opened.delete(resolve);
    }
  }
  async run(operation: () => Promise<unknown>) {
    this.opener = "";
    this.interruptedByDialog = false;
    const inflight = operation().then(
      () => ({}),
      (error: unknown) => ({ error }),
    );
    this.inflight = inflight;
    await this.settle();
    if (!this.pending) this.inflight = undefined;
  }
  async respond(
    input: z.output<typeof browserDialogInputSchema>,
    guard: () => void,
    reviewed = false,
  ) {
    const current = this.current;
    if (!current || current.id !== input.dialogId)
      throw new WorkerError(
        "STALE_DIALOG",
        "This dialog is no longer pending. Read a fresh browser snapshot.",
        409,
      );
    if (input.promptText !== undefined && (!input.accept || current.dialog.type() !== "prompt"))
      throw new WorkerError(
        "INVALID_DIALOG",
        "Text is accepted only when confirming a prompt dialog.",
        422,
      );
    if (input.accept && this.observation()?.requiresApproval && !reviewed)
      throw new WorkerError(
        "DIALOG_APPROVAL_REQUIRED",
        "This dialog may delete content, pay or purchase. Review the exact dialog in the app before accepting.",
        409,
      );
    guard();
    this.current = undefined;
    try {
      if (input.accept) await current.dialog.accept(input.promptText);
      else await current.dialog.dismiss();
      await this.settle();
      if (!this.pending) this.inflight = undefined;
    } catch {
      throw new WorkerError(
        "OUTCOME_UNKNOWN",
        "The dialog response was dispatched but its result was not confirmed. Inspect the site before repeating an action.",
        409,
      );
    }
  }
}
