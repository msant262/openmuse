import { z } from "zod";

export const avatarMotions = ["idle", "working", "responding"] as const;
export type AvatarMotion = (typeof avatarMotions)[number];
export interface AvatarMedia {
  fileId: string;
  /** Short-lived owner-signed URL, added only when reading an asset. */
  url?: string;
  mimeType: string;
  width?: number;
  height?: number;
  durationMs?: number;
  posterFileId?: string;
  posterUrl?: string;
}
export interface AvatarAsset {
  id: string;
  version: 1;
  label: string;
  prompt?: string;
  source: "generated" | "upload";
  status: "still" | "animating" | "ready" | "failed";
  poster: AvatarMedia;
  motions: Partial<Record<AvatarMotion, AvatarMedia>>;
  generationId?: string;
  createdAt: string;
  updatedAt: string;
}
export interface AvatarGeneration {
  id: string;
  prompt: string;
  label: string;
  status: "queued" | "running" | "awaiting_selection" | "succeeded" | "failed" | "uncertain";
  phase: "images" | "selection" | "videos" | "complete";
  candidateIds: string[];
  candidates: AvatarAsset[];
  selectedAssetId?: string;
  completedMotions: AvatarMotion[];
  error?: string;
  retryable: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface AvatarCapabilities {
  provider: "grok" | null;
  images: boolean;
  videos: boolean;
  reason?: string;
}
export interface AvatarStudioState {
  capabilities: AvatarCapabilities;
  assets: AvatarAsset[];
  generations: AvatarGeneration[];
  activeAssetId?: string;
}
export const avatarRequestId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const avatarGenerationInput = z
  .object({
    requestId: avatarRequestId,
    prompt: z.string().trim().min(3).max(3000),
    label: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
export const avatarSelectionInput = z
  .object({
    requestId: avatarRequestId,
    assetId: z.string().min(1).max(128),
  })
  .strict();
export const avatarRetryInput = z
  .object({
    requestId: avatarRequestId,
    acknowledgeUncertain: z.boolean().optional(),
  })
  .strict();
export const avatarImportInput = z
  .object({
    requestId: avatarRequestId,
    label: z.string().trim().min(1).max(80),
    posterFileId: z.string().min(1).max(128),
    motions: z
      .object({
        idle: z.string().min(1).max(128).optional(),
        working: z.string().min(1).max(128).optional(),
        responding: z.string().min(1).max(128).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
