import { z } from "zod";
import type { Evidence } from "./agent.ts";

const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\w.:-]+$/);
export const proactivityActionSchema = z.enum([
  "start",
  "continue",
  "snooze",
  "resolved",
  "dismiss",
]);
export type ProactivityAction = z.infer<typeof proactivityActionSchema>;
export const proactivityResponseSchema = z
  .object({
    requestId: id,
    clientResponseId: id,
    expectedRevision: z.number().int().min(1),
    action: proactivityActionSchema,
    snoozeUntil: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if ((v.action === "snooze") !== Boolean(v.snoozeUntil))
      c.addIssue({ code: "custom", message: "Only snooze requires a snoozeUntil time" });
  });
export type ProactivityResponse = z.infer<typeof proactivityResponseSchema>;
export const proactivityTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("mail"),
      connectionId: id,
      threadId: id,
      messageId: id,
      messageIds: z.array(id).min(1).max(100),
      version: z.string().min(1),
      purpose: z.enum(["reply", "attention"]).optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal("memory"), memoryId: id, revision: z.number().int().nonnegative() })
    .strict(),
  z
    .object({
      kind: z.literal("calendar"),
      connectionId: id,
      eventId: id,
      version: z.string().min(1),
      timeMin: z.iso.datetime({ offset: true }),
      timeMax: z.iso.datetime({ offset: true }),
      timeZone: z.string().min(1).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("goal"),
      goalId: id,
      milestoneId: id.optional(),
      revision: z.number().int().min(0),
      taskId: id.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("task"),
      taskId: id,
      revision: z.number().int().min(0),
      goalId: id.optional(),
      milestoneId: id.optional(),
    })
    .strict(),
]);
export type ProactivityTarget = z.infer<typeof proactivityTargetSchema>;
export type SourceCoverage = {
  complete: boolean;
  observedAt: string;
  status: "fresh" | "partial" | "unavailable" | "disconnected";
  detail?: string;
  cursor?: string;
};
export type ProactivitySuggestion = {
  id: string;
  semanticKey: string;
  cycleId: string;
  threadId: string;
  requestId: string;
  revision: number;
  title: string;
  reason: string;
  prompt: string;
  target: ProactivityTarget;
  evidence: Evidence[];
  status: "pending" | "accepted" | "snoozed" | "resolved" | "suppressed" | "obsolete";
  taskId?: string;
  acceptedTarget?: ProactivityTarget;
  continuation?: { id: string; delivered?: boolean };
  snoozeUntil?: string | null;
  resolution?: { kind: "user"; at: string; requestId: string; action: ProactivityAction };
  createdAt: string;
  updatedAt: string;
};
export type ProactivitySettingsRecord = {
  id: string;
  revision: number;
  enabled: boolean;
  intervalHours: number;
  activeHours?: { start: string; end: string; timezone: string } | null;
  updatedAt: string;
  origin?: { kind: "chat" | "settings"; messageId?: string };
};
export type ProactivityCycle = {
  id: string;
  taskId: string;
  status: "queued" | "reviewing" | "completed";
  createdAt: string;
  completedAt?: string;
  watermark?: string;
  cursor?: string;
  wakeEvents?: string[];
  reviewedWakeEvents?: string[];
  coverage: Partial<
    Record<"mail" | "calendar" | "goals" | "tasks" | "memories" | "reasoning", SourceCoverage>
  >;
};
