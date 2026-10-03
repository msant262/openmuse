import { z } from "zod";
import { AppError } from "./errors.ts";

const reference = { snapshotId: z.uuid(), element: z.number().int().min(1).max(150) };
export const browserActionSchema = z.discriminatedUnion("action", [
  z.object({ ...reference, action: z.literal("click") }).strict(),
  z.object({ ...reference, action: z.literal("fill"), value: z.string().max(10_000) }).strict(),
  z.object({ ...reference, action: z.literal("select"), value: z.string().max(10_000) }).strict(),
  z
    .object({
      ...reference,
      action: z.literal("press"),
      key: z
        .string()
        .regex(
          /^(Enter|Space|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Control\+a|Meta\+a|Shift\+Tab)$/,
        ),
    })
    .strict(),
  z
    .object({ ...reference, action: z.literal("scroll"), deltaY: z.number().min(-5000).max(5000) })
    .strict(),
]);
export const snapshotSchema = z.object({
  interruptions: z
    .object({
      popupsBlocked: z.number().int().min(0).max(1000),
      dialogsDismissed: z.number().int().min(0).max(1000),
      last: z.enum(["POPUP_BLOCKED", "DIALOG_DISMISSED"]).optional(),
    })
    .optional(),
  sessionId: z.uuid(),
  snapshotId: z.uuid(),
  url: z.url(),
  title: z.string().max(300),
  text: z.string().max(30_000),
  truncated: z.boolean(),
  truncatedElements: z.boolean(),
  control: z.enum(["agent", "human"]),
  elements: z
    .array(
      z.object({
        number: z.number().int(),
        tag: z.string(),
        role: z.string(),
        type: z.string().optional(),
        label: z.string().max(500),
        href: z.string().optional(),
        disabled: z.boolean(),
        value: z.string().max(1000).optional(),
        options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
        frameUrl: z.string(),
      }),
    )
    .max(150),
});
export class BrowserError extends AppError {
  constructor(
    readonly code: string,
    message: string,
    status: AppError["status"] = 502,
    readonly sessionId?: string,
    readonly details?: unknown,
  ) {
    super(message, status);
  }
}
