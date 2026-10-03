import { z } from "zod";

export const desktopSessionSchema = z
  .object({
    id: z.uuid(),
    sessionGeneration: z.uuid(),
    browserSessionId: z.uuid(),
    profileId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    width: z.number().int().min(320).max(3840),
    height: z.number().int().min(240).max(2160),
  })
  .strict();
export type DesktopSession = z.infer<typeof desktopSessionSchema>;
const point = { x: z.number().int().nonnegative(), y: z.number().int().nonnegative() };
export const desktopActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), ...point }).strict(),
  z.object({ action: z.literal("doubleClick"), ...point }).strict(),
  z.object({ action: z.literal("focus"), ...point }).strict(),
  z
    .object({
      action: z.literal("drag"),
      ...point,
      toX: z.number().int().nonnegative(),
      toY: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      action: z.literal("type"),
      text: z
        .string()
        .min(1)
        .max(2000)
        .refine(
          (value) =>
            !Array.from(value).some(
              (character) =>
                character.codePointAt(0) === 0 ||
                (character.charCodeAt(0) >= 0xd800 &&
                  character.charCodeAt(0) <= 0xdfff &&
                  character.length === 1),
            ),
          "Invalid desktop text",
        ),
    })
    .strict(),
  z
    .object({
      action: z.literal("press"),
      key: z.enum([
        "Enter",
        "Tab",
        "Escape",
        "Backspace",
        "Delete",
        "Space",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Control+a",
        "Control+c",
        "Control+v",
        "Control+x",
        "Control+z",
        "Control+s",
        "Control+l",
        "Control+f",
        "Control+Shift+z",
        "Shift+Tab",
        "Alt+F4",
      ]),
    })
    .strict(),
  z.object({ action: z.literal("scroll"), deltaY: z.number().int().min(-1200).max(1200) }).strict(),
]);
export const desktopFrameBindingSchema = z.object({
  sessionGeneration: z.uuid(),
  frameId: z.uuid(),
  width: z.number().int().min(1).max(3840),
  height: z.number().int().min(1).max(2160),
});
export const desktopInputSchema = desktopFrameBindingSchema
  .extend({ action: desktopActionSchema })
  .strict()
  .superRefine((value, ctx) => {
    const action = value.action;
    if (
      ("x" in action && (action.x >= value.width || action.y >= value.height)) ||
      ("toX" in action && (action.toX >= value.width || action.toY >= value.height))
    )
      ctx.addIssue({
        code: "custom",
        message: "Input coordinates exceed the rendered frame dimensions",
      });
  });
export const desktopFrameSchema = desktopFrameBindingSchema.extend({
  sequence: z.number().int().positive(),
  observedAt: z.iso.datetime(),
  paused: z.boolean().optional(),
  imageHash: z.string().regex(/^[a-f0-9]{64}$/),
  imageUnchanged: z.boolean(),
  mimeType: z.literal("image/png").optional(),
  image: z.string().max(11_184_812).optional(),
});
export type DesktopFrame = z.infer<typeof desktopFrameSchema>;
export type DesktopInput = z.infer<typeof desktopInputSchema>;
export type DesktopControl = {
  control: "agent" | "human" | "changing";
  revision: number;
  grantId?: string;
  expiresAt?: number;
};
