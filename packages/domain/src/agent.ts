import { z } from "zod";
import type { AvatarDesign } from "./avatar.ts";
import type { AvatarAsset } from "./avatar-character.ts";
import {
  type CompletionAssessment,
  type CompletionCriterion,
  completionCriterionSchema,
  type RuntimePauseState,
  type TaskTiming,
  taskTimingSchema,
} from "./runtime.ts";

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "waiting_resource"
  | "waiting_global_pause"
  | "waiting_job"
  | "waiting_provider"
  | "waiting_children"
  | "scheduled"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";
export interface Evidence {
  id: string;
  kind: "mail" | "calendar" | "file" | "web" | "user";
  title: string;
  excerpt: string;
  url?: string;
  acquiredAt?: string;
  revision?: number;
  origin?: string;
  version?: string;
}
export interface TaskStep {
  id: string;
  title: string;
  status: "pending" | "running" | "succeeded" | "failed" | "waiting";
  detail?: string;
}
export interface AgentTask {
  id: string;
  title: string;
  prompt: string;
  kind: "agent" | "document" | "monitor" | "finance" | "plan";
  status: TaskStatus;
  goalId?: string;
  milestoneId?: string;
  responsible?: "user" | "agent";
  originThreadId?: string;
  originMessageId?: string;
  timing?: TaskTiming;
  criteria?: CompletionCriterion[];
  completion?: CompletionAssessment;
  plan: TaskStep[];
  evidence: Evidence[];
  input: Record<string, unknown>;
  state: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  leaseId?: string | null;
  leaseUntil?: string | null;
  attempts: number;
  actionId?: string | null;
  result?: string;
  error?: string | null;
  question?: string;
  artifactIds: string[];
}
export interface RunEvent {
  id: string;
  taskId: string;
  date: string;
  kind: "plan" | "step" | "observation" | "approval" | "result" | "error" | "status";
  title: string;
  detail: string;
}
export interface Goal {
  id: string;
  title: string;
  description: string;
  category: string;
  status: "active" | "paused" | "completed";
  revision?: number;
  responsible?: "user" | "agent";
  progress?: number;
  origin?: GoalOrigin;
  updatedAt?: string;
  milestones: GoalMilestone[];
  createdAt: string;
}
export type GoalOrigin = {
  kind: "user" | "agent";
  at: string;
  source: string;
  taskId?: string;
  evidenceIds?: string[];
};
export type GoalMilestone = {
  id: string;
  title: string;
  done: boolean;
  responsible?: "user" | "agent";
  taskId?: string;
  origin?: GoalOrigin;
};
export interface Monitor {
  id: string;
  taskId: string;
  title: string;
  url: string;
  condition: "change" | "contains" | "price_below";
  value: string;
  intervalMinutes: number;
  status: "active" | "paused" | "stopped";
  nextCheckAt: string;
  lastCheckedAt?: string;
  lastValue?: string;
  lastHash?: string;
  error?: string;
  checks: number;
  currency?: string;
  priceTarget?: string;
  matched?: boolean;
  coverageWarning?: string;
  lastDiff?: string;
  diffTruncated?: boolean;
}
export interface Idea {
  id: string;
  title: string;
  reason: string;
  evidence: Evidence[];
  prompt: string;
  kind: AgentTask["kind"];
  input: Record<string, unknown>;
  status: "new" | "dismissed" | "accepted";
  taskId?: string;
  createdAt: string;
}
export interface AgentMemory {
  id: string;
  text: string;
  source: string;
  createdAt: string;
  revision?: number;
  updatedAt?: string;
  origin?: {
    kind: "settings" | "chat" | "local" | "learning";
    messageId?: string;
    taskId?: string;
  };
  category?: "fact" | "preference" | "habit" | "plan";
  evidence?: { messageId: string; threadId: string; quote: string; observedAt: string }[];
  followUp?: { state: "open" | "resolved" | "cancelled"; after: string };
  validUntil?: string;
  timezone?: string;
  status?: "active" | "forgotten";
  restoredFrom?: number;
}
export type RevisionEntry<T> = {
  id: string;
  entityId: string;
  revision: number;
  value: T;
  changedAt: string;
  action: "save" | "edit" | "forget" | "restore" | "reset" | "migrate";
};
export interface AgentArtifact {
  id: string;
  taskId: string;
  kind: "plan" | "comparison" | "finance" | "report";
  title: string;
  summary: string;
  data: Record<string, unknown>;
  createdAt: string;
  revision?: number;
}
export interface AgentNotification {
  id: string;
  taskId?: string;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
  nativeDelivery?: "not_configured" | "pending" | "accepted" | "rejected" | "outcome_unknown";
}
export interface AgentIdentity {
  name: string;
  tone: "warm" | "concise" | "thoughtful";
  avatar?: "sky" | "sand" | "lilac";
  avatarDesign?: AvatarDesign;
  avatarAssetId?: string;
  avatarAsset?: AvatarAsset;
  showChatUpdates?: boolean;
  profile?: EffectiveAgentProfile;
}
export const agentProfilePatchSchema = z
  .object({
    assistantName: z.string().trim().min(1).max(80).optional(),
    preferredUserName: z.string().trim().max(80).optional(),
    personality: z.string().trim().max(1500).optional(),
    language: z
      .string()
      .min(2)
      .max(35)
      .refine((value) => {
        try {
          return Intl.getCanonicalLocales(value).length === 1;
        } catch {
          return false;
        }
      }, "Choose a valid language/locale")
      .optional(),
    tone: z.enum(["warm", "concise", "thoughtful"]).optional(),
    formality: z.enum(["casual", "neutral", "formal"]).optional(),
    responseLength: z.enum(["concise", "balanced", "detailed"]).optional(),
    humor: z.enum(["none", "light"]).optional(),
    emojis: z.boolean().optional(),
    textStyle: z.enum(["plain", "structured"]).optional(),
  })
  .strict();
