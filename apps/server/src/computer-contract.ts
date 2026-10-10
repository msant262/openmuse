import { z } from "zod";
import type { ComputerCommand } from "../../../packages/domain/src/computer.ts";
import type { ComputerService } from "./computer.ts";
import type { ExecutorDispatchContext, ExecutorOperation } from "./executors/protocol.ts";
import type { PythonResult, PythonRpc } from "./executors/python-protocol.ts";
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
export type ComputerPythonInput = {
  /** Owner and conversation are composed by the task driver, never the model. */
  sessionId: string;
  code: string;
  tools: string[];
  reset: boolean;
  wallClockMs: number;
  maxToolCalls: number;
};
export type ComputerPythonOptions = ComputerDispatchOptions & {
  call: (parent: ExecutorOperation, request: PythonRpc) => Promise<unknown>;
  shouldContinue: () => boolean;
};
export type ComputerPythonExecution = { command: ComputerCommand; result?: PythonResult };
export const computerSearchParameters = z.object({
  pattern: z.string().min(1).max(1024),
  target: z.enum(["content", "files"]).default("content"),
  file_glob: z.string().max(256).optional(),
  limit: z.number().int().min(1).max(500).default(50),
  offset: z.number().int().min(0).max(100000).default(0),
  order: z.enum(["discovery", "modified"]).default("discovery"),
  output_mode: z.enum(["content", "files_only", "count"]).default("content"),
  context: z.number().int().min(0).max(5).default(0),
});
export const computerSearchReceipt = z.object({
  path: z.string().max(2048),
  target: z.enum(["content", "files"]),
  outputMode: z.enum(["content", "files_only", "count"]),
  order: z.enum(["discovery", "modified"]),
  results: z
    .array(
      z.object({
        path: z.string().max(2048),
        size: z.number().nonnegative().optional(),
        modifiedAt: z.number().optional(),
        line: z.number().int().positive().optional(),
        content: z.string().max(2000).optional(),
        count: z.number().int().nonnegative().optional(),
        truncated: z.boolean().optional(),
        sha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
        contextBefore: z.array(z.string().max(2000)).max(5).optional(),
        contextAfter: z.array(z.string().max(2000)).max(5).optional(),
      }),
    )
    .max(500),
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  complete: z.boolean(),
  totalMatches: z.number().int().nonnegative().nullable(),
  entriesScanned: z.number().int().nonnegative(),
  bytesRead: z.number().int().nonnegative(),
  skippedFiles: z.number().int().nonnegative(),
  limits: z.array(z.string().max(100)).max(10),
  scope: z.enum(["owned_regular_files", "owned_utf8_files_up_to_256KB"]),
  guidance: z.string().max(2000),
});
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
  pythonAvailable?: (owner: string) => Promise<boolean>;
  pythonResourceKey?: (owner: string, sessionId: string) => string;
  python?: (
    owner: string,
    input: ComputerPythonInput,
    options: ComputerPythonOptions,
  ) => Promise<ComputerPythonExecution>;
  search?: (
    owner: string,
    path: string,
    parameters: z.output<typeof computerSearchParameters>,
    options?: Pick<ComputerDispatchOptions, "signal">,
  ) => Promise<z.output<typeof computerSearchReceipt>>;
  /** Literal edits bind their write to the actual inspected source hash. */
  patch?: (
    owner: string,
    input: {
      path: string;
      oldString: string;
      newString: string;
      replaceAll: boolean;
    },
  ) => Promise<{
    path: string;
    status: "succeeded" | "rejected_not_dispatched";
    replacements?: number;
    beforeSha256?: string;
    afterSha256?: string;
    dispatched?: false;
    error?: string;
  }>;
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
