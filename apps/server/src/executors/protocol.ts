import { z } from "zod";
import { desktopSessionSchema } from "../../../../packages/domain/src/desktop.ts";

export const EXECUTOR_PROTOCOL = { min: 1, max: 1 } as const;
export const safeExecutorId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
export const safeOperationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const capabilitySchema = z.enum([
  "browser.dom",
  "browser.screenshot",
  "browser.pointer",
  "browser.drag",
  "desktop",
  "command",
  "python",
  "files",
  "transcribe",
]);
export const readinessCheckSchema = z.object({
  state: z.enum(["ready", "unavailable", "starting", "incompatible", "quarantined"]),
  reason: z.string().max(1000).optional(),
});
export const hostSnapshotSchema = z.object({
  hostId: safeExecutorId,
  memoryTotalBytes: z.number().int().positive(),
  memoryAvailableBytes: z.number().int().nonnegative(),
  botsCurrentBytes: z.number().int().nonnegative(),
  botsHighBytes: z.number().int().nonnegative().nullable(),
  botsMaxBytes: z.number().int().nonnegative().nullable(),
  pressure: z.string().max(2048),
  heavyOwner: safeOperationId.nullable().optional(),
  unmanagedAccountBytes: z.number().int().nonnegative().default(0),
  managedSessionBytes: z.number().int().nonnegative().default(0),
});
const unavailable = {
  state: "unavailable" as const,
  reason: "Executor preflight has not reported readiness",
};
export const artifactPublicationConflictSchema = z.object({
  artifactId: safeOperationId,
  path: z.string().min(1).max(2048).startsWith("/workspace/"),
  version: sha256Schema,
  sha256: sha256Schema,
  generation: z.number().int().positive().default(1),
  versionId: z.uuid().optional(),
  reason: z.string().min(1).max(500),
  observedAt: z.number().nonnegative(),
});
export const executorReadinessSchema = z.object({
  desktopSession: desktopSessionSchema.optional(),
  account: readinessCheckSchema.default(unavailable),
  runtime: readinessCheckSchema.default(unavailable),
  files: readinessCheckSchema.default(unavailable),
  display: readinessCheckSchema.default(unavailable),
  capture: readinessCheckSchema.default(unavailable),
  input: readinessCheckSchema.default(unavailable),
  browser: readinessCheckSchema.default(unavailable),
  resources: hostSnapshotSchema.nullable().optional(),
  trustMode: z.enum(["restricted", "full-trust"]).default("full-trust"),
  containmentGuaranteed: z.boolean().default(false),
  quarantined: z.boolean().default(false),
  publicationConflicts: z.array(artifactPublicationConflictSchema).max(100).default([]),
});
export const executorHelloSchema = z
  .object({
    hostId: safeExecutorId,
    executorId: safeExecutorId,
    osAccountId: z.string().regex(/^\d{1,10}$/),
    bootId: z.string().min(1).max(128),
    instanceId: z.string().min(1).max(128).optional(),
    minProtocolVersion: z.number().int().positive(),
    maxProtocolVersion: z.number().int().positive(),
    capabilities: z
      .array(z.object({ name: capabilitySchema, version: z.number().int().positive() }))
      .max(32),
    readiness: executorReadinessSchema.default(() => executorReadinessSchema.parse({})),
  })
  .refine((value) => value.maxProtocolVersion >= value.minProtocolVersion, {
    message: "Invalid executor protocol range",
  });
