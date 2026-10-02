import { z } from "zod";
import type { ComputerService } from "./computer.ts";

export const mediaSchema = z.object({
  path: z.string().min(1).max(2048),
  language: z.enum(["auto", "pt", "en", "de"]).default("auto"),
  textPath: z.string().min(1).max(2048).optional(),
  srtPath: z.string().min(1).max(2048).optional(),
  outputPath: z.string().min(1).max(2048).optional(),
  timeoutMs: z.number().int().min(1000).max(1800000).optional(),
  background: z.boolean().default(false),
});
export const commandReceiptSchema = z.object({
  id: z.string().min(1).max(128),
  command: z.string().max(16000),
  cwd: z.string().max(2048),
  status: z.enum(["running", "succeeded", "failed", "timed_out", "interrupted"]),
  exitCode: z.number().int().optional(),
  stdout: z.string().max(131072),
  stderr: z.string().max(131072),
  truncated: z.boolean(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  background: z.boolean().optional(),
  timeoutMs: z.number().int().max(1800000).optional(),
  kind: z.enum(["command", "transcribe", "preview"]).optional(),
  result: z
    .object({
      text: z.string().max(32000).optional(),
      language: z.string().max(20).optional(),
      languageProbability: z.number().min(0).max(1).optional(),
      duration: z.number().min(0).max(1800).optional(),
      textPath: z.string().max(2048).optional(),
      srtPath: z.string().max(2048).optional(),
      previewPath: z.string().max(2048).optional(),
      truncated: z.boolean().optional(),
    })
    .optional(),
});
export type ComputerBackend = Pick<
  ComputerService,
  | "snapshot"
  | "start"
  | "stop"
  | "execute"
  | "list"
  | "read"
  | "write"
  | "mkdir"
  | "writePdf"
  | "pdfBytes"
  | "writeBytes"
  | "fileBytes"
> & {
  command?: (owner: string, id: string) => Promise<z.infer<typeof commandReceiptSchema>>;
  cancel?: (owner: string, id: string) => Promise<z.infer<typeof commandReceiptSchema>>;
  media?: (
    owner: string,
    kind: "transcribe" | "preview",
    raw: unknown,
    options?: { idempotencyKey?: string; signal?: AbortSignal },
  ) => Promise<z.infer<typeof commandReceiptSchema>>;
};
