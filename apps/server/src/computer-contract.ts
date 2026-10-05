import { z } from "zod";
import type { ComputerCommand } from "../../../packages/domain/src/computer.ts";
import type { ComputerService } from "./computer.ts";
import type { ExecutorDispatchContext } from "./executors/protocol.ts";
import type { FileVersions } from "./file-versions.ts";

/** Semantic uncertainty survives cleanup. Only explicit physical confirmation
 * permits releasing held job resources for interrupted/timed-out native work. */
export function computerCommandCleanupConfirmed(
  receipt: Pick<ComputerCommand, "status" | "cleanupConfirmed">,
) {
  return (
    receipt.status === "succeeded" ||
    receipt.status === "failed" ||
    receipt.status === "rejected_not_dispatched" ||
    ((receipt.status === "interrupted" || receipt.status === "timed_out") &&
      receipt.cleanupConfirmed === true)
  );
}

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
  status: z.enum([
    "running",
    "succeeded",
    "failed",
    "timed_out",
    "interrupted",
    "rejected_not_dispatched",
  ]),
  exitCode: z.number().int().optional(),
  stdout: z.string().max(131072),
  stderr: z.string().max(131072),
  truncated: z.boolean(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  background: z.boolean().optional(),
  timeoutMs: z.number().int().max(1800000).optional(),
  kind: z.enum(["command", "transcribe", "preview"]).optional(),
  outcomeUnknown: z.boolean().optional(),
  cleanupConfirmed: z.boolean().optional(),
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
export type ComputerDispatchOptions = {
  idempotencyKey?: string;
  signal?: AbortSignal;
  dispatchGuard?: () => Promise<void>;
  onDispatch?: (receiptId: string) => Promise<void>;
  /** Owned task journal context, never model-selected account/epoch/fence. */
  dispatchContext?: ExecutorDispatchContext;
};
type BaseComputerBackend = Pick<
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
>;
export type ComputerBackend = Omit<BaseComputerBackend, "execute"> & {
  /** Local configuration validation only; must not dispatch any operation. */
  assertConfigured?: () => void;
  fileBytes: (
    owner: string,
    path: string,
    options?: Pick<ComputerDispatchOptions, "idempotencyKey" | "signal">,
  ) => ReturnType<ComputerService["fileBytes"]>;
  recovery?: FileVersions;
  artifact?: (owner: string, path: string) => Promise<Record<string, unknown>>;
  physicalOperation?: (owner: string, id: string) => Promise<{ cleanupConfirmed: boolean }>;
  execute: (
    owner: string,
    raw: unknown,
    options?: ComputerDispatchOptions,
  ) => Promise<z.infer<typeof commandReceiptSchema>>;
  command?: (owner: string, id: string) => Promise<z.infer<typeof commandReceiptSchema>>;
  cancel?: (owner: string, id: string) => Promise<z.infer<typeof commandReceiptSchema>>;
  media?: (
    owner: string,
    kind: "transcribe" | "preview",
    raw: unknown,
    options?: ComputerDispatchOptions,
  ) => Promise<z.infer<typeof commandReceiptSchema>>;
};