export const executorRegistrationSchema = z.object({
  executorId: safeExecutorId,
  hostId: safeExecutorId,
  osAccountId: z.string().regex(/^\d{1,10}$/),
  owner: z.string().min(1).max(256),
  tokenHash: sha256Schema,
  trustMode: z.enum(["restricted", "full-trust"]),
});
export const executorPauseSchema = z.object({
  paused: z.boolean(),
  revision: z.number().int().nonnegative(),
  changedAt: z.string(),
});
export const pauseAckSchema = z.object({
  epoch: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  contained: z.boolean(),
  guaranteed: z.boolean(),
});
export const executorRequestSchema = z.object({
  id: safeOperationId,
  executorId: safeExecutorId,
  kind: z.enum([
    "command",
    "file",
    "file-version",
    "session",
    "cancel",
    "desktop",
    "browser",
    "media",
  ]),
  capability: capabilitySchema,
  capabilityVersion: z.number().int().positive().default(1),
  args: z.record(z.string(), z.unknown()),
  inspection: z.boolean().default(false),
});
export const executorOperationSchema = executorRequestSchema.extend({
  taskId: safeOperationId,
  revision: z.number().int().nonnegative(),
  bindingHash: sha256Schema,
  executorEpoch: z.number().int().positive(),
  resourceFence: z.number().int().nonnegative(),
  resourceKey: z.string().min(1).max(256),
  expiresAt: z.iso.datetime({ offset: true }),
  createdAt: z.iso.datetime({ offset: true }),
  resourceBudget: z
    .object({ memoryBytes: z.number().int().positive(), heavy: z.boolean() })
    .optional(),
});
export const executorReceiptSchema = z.object({
  status: z.enum([
    "running",
    "succeeded",
    "failed",
    "rejected_not_dispatched",
    "superseded",
    "outcome_unknown",
  ]),
  data: z.record(z.string(), z.unknown()).optional(),
  message: z.string().max(1000).optional(),
  progress: z
    .object({
      completedBytes: z.number().int().nonnegative(),
      totalBytes: z.number().int().nonnegative(),
    })
    .optional(),
});
export const executorManifestSchema = z.object({
  epoch: z.number().int().positive(),
  bootId: z.string().min(1).max(128),
  contained: z.boolean(),
  operations: z
    .array(
      z.object({
        operationId: safeOperationId,
        bindingHash: sha256Schema,
        executorEpoch: z.number().int().positive(),
        sequence: z.number().int().nonnegative(),
        receipt: executorReceiptSchema,
      }),
    )
    .max(10000),
});
export const artifactPublicationSchema = z.object({
  artifactId: safeOperationId,
  path: z.string().min(1).max(2048),
  version: sha256Schema,
  sha256: sha256Schema,
  size: z
    .number()
    .int()
    .min(0)
    .max(25 * 1024 * 1024),
  mimeType: z.string().min(1).max(200),
  executorLocal: z.literal(true),
  published: z.boolean().default(false),
  restoredAsCopy: z.boolean().default(false),
  previousVersionId: safeOperationId.optional(),
  versionId: safeOperationId.optional(),
  generation: z.number().int().positive().default(1),
  versions: z
    .array(
      z.object({
        id: safeOperationId,
        artifactId: safeOperationId,
        path: z.string().max(2048),
        sha256: sha256Schema,
        size: z.number().int().nonnegative(),
        createdAt: z.number().nonnegative(),
        taskId: safeOperationId.nullable().optional(),
        trashed: z.boolean(),
        retentionDays: z.number().int().positive(),
      }),
    )
    .max(10000)
    .default([]),
});
export type ExecutorHello = z.infer<typeof executorHelloSchema>;
export type ExecutorRegistration = z.infer<typeof executorRegistrationSchema>;
export type ExecutorReadiness = z.infer<typeof executorReadinessSchema>;
export type ExecutorRequest = z.input<typeof executorRequestSchema>;
export type ExecutorOperation = z.infer<typeof executorOperationSchema>;
export type ExecutorReceipt = z.infer<typeof executorReceiptSchema>;
export type ExecutorPause = z.infer<typeof executorPauseSchema>;
export type ExecutorManifest = z.infer<typeof executorManifestSchema>;
export type ArtifactPublication = z.infer<typeof artifactPublicationSchema>;

/** Provenance is created by authenticated service code, never accepted from
 * model arguments/node JSON. M4 verifies these references against its journal.
 */
export type ExecutorDispatchContext =
  | {
      kind: "task";
      taskId: string;
      desiredRevision: number;
      runToken: string;
      resourceLeaseIds: string[];
      resourceBudget?: { memoryBytes: number; heavy: boolean };
    }
  | { kind: "manual"; requestId: string; deviceId: string; owner: string };

/** This is a dispatch adapter to M4's authoritative operation journal. Registry
 * owns transport state only. No default grants, task queue, inference or work slots.
 * authorize must durably bind ID/arguments/task revision; beforeDispatch must use
 * the M3 pause/leases and M4 revision barrier atomically, including direct app calls.
 * Receipt/reconcile methods must be idempotent because acknowledgement can be lost.
 */
export interface ExecutorAuthority {
  authorize(
    owner: string,
    request: ExecutorRequest,
    executorEpoch: number,
    context: ExecutorDispatchContext,
  ): Promise<ExecutorOperation>;
  beforeDispatch(owner: string, operation: ExecutorOperation): Promise<void>;
  recordReceipt(
    owner: string,
    operation: ExecutorOperation,
    receipt: ExecutorReceipt,
    sequence: number,
  ): Promise<void>;
  reconcileMissing(owner: string, operation: ExecutorOperation): Promise<void>;
  pause(): Promise<ExecutorPause>;
}
