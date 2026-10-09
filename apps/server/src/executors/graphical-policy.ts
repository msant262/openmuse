import { z } from "zod";
import { nativeUploadReferenceSchema } from "../../../../packages/domain/src/browser-file.ts";
import {
  desktopActionSchema,
  desktopFrameBindingSchema,
} from "../../../../packages/domain/src/desktop.ts";
import { searchInputSchema } from "../../../../packages/domain/src/search.ts";

const session = {
  sessionId: z.uuid(),
  sessionGeneration: z.uuid(),
  controlRevision: z.number().int().nonnegative(),
};
const nativeAction = z.union([
  desktopActionSchema.refine(
    (value) => value.action !== "type",
    "Native text requires one-use private delivery",
  ),
  z
    .object({
      action: z.literal("type"),
      textReference: z.uuid(),
      textHash: z.string().regex(/^[a-f0-9]{64}$/),
      length: z.number().int().min(1).max(2000),
    })
    .strict(),
]);
export const nativeDesktopArgsSchema = z.discriminatedUnion("operation", [
  z
    .object({
      ...session,
      operation: z.literal("observe"),
      previousImage: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      ...session,
      operation: z.literal("reset"),
      control: z.enum(["agent", "human"]),
      grantId: z.uuid().optional(),
    })
    .strict(),
  z
    .object({
      ...session,
      operation: z.literal("act"),
      actor: z.enum(["agent", "human"]),
      grantId: z.uuid().optional(),
      binding: desktopFrameBindingSchema.strict(),
      action: nativeAction,
    })
    .strict(),
]);
export const nativeBrowserArgsSchema = z
  .object({
    ...session,
    browserSessionId: z.uuid(),
    actor: z.literal("agent"),
    operation: z.enum([
      "open",
      "snapshot",
      "read",
      "inspect",
      "act",
      "agent-screenshot",
      "screenshot",
      "control",
      "close",
      "downloads",
      "download",
      "upload",
      "search",
      "credentials",
      "challenge",
    ]),
    body: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((value, context) => {
    const schema =
      value.operation === "upload"
        ? nativeUploadReferenceSchema
        : value.operation === "search"
          ? searchInputSchema
          : value.operation === "download"
            ? z.object({ downloadId: z.uuid() }).strict()
            : undefined;
    if (schema && !schema.safeParse(value.body).success)
      context.addIssue({ code: "custom", message: "Invalid bounded native browser operation" });
    if (
      value.operation === "credentials" &&
      !z
        .object({
          grantId: z.uuid(),
          origin: z.url(),
          adapterId: z.string().min(1).max(120),
          challengeId: z.uuid().optional(),
        })
        .strict()
        .safeParse(value.body).success
    )
      context.addIssue({
        code: "custom",
        message: "Native credentials require a trusted one-use grant",
      });
  });
export function nativeInspection(kind: string, args: Record<string, unknown>) {
  if (kind === "file")
    return ["list", "search", "read", "read_binary", "stat"].includes(String(args.operation));
  if (kind === "desktop") return nativeDesktopArgsSchema.parse(args).operation === "observe";
  if (kind === "browser")
    return [
      "snapshot",
      "read",
      "inspect",
      "agent-screenshot",
      "screenshot",
      "control",
      "downloads",
      "download",
    ].includes(nativeBrowserArgsSchema.parse(args).operation);
  return false;
}
export function nativeGraphicalReset(kind: string, args: Record<string, unknown>) {
  return kind === "desktop" && nativeDesktopArgsSchema.parse(args).operation === "reset";
}
