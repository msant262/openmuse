import { z } from "zod";

const frame = { frameId: z.uuid() };
export const captchaActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("observe") }).strict(),
  z.object({ action: z.literal("check") }).strict(),
  z.object({ action: z.literal("help") }).strict(),
  z
    .object({ action: z.literal("click"), ...frame, element: z.number().int().min(1).max(80) })
    .strict(),
  z
    .object({
      action: z.literal("visual_click"),
      ...frame,
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("visual_drag"),
      ...frame,
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      toX: z.number().min(0).max(1),
      toY: z.number().min(0).max(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("fill"),
      ...frame,
      element: z.number().int().min(1).max(80),
      value: z.string().max(120),
    })
    .strict(),
  z.object({ action: z.literal("submit"), ...frame }).strict(),
]);
export type CaptchaAction = z.infer<typeof captchaActionSchema>;
export const captchaPlanSchema = z
  .object({
    challengeId: z.uuid(),
    origin: z.url(),
    selector: z.string().min(1).max(500),
    authenticatedSelector: z.string().min(1).max(500),
    submitSelector: z.string().min(1).max(500).optional(),
    sensitiveSelectors: z.array(z.string().min(1).max(500)).max(12),
    expiresAt: z.number().int().positive(),
    action: captchaActionSchema,
  })
  .strict();
export type CaptchaPlan = z.infer<typeof captchaPlanSchema>;
