import { z } from "zod";
import { WorkerError } from "./errors.ts";

const trustedOrigin = z
  .string()
  .url()
  .refine((value) => safeOrigin(value));
export const credentialLoginInputSchema = z
  .object({
    adapterId: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z][\w.-]*$/),
    origin: trustedOrigin,
    allowedRedirectOrigins: z.array(trustedOrigin).min(1).max(9),
    frameId: z.uuid().optional(),
    fields: z
      .array(
        z
          .object({ selector: z.string().trim().min(1).max(500), value: z.string().max(4096) })
          .strict(),
      )
      .min(1)
      .max(8),
    sensitiveSelectors: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
    submitSelector: z.string().trim().min(1).max(500),
    authenticatedSelector: z.string().trim().min(1).max(500).optional(),
    invalidCredentialsSelector: z.string().trim().min(1).max(500).optional(),
    challenge: z
      .object({
        id: z.uuid(),
        kind: z.enum(["totp", "otp", "push", "captcha", "webauthn", "unknown"]),
        submitSelector: z.string().trim().min(1).max(500).optional(),
      })
      .strict()
      .optional(),
    challengeSelectors: z
      .array(
        z
          .object({
            kind: z.enum(["totp", "otp", "push", "captcha", "webauthn", "unknown"]),
            selector: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .max(8)
      .default([]),
  })
  .strict();
export type CredentialLoginInput = z.infer<typeof credentialLoginInputSchema>;

type CredentialLocator = {
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  click(options?: { timeout?: number }): Promise<void>;
};
type CredentialRoute = {
  request(): { isNavigationRequest(): boolean; url(): string; method(): string };
  abort(reason?: string): Promise<void>;
  fallback(): Promise<void>;
};
export type CredentialPage = {
  url(): string;
  locator(selector: string): CredentialLocator;
  evaluate<T, A>(operation: (args: A) => T, args: A): Promise<T>;
  route(pattern: string, handler: (route: CredentialRoute) => Promise<void>): Promise<unknown>;
  unroute(pattern: string, handler: (route: CredentialRoute) => Promise<void>): Promise<unknown>;
  waitForLoadState?(state: "domcontentloaded", options?: { timeout?: number }): Promise<void>;
  waitForTimeout?(milliseconds: number): Promise<void>;
};

export type CredentialLoginResult = {
  status: "authenticated" | "manual_required" | "challenge" | "failed" | "outcome_unknown";
  origin: string;
  sessionId: string;
  sessionGeneration?: string;
  reasonCode?: string;
  challengeKind?: "totp" | "otp" | "push" | "captcha" | "webauthn" | "unknown";
  challengeId?: string;
};

const safeOrigin = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
  } catch {
    return false;
  }
};

/**
 * Fills only operator-configured controls on their declared origin. Values are
 * used only in Playwright fill calls and never appear in the returned receipt.
 */
