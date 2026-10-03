import { z } from "zod";
import type { NativeDesktopSession } from "./desktop-contract.ts";

/** Server-only fixed-adapter input. No HTTP/model schema exports these values. */
export type TrustedCredentialInput = {
  origin: string;
  adapterId: string;
  frameId?: string;
  fields: { selector: string; value: string }[];
  sensitiveSelectors: string[];
  allowedRedirectOrigins: string[];
  submitSelector: string;
  authenticatedSelector?: string;
  invalidCredentialsSelector?: string;
  challengeSelectors: {
    kind: "totp" | "otp" | "push" | "captcha" | "webauthn" | "unknown";
    selector: string;
  }[];
  challenge?: {
    id: string;
    kind: "totp" | "otp" | "push" | "captcha" | "webauthn" | "unknown";
    submitSelector?: string;
  };
};
/** Native vault values are resolved only by the authenticated one-use consume
 * endpoint, after the exact physical operation has been claimed. */
export type NativeCredentialPlan = Omit<TrustedCredentialInput, "fields"> & {
  credentialRefId: string;
  taskId: string;
  revision: number;
};
export const trustedCredentialResultSchema = z
  .object({
    status: z.enum(["authenticated", "manual_required", "challenge", "failed", "outcome_unknown"]),
    origin: z.string().url(),
    sessionId: z.uuid(),
    sessionGeneration: z.string().min(1).max(128).optional(),
    executorId: z.string().max(64).optional(),
    profileId: z.string().max(64).optional(),
    reasonCode: z
      .string()
      .regex(/^[A-Z0-9_]{1,80}$/)
      .optional(),
    challengeKind: z.enum(["totp", "otp", "push", "captcha", "webauthn", "unknown"]).optional(),
    challengeId: z.uuid().optional(),
  })
  .strict();
export type TrustedCredentialResult = z.infer<typeof trustedCredentialResultSchema>;
/** Native implementation must protect before filling and retain masks after
 * cleanup. Ephemeral field bytes use out-of-band transport, never native args. */
export type NativeCredentialInjector = (
  owner: string,
  session: NativeDesktopSession,
  input: NativeCredentialPlan,
  signal?: AbortSignal,
) => Promise<TrustedCredentialResult>;
