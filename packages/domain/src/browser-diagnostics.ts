import { z } from "zod";

export const browserConsoleInputSchema = z
  .object({
    after: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(50),
    clear: z.boolean().default(false),
  })
  .strict();
export const browserConsoleEntrySchema = z.object({
  sequence: z.number().int().positive(),
  source: z.enum(["console", "exception"]),
  level: z.string().max(40),
  text: z.string().max(8192),
  recordedAt: z.iso.datetime(),
  truncated: z.boolean(),
});
const observation = {
  sessionId: z.uuid(),
  url: z.url(),
  observedAt: z.iso.datetime(),
};
export const browserConsoleSchema = z.object({
  ...observation,
  entries: z.array(browserConsoleEntrySchema).max(100),
  nextAfter: z.number().int().nonnegative().nullable(),
  dropped: z.number().int().nonnegative(),
  cleared: z.boolean(),
});

// Concrete protocol commands, with no arbitrary target, JavaScript, cookie,
// filesystem, navigation or site mutation parameters hidden inside a read.
const empty = z.object({}).strict().default({});
const nodeId = z.number().int().positive();
const command = <T extends string, P extends z.ZodType>(method: T, params: P) =>
  z.object({ method: z.literal(method), params }).strict();
export const browserCdpInputSchema = z.discriminatedUnion("method", [
  command("Browser.getVersion", empty),
  command("Page.getLayoutMetrics", empty),
  command("Performance.getMetrics", empty),
  command(
    "DOM.getDocument",
    z
      .object({
        depth: z.number().int().min(0).max(3).default(1),
        pierce: z.boolean().default(false),
      })
      .strict()
      .default({ depth: 1, pierce: false }),
  ),
  command(
    "DOM.querySelector",
    z.object({ nodeId, selector: z.string().min(1).max(2000) }).strict(),
  ),
  command(
    "DOM.querySelectorAll",
    z.object({ nodeId, selector: z.string().min(1).max(2000) }).strict(),
  ),
  command("DOM.getOuterHTML", z.object({ nodeId }).strict()),
  command(
    "DOM.describeNode",
    z
      .object({
        nodeId,
        depth: z.number().int().min(0).max(3).default(1),
        pierce: z.boolean().default(false),
      })
      .strict(),
  ),
  command(
    "Accessibility.getFullAXTree",
    z
      .object({ depth: z.number().int().min(1).max(10).default(3) })
      .strict()
      .default({ depth: 3 }),
  ),
]);
export const browserCdpSchema = z.object({
  ...observation,
  method: z.enum(browserCdpInputSchema.options.map((option) => option.shape.method.value)),
  result: z.record(z.string(), z.unknown()),
});
