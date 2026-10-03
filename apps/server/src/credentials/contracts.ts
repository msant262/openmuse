import { z } from "zod";

const adapterId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z][\w.-]*$/);
const originSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
}, "Credential adapters require an exact HTTPS origin");

export const credentialFieldSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z][\w-]*$/),
    label: z.string().trim().min(1).max(160),
    type: z.enum(["text", "password"]),
    required: z.boolean().default(true),
  })
  .strict();
export type CredentialField = z.infer<typeof credentialFieldSchema>;

export const credentialAdapterSchema = z
  .object({
    id: adapterId,
    serviceName: z.string().trim().min(1).max(120),
    origin: originSchema,
    loginUrl: z
      .url()
      .optional()
      .refine((value) => {
        if (!value) return true;
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password && !url.hash;
      }, "Credential login URLs must be HTTPS without embedded credentials or fragments"),
    allowedRedirectOrigins: z.array(originSchema).max(8).default([]),
    fields: z.array(credentialFieldSchema).min(1).max(8),
    selectors: z.record(z.string(), z.string().trim().min(1).max(500)),
    submitSelector: z.string().trim().min(1).max(500),
    challengeSubmitSelector: z.string().trim().min(1).max(500).optional(),
    authenticatedSelector: z.string().trim().min(1).max(500).optional(),
    invalidCredentialsSelector: z.string().trim().min(1).max(500).optional(),
    challengeSelectors: z
      .object({
        captcha: z.string().trim().min(1).max(500).optional(),
        otp: z.string().trim().min(1).max(500).optional(),
        passkey: z.string().trim().min(1).max(500).optional(),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((adapter, context) => {
    if (adapter.loginUrl && new URL(adapter.loginUrl).origin !== adapter.origin)
      context.addIssue({
        code: "custom",
        message: "The fixed login URL must use the adapter origin",
      });
    const ids = adapter.fields.map((field) => field.id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: "custom", message: "Credential field IDs must be unique" });
    if (ids.some((id) => !adapter.selectors[id]))
      context.addIssue({
        code: "custom",
        message: "Every credential field needs a trusted selector",
      });
    if (Object.keys(adapter.selectors).some((id) => !ids.includes(id)))
      context.addIssue({ code: "custom", message: "Selectors may only target declared fields" });
    if (adapter.challengeSelectors.otp && !adapter.challengeSubmitSelector)
      context.addIssue({
        code: "custom",
        message: "OTP adapters need a fixed challenge submit selector",
      });
  });
export type CredentialAdapter = z.input<typeof credentialAdapterSchema>;
export type ValidCredentialAdapter = z.output<typeof credentialAdapterSchema>;

export type CredentialStatus =
  | "saved"
  | "connecting"
  | "connected"
  | "needs_challenge"
  | "invalid_credentials"
  | "outcome_unknown"
  | "error";
export type CredentialRef = { id: string; version: number };
export type CredentialFormSchema = {
  title: string;
  serviceName: string;
  origin: string;
  purpose: string;
  fields: CredentialField[];
};
export type CredentialRequestRecord = {
  id: string;
  taskId: string;
  revision: number;
  threadId?: string;
  adapterId: string;
  purpose: string;
  credentialRefId: string;
  status:
    | "waiting"
    | "saving"
    | "saved"
    | "connecting"
    | "connected"
    | "needs_challenge"
    | "invalid_credentials"
    | "error"
    | "expired"
    | "superseded"
    | "outcome_unknown";
  createdAt: string;
  expiresAt: string;
  clientResponseId?: string;
  credentialRef?: CredentialRef;
  challengeId?: string;
  challengeKind?: "totp" | "otp" | "push" | "captcha" | "webauthn" | "unknown";
};
export type CredentialConnection = {
  id: string;
  adapterId: string;
  serviceName: string;
  origin: string;
  credentialRef: CredentialRef;
  status: CredentialStatus;
  updatedAt: string;
  lastAuthenticatedAt?: string;
  challengeId?: string;
  challengeKind?: "totp" | "otp" | "push" | "captcha" | "webauthn" | "unknown";
};

export type CredentialChallenge = {
  id: string;
  taskRevision?: number;
  taskId: string;
  revision: number;
  credentialRefId: string;
  adapterId: string;
  origin: string;
  sessionId: string;
  sessionGeneration?: string;
  executorId?: string;
  profileId?: string;
  kind: "totp" | "otp" | "push" | "captcha" | "webauthn" | "unknown";
  status: "waiting" | "submitted" | "outcome_unknown" | "completed" | "expired" | "superseded";
  submissions: number;
  createdAt: string;
  expiresAt: string;
};
export type CredentialBrowserBinding = {
  id: string;
  credentialRefId: string;
  accountId: string;
  adapterId: string;
  origin: string;
  executorId: string;
  profileId: string;
  sessionId: string;
  sessionGeneration?: string;
  authenticatedAt: string;
};

export type SecretStore = {
  write(
    owner: string,
    id: string,
    data: Record<string, string>,
    expectedVersion: number,
  ): Promise<number>;
  read(
    owner: string,
    id: string,
  ): Promise<{ version: number; data: Record<string, string> } | null>;
  delete(owner: string, id: string, expectedVersion?: number): Promise<void>;
};