export type AgentProfilePatch = z.infer<typeof agentProfilePatchSchema>;
export type AgentProfileFields = Required<AgentProfilePatch>;
export const profileScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }).strict(),
  z
    .object({
      kind: z.literal("conversation"),
      threadId: z
        .string()
        .min(1)
        .max(256)
        .regex(/^[\w.-]+$/),
    })
    .strict(),
]);
export type ProfileScope = z.infer<typeof profileScopeSchema>;
export type ProfileOrigin = { kind: "chat"; messageId: string } | { kind: "settings" };
export type EffectiveAgentProfile = {
  fields: AgentProfileFields;
  revisions: { global: number; conversation: number };
  global: AgentProfilePatch;
  conversation: AgentProfilePatch;
  origin?: ProfileOrigin;
};
export interface AgentWorkspace {
  tasks: AgentTask[];
  goals: Goal[];
  monitors: Monitor[];
  ideas: Idea[];
  memories: AgentMemory[];
  artifacts: AgentArtifact[];
  notifications: AgentNotification[];
  identity: AgentIdentity;
  runtimePause: RuntimePauseState;
  runtimeStatus: {
    activeTasks: number;
    activeOperations: number;
    uncertainOperations: number;
    executorConfirmation: "unavailable" | "confirmed" | "unknown";
  };
  worker: { running: boolean; lastTickAt?: string };
}
export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  prompt: z.string().trim().min(1).max(12000),
  kind: z.enum(["agent", "document", "monitor", "finance", "plan"]).default("agent"),
  goalId: z.string().optional(),
  milestoneId: z.string().optional(),
  originThreadId: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[\w.-]+$/)
    .optional(),
  originMessageId: z.string().min(1).max(256).optional(),
  input: z.record(z.string(), z.unknown()).default({}),
  timing: taskTimingSchema.optional(),
  criteria: z.array(completionCriterionSchema).min(1).max(30).optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export const monitorInputSchema = z
  .object({
    title: z.string().min(1).max(160),
    url: z.url().max(4096),
    condition: z.enum(["change", "contains", "price_below"]).default("change"),
    value: z.string().max(300).default(""),
    intervalMinutes: z.number().int().min(1).max(10080).default(15),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    priceTarget: z.string().trim().min(1).max(300).optional(),
  })
  .superRefine((v, c) => {
    if (v.condition !== "change" && !v.value.trim())
      c.addIssue({ code: "custom", message: "Enter a condition value" });
    if (
      v.condition === "price_below" &&
      (!Number.isFinite(Number(v.value)) || Number(v.value) <= 0)
    )
      c.addIssue({ code: "custom", message: "Enter a positive price" });
    if (v.condition === "price_below" && (!v.currency || !v.priceTarget))
      c.addIssue({
        code: "custom",
        message: "Choose the currency and exact product name for a price watch",
      });
  });
export const goalInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().max(4000).default(""),
  category: z.string().max(80).default("Personal"),
  milestones: z.array(z.string().min(1).max(200)).max(20).default([]),
});

export interface Routine {
  id: string;
  title: string;
  prompt: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  revision: number;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
  pending: { key: string; slot: string; prompt: string; title: string; revision: number } | null;
  lastTaskId?: string;
  skipped?: number;
  blockedTaskId?: string | null;
}
