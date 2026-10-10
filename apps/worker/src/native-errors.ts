import { browserDiagnosticInspection } from "../../../packages/domain/src/browser-diagnostics.ts";
import { WorkerError } from "./errors.ts";

/** The pending-dialog guard runs before any page input/navigation. Other
 * mutable errors can follow dispatch and must retain their uncertainty. */
export function nativeBrowserFailure(request: unknown, error: unknown) {
  const pending = error instanceof WorkerError && error.code === "BROWSER_DIALOG_PENDING";
  const noInput = pending || browserDiagnosticInspection(request);
  return {
    message: pending
      ? "A browser dialog is pending. Read browser_snapshot and answer its exact dialogId before another page operation."
      : "Native browser operation failed",
    code: error instanceof WorkerError ? error.code : "BROWSER_FAILED",
    dispatched: !noInput,
    cleanupConfirmed: noInput,
  };
}
