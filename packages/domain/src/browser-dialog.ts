import { z } from "zod";

export const browserDialogInputSchema = z
  .object({
    dialogId: z.uuid(),
    accept: z.boolean(),
    promptText: z.string().max(10_000).optional(),
  })
  .strict();

export const browserDialogSchema = z.object({
  id: z.uuid(),
  type: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
  message: z.string().max(8192),
  defaultValue: z.string().max(1000),
  truncated: z.boolean(),
  requiresApproval: z.boolean(),
});

// Private server/executor protocol. This ID is issued by ActionService only;
// it is not an argument in the model's ordinary browser_dialog schema.
export const reviewedBrowserDialogInputSchema = browserDialogInputSchema
  .extend({
    approvalId: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