export async function credentialLogin(
  page: CredentialPage,
  input: CredentialLoginInput,
  options: {
    sessionId: string;
    sessionGeneration?: string;
    guard?: () => void;
    protect: (selectors: string[], suspended: boolean) => Promise<void>;
  },
): Promise<CredentialLoginResult> {
  const result = (
    status: CredentialLoginResult["status"],
    reasonCode?: string,
    challengeKind?: CredentialLoginResult["challengeKind"],
  ): CredentialLoginResult => ({
    status,
    origin: input.origin,
    sessionId: options.sessionId,
    ...(options.sessionGeneration ? { sessionGeneration: options.sessionGeneration } : {}),
    ...(reasonCode ? { reasonCode } : {}),
    ...(challengeKind ? { challengeKind } : {}),
    ...(input.challenge ? { challengeId: input.challenge.id } : {}),
  });
  if (
    !safeOrigin(input.origin) ||
    !input.allowedRedirectOrigins.every(safeOrigin) ||
    !input.allowedRedirectOrigins.includes(input.origin) ||
    input.fields.length < 1 ||
    input.fields.length > 8 ||
    input.fields.some(
      (field) =>
        !field.selector.trim() ||
        field.selector.length > 500 ||
        typeof field.value !== "string" ||
        field.value.length > 4096,
    ) ||
    !input.sensitiveSelectors.length ||
    input.sensitiveSelectors.some((selector) => !selector.trim() || selector.length > 500) ||
    new Set(input.fields.map((field) => field.selector)).size !== input.fields.length ||
    !input.fields.every((field) => input.sensitiveSelectors.includes(field.selector))
  )
    throw new WorkerError("INVALID_CREDENTIAL_ADAPTER", "Trusted login adapter is invalid.", 422);

  if (
    input.challenge &&
    (!["otp", "totp"].includes(input.challenge.kind) ||
      input.fields.length !== 1 ||
      !input.challenge.submitSelector ||
      input.challenge.submitSelector !== input.submitSelector ||
      !input.challengeSelectors.some(
        ({ kind, selector }) =>
          ["otp", "totp"].includes(kind) && selector === input.fields[0]?.selector,
      ))
  )
    throw new WorkerError("INVALID_CREDENTIAL_CHALLENGE", "Trusted challenge is invalid.", 422);

  const allowedOrigins = new Set(input.allowedRedirectOrigins);
  const initial = new URL(page.url());
  if (initial.protocol !== "https:" || initial.origin !== input.origin)
    return result("manual_required", "ORIGIN_MISMATCH");

  // A stored credential reference is not a login receipt. If the fixed success
  // signal is already visible, however, the current browser profile is proven
  // authenticated and no secret needs to be re-entered.
  if (
    input.authenticatedSelector &&
    (await page.locator(input.authenticatedSelector).count()) > 0 &&
    (await page.locator(input.authenticatedSelector).isVisible())
  )
    return result("authenticated");

  // Keep masks active even after the one-use login operation ends. During fill
  // and submit, no page observation is allowed at all.
  await options.protect(input.sensitiveSelectors, true);
  const redirectGuard = async (route: CredentialRoute) => {
    let origin: string;
    try {
      const url = new URL(route.request().url());
      origin = url.protocol === "https:" ? url.origin : "";
    } catch {
      origin = "";
    }
    const method = route.request().method().toUpperCase();
    // While a secret is on the page, every request stays inside the reviewed
    // origin set. In particular, a page script cannot beacon a filled value
    // to a third-party host before the protected operation is released.
    if (!allowedOrigins.has(origin) || !["GET", "HEAD", "OPTIONS", "POST"].includes(method))
      await route.abort("blockedbyclient");
    else await route.fallback();
  };

  let submitted = false;
  let protectionReleased = false;
  const releaseObservation = async (selectors = input.sensitiveSelectors) => {
    if (protectionReleased) return;
    protectionReleased = true;
    await options.protect(selectors, false);
  };
  try {
    const submitLocator = page.locator(input.submitSelector);
    const submitCount = await submitLocator.count();
    const fullForm = await page
      .evaluate(
        (selectors: unknown) => {
          const value = selectors as { fields: string[]; submit: string };
          const getOne = (selector: string) => {
            try {
              const matches = document.querySelectorAll(selector);
              return matches.length === 1 ? matches[0] : null;
            } catch {
              return null;
            }
          };
          const fields = value.fields.map(getOne);
          const submit = getOne(value.submit) as HTMLButtonElement | HTMLInputElement | null;
          const owner = fields[0] && (fields[0] as HTMLInputElement).form;
          if (
            !owner ||
            fields.some(
              (field) =>
                !field ||
                (field as HTMLInputElement).form !== owner ||
                !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement),
            ) ||
            !submit ||
            submit.form !== owner ||
            !(submit instanceof HTMLButtonElement || submit instanceof HTMLInputElement) ||
            (submit instanceof HTMLButtonElement && submit.type !== "submit") ||
            (submit instanceof HTMLInputElement && !["submit", "image"].includes(submit.type))
          )
            return { ready: false as const };
          const action = new URL(owner.action || location.href, location.href);
          const submitAction = submit.hasAttribute("formaction") ? submit.formAction : action.href;
          const effectiveAction = new URL(submitAction, location.href);
          const method = (
            submit.hasAttribute("formmethod") ? submit.formMethod : owner.method
          ).toLowerCase();
          const target = (submit.hasAttribute("formtarget") ? submit.formTarget : owner.target)
            .trim()
            .toLowerCase();
          return {
            ready:
              method === "post" &&
              (target === "" || target === "_self") &&
              effectiveAction.protocol === "https:",
            actionOrigin: effectiveAction.origin,
          };
        },
        { fields: input.fields.map((field) => field.selector), submit: input.submitSelector },
      )
      .catch(() => ({ ready: false as const }));
    if (
      !fullForm.ready ||
      !allowedOrigins.has("actionOrigin" in fullForm ? fullForm.actionOrigin : "") ||
      submitCount !== 1 ||
      !(await submitLocator.isVisible()) ||
      !(await submitLocator.isEnabled())
    ) {
      await releaseObservation();
      return result("manual_required", "LOGIN_FORM_UNAVAILABLE");
    }
    await page.route("**/*", redirectGuard);
    for (const field of input.fields) {
      options.guard?.();
      const locator = page.locator(field.selector);
      if (
        (await locator.count()) !== 1 ||
        !(await locator.isVisible()) ||
        !(await locator.isEnabled())
      ) {
        await releaseObservation();
        return result("manual_required", "LOGIN_FIELD_UNAVAILABLE");
      }
      await locator.fill(field.value, { timeout: 8000 });
    }
    options.guard?.();
    submitted = true;
    await submitLocator.click({ timeout: 8000 });
    await page.waitForLoadState?.("domcontentloaded", { timeout: 12_000 }).catch(() => {});
    await page.waitForTimeout?.(1500);
    options.guard?.();
    let finalOrigin: string;
    try {
      const finalUrl = new URL(page.url());
      finalOrigin = finalUrl.protocol === "https:" ? finalUrl.origin : "";
    } catch {
      finalOrigin = "";
    }
    if (!allowedOrigins.has(finalOrigin)) {
      await releaseObservation();
      return result("outcome_unknown", "REDIRECT_NOT_ALLOWED");
    }
    for (const { selector, kind } of input.challengeSelectors) {
      if (
        (await page.locator(selector).count()) > 0 &&
        (await page.locator(selector).isVisible())
      ) {
        const protectedSelectors = [
          ...input.sensitiveSelectors,
          ...(["otp", "totp"].includes(kind) ? [selector] : []),
        ];
        await releaseObservation(protectedSelectors);
        return result("challenge", undefined, kind === "totp" ? "otp" : kind);
      }
    }
    if (
      input.invalidCredentialsSelector &&
      (await page.locator(input.invalidCredentialsSelector).count()) > 0 &&
      (await page.locator(input.invalidCredentialsSelector).isVisible())
    ) {
      await releaseObservation();
      return result("failed", "INVALID_CREDENTIALS");
    }
    if (
      input.authenticatedSelector &&
      (await page.locator(input.authenticatedSelector).count()) > 0 &&
      (await page.locator(input.authenticatedSelector).isVisible())
    ) {
      await releaseObservation();
      return result("authenticated");
    }
    await releaseObservation();
    return result("outcome_unknown", "AUTHENTICATION_UNCONFIRMED");
  } catch {
    await releaseObservation().catch(() => {});
    return submitted
      ? result("outcome_unknown", "SUBMIT_UNCONFIRMED")
      : result("manual_required", "LOGIN_FORM_UNAVAILABLE");
  } finally {
    await page.unroute("**/*", redirectGuard).catch(() => {});
  }
}
