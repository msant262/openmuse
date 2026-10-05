import { z } from "zod";
import { stickerIdSchema } from "./conversation-social.ts";
import type { ProactivitySuggestion } from "./proactivity.ts";

export const normalizedRegionSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().gt(0).max(1),
    height: z.number().gt(0).max(1),
  })
  .strict()
  .superRefine((region, ctx) => {
    if (region.x + region.width > 1 || region.y + region.height > 1)
      ctx.addIssue({ code: "custom", message: "Region must stay inside its source image" });
  });

export const runtimeId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\w.:-]+$/);
export const messageReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("message"),
      messageId: runtimeId,
      quote: z.string().max(8000).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("attachment"),
      attachmentId: runtimeId,
      version: z.string().max(256),
      quote: z.string().max(8000).optional(),
      region: normalizedRegionSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("frame"),
      frameId: runtimeId,
      sessionGeneration: z.uuid(),
      region: normalizedRegionSchema,
      snapshotArtifactId: runtimeId.optional(),
      snapshotVersion: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .strict()
    .superRefine((reference, ctx) => {
      if (Boolean(reference.snapshotArtifactId) !== Boolean(reference.snapshotVersion))
        ctx.addIssue({ code: "custom", message: "Frame snapshot ID and version must be paired" });
    }),
]);
export const acceptedMessageSchema = z
  .object({
    threadId: runtimeId.regex(/^[\w.-]+$/),
    clientMessageId: runtimeId,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    text: z.string().trim().min(1).max(24000),
    attachmentIds: z.array(runtimeId).max(30).default([]),
    targetTaskId: runtimeId.optional(),
    replyToMessageId: runtimeId.optional(),
    stickerId: stickerIdSchema.optional(),
    annotations: z
      .array(
        z
          .object({
            reference: messageReferenceSchema,
            comment: z.string().trim().min(1).max(8000),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict();
export type AcceptedMessageInput = z.infer<typeof acceptedMessageSchema>;
export type ConversationAcceptance = { messageId: string; runId: string; duplicate: boolean };
export type ConversationEvent = {
  id: string;
  seq: number;
  threadId: string;
  runId?: string;
  origin: "live" | "history" | "task" | "user";
  kind: "accepted" | "agui" | "interaction" | "directive";
  payload: unknown;
};
export type ConversationReplay = {
  events: ConversationEvent[];
  nextCursor: number;
  snapshotRequired: boolean;
};
export type TaskMailbox = {
  id: string;
  directiveId: string;
  taskId: string;
  clientMessageId: string;
  messageId: string;
  threadId: string;
  seq: number;
  desiredRevision: number;
  status: "received" | "applied" | "completed_before_apply";
  text: string;
  attachmentIds: string[];
  annotations: AcceptedMessageInput["annotations"];
};
/** Literal credential identifiers only; this is not semantic classification of arbitrary prose. */
export function isCredentialIdentifier(value: string): boolean {
  return /password|senha|secret|segredo|token|credential|credencial|credenciais|api[ ._-]?key|otp|passcode|passkey|verification[ _-]?code|c[oó]digo[ _-]de[ _-]verifica/i.test(
    value,
  );
}
const safeFieldName = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z][\w-]*$/)
  .refine(
    (value) => !isCredentialIdentifier(value),
    "Secrets require a trusted credential channel",
  );
export const questionSchema = z
  .object({
    title: z.string().trim().min(1).max(2000),
    fields: z
      .array(
        z.discriminatedUnion("type", [
          z
            .object({
              id: safeFieldName,
              label: z.string().min(1).max(300),
              type: z.literal("text"),
              required: z.boolean().default(true),
              multiline: z.boolean().default(false),
            })
            .strict(),
          z
            .object({
              id: safeFieldName,
              label: z.string().min(1).max(300),
              type: z.literal("single"),
              required: z.boolean().default(true),
              options: z
                .array(z.object({ id: runtimeId, label: z.string().min(1).max(300) }).strict())
                .min(1)
                .max(20),
            })
            .strict(),
          z
            .object({
              id: safeFieldName,
              label: z.string().min(1).max(300),
              type: z.literal("multiple"),
              required: z.boolean().default(true),
              options: z
                .array(z.object({ id: runtimeId, label: z.string().min(1).max(300) }).strict())
                .min(1)
                .max(20),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const metadata = [
      value.title,
      ...value.fields.flatMap((field) => [
        field.label,
        ...(field.type === "text"
          ? []
          : field.options.flatMap((option) => [option.id, option.label])),
      ]),
    ];
    if (metadata.some(isCredentialIdentifier))
      context.addIssue({
        code: "custom",
        message: "Credentials require a trusted connection form, never a generic question",
      });
    if (new Set(value.fields.map((field) => field.id)).size !== value.fields.length)
      context.addIssue({ code: "custom", message: "Question field IDs must be unique" });
    for (const field of value.fields)
      if (
        field.type !== "text" &&
        new Set(field.options.map((option) => option.id)).size !== field.options.length
      )
        context.addIssue({ code: "custom", message: "Question option IDs must be unique" });
  });
export type QuestionSchema = z.infer<typeof questionSchema>;
export const questionAnswerSchema = z.record(
  safeFieldName,
  z.union([z.string().max(12000), z.array(runtimeId).max(20)]),
);
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;
export type CredentialFormSchema = {
  /** Generic vault-backed fields requested at runtime, independent of a provider catalog. */
  credentialKind?: "api" | "composio";
  /** Server-created authorization attempt; never a URL supplied by the model. */
  composio?: {
    flowId: string;
    toolkitSlug: string;
    authorizationUrl?: string;
    expiresAt?: string;
    setupRequired?: boolean;
  };
  /** API integrations use the vault directly, without a browser login task. */
  integrationId?: "tavily";
  title: string;
  serviceName: string;
  origin: string;
  purpose: string;
  fields: {
    id: string;
    label: string;
    type: "text" | "password";
    required: boolean;
  }[];
};
type InteractionRequestBase = {
  id: string;
  taskId: string;
  revision: number;
  threadId?: string;
  createdAt: string;
  answeredAt?: string;
  fieldBindings?: Record<string, { name: string; checkbox: boolean }>;
  suggestion?: ProactivitySuggestion;
};
export type QuestionInteractionRequest = InteractionRequestBase & {
  kind: "question";
  schema: QuestionSchema;
  status: "waiting" | "answered" | "superseded";
  answer?: QuestionAnswer;
};
export type CredentialInteractionRequest = InteractionRequestBase & {
  kind: "credential";
  schema: CredentialFormSchema;
  status:
    | "waiting"
    | "saving"
    | "saved"
    | "connecting"
    | "connected"
    | "needs_challenge"
    | "invalid_credentials"
    | "outcome_unknown"
    | "error"
    | "expired"
    | "cancelled"
    | "superseded";
  credentialRef?: { id: string; version: number };
  challengeId?: string;
  challengeKind?: "totp" | "otp" | "push" | "captcha" | "webauthn" | "unknown";
};
export type OtherInteractionRequest = InteractionRequestBase & {
  kind: "oauth" | "approval" | "proactivity";
  schema: QuestionSchema;
  status: "waiting" | "answered" | "superseded";
  answer?: QuestionAnswer;
};
export type InteractionRequest =
  | QuestionInteractionRequest
  | CredentialInteractionRequest
  | OtherInteractionRequest;
export const conversationEventSchema = z
  .object({
    id: z.string().min(1),
    seq: z.number().int().positive(),
    threadId: runtimeId,
    runId: runtimeId.optional(),
    origin: z.enum(["live", "history", "task", "user"]),
    kind: z.enum(["accepted", "agui", "interaction", "directive"]),
    payload: z.unknown(),
  })
  .strict();
export const taskMailboxSchema = z
  .object({
    id: z.string().min(1),
    directiveId: z.string().min(1),
    taskId: runtimeId,
    clientMessageId: runtimeId,
    messageId: runtimeId,
    threadId: runtimeId,
    seq: z.number().int().positive(),
    desiredRevision: z.number().int().positive(),
    status: z.enum(["received", "applied", "completed_before_apply"]),
    text: z.string().min(1).max(24000),
    attachmentIds: z.array(runtimeId).max(30),
    annotations: acceptedMessageSchema.shape.annotations,
  })
  .strict();
export type WorkClass = "interactive" | "background";

export const resourceRequestSchema = z
  .object({
    key: z.string().trim().min(1).max(500),
    units: z.number().int().min(1).max(1000),
    mode: z.enum(["shared", "exclusive"]),
  })
  .strict();
export type ResourceRequest = z.infer<typeof resourceRequestSchema>;

export const resourceLeaseSchema = z
  .object({
    id: z.string().min(1).max(200),
    fence: z.number().int().min(0),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type ResourceLease = z.infer<typeof resourceLeaseSchema>;

export const taskTimingSchema = z
  .object({
    priority: z.enum(["low", "normal", "high"]),
    dueAt: z.iso.datetime({ offset: true }).optional(),
    validUntil: z.iso.datetime({ offset: true }).optional(),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value }).format();
          return true;
        } catch {
          return false;
        }
      }, "Enter a valid IANA timezone")
      .optional(),
  })
  .strict();
export type TaskTiming = z.infer<typeof taskTimingSchema>;

export const runtimePauseStateSchema = z
  .object({
    paused: z.boolean(),
    revision: z.number().int().min(0),
    changedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type RuntimePauseState = z.infer<typeof runtimePauseStateSchema>;

export const operationStatusSchema = z.enum([
  "queued",
  "dispatching",
  "running",
  "succeeded",
  "failed",
  "rejected_not_dispatched",
  "superseded",
  "outcome_unknown",
]);
export type OperationStatus = z.infer<typeof operationStatusSchema>;
export const operationIntentSchema = z
  .object({
    id: runtimeId,
    taskId: runtimeId,
    revision: z.number().int().nonnegative(),
    bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
    executorId: runtimeId,
    executorEpoch: z.number().int().positive(),
    resourceFence: z.number().int().nonnegative(),
    status: operationStatusSchema,
  })
  .strict();
export type OperationIntent = z.infer<typeof operationIntentSchema>;
export const completionCriterionSchema = z
  .object({
    id: runtimeId,
    description: z.string().trim().min(1).max(1000),
    kind: z.enum(["artifact", "file", "receipt", "observation", "response"]),
    referenceId: runtimeId.optional(),
    format: z.string().max(100).optional(),
    effect: z
      .enum([
        "email.send",
        "calendar.create",
        "calendar.update",
        "calendar.delete",
        "command",
        "browser",
        "external",
      ])
      .optional(),
    requiredItems: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
  })
  .strict();
export type CompletionCriterion = z.infer<typeof completionCriterionSchema>;
export const completionAssessmentSchema = z
  .object({
    status: z.enum(["verified", "partial", "unverified"]),
    checks: z.array(
      z
        .object({ criterionId: runtimeId, passed: z.boolean(), evidenceIds: z.array(runtimeId) })
        .strict(),
    ),
    remaining: z.array(z.string()),
  })
  .strict();
export type CompletionAssessment = z.infer<typeof completionAssessmentSchema>;
export const taskBudgetSchema = z
  .object({
    id: runtimeId,
    revision: z.number().int().nonnegative(),
    maxSteps: z.number().int().min(1).max(10000).nullable(),
    usedSteps: z.number().int().nonnegative(),
    maxMilliseconds: z.number().int().positive().nullable(),
    usedMilliseconds: z.number().int().nonnegative(),
  })
  .strict();
export type TaskBudget = z.infer<typeof taskBudgetSchema>;
export type DirectiveReceipt = Pick<
  TaskMailbox,
  "id" | "taskId" | "seq" | "desiredRevision" | "status"
>;
export type ExecutorCapability =
  | "browser.dom"
  | "browser.screenshot"
  | "browser.pointer"
  | "browser.drag"
  | "desktop"
  | "command"
  | "files"
  | "transcribe";

export const workClassSchema = z.enum(["interactive", "background"]);
export const modelRequirementsSchema = z.object({
  tools: z.boolean(),
  vision: z.boolean(),
  structuredOutput: z.boolean(),
  contextTokens: z.number().int().nonnegative(),
});
export type ModelRequirements = z.infer<typeof modelRequirementsSchema>;

export const modelRoutingStatusSchema = z.object({
  quotaScope: z.literal("process"),
  active: z.object({ provider: z.string(), model: z.string(), fallback: z.boolean() }).optional(),
  providers: z.array(
    z.object({
      provider: z.string(),
      active: z.number().int().nonnegative(),
      quota: z.object({
        total: z.number().int().positive(),
        background: z.number().int().positive(),
        interactive: z.number().int().positive(),
      }),
    }),
  ),
  models: z.array(
    z.object({
      model: z.string(),
      capabilitySource: z.enum(["declared", "preflight", "compatibility_assumption"]),
      capabilities: modelRequirementsSchema,
      failures: z.number().int().nonnegative(),
      cooldownUntil: z.number().nonnegative(),
      code: z.string().optional(),
      message: z.string().optional(),
    }),
  ),
});
export type ModelRoutingStatus = z.infer<typeof modelRoutingStatusSchema>;
