import { createHash } from "node:crypto";
import { z } from "zod";
import { workspacePath } from "../computer.ts";
import { AppError } from "../errors.ts";

export const PYTHON_WIRE_BYTES = 8 * 1024 ** 2 - 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const operationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const toolName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,255}$/)
  .refine((name) => name !== "execute_code");

/** Matches the native adapter's compact UTF-8 JSON identity. Owner/conversation
 * are supplied by API task composition; the model cannot choose this scope. */
export function pythonResourceKey(executorId: string, owner: string, sessionId: string) {
  return `python-session:${createHash("sha256")
    .update(JSON.stringify([executorId, owner, sessionId]))
    .digest("hex")}`;
}
export const pythonCellSchema = z
  .object({
    owner: z.string().min(1).max(256),
    sessionId: z.string().min(1).max(256),
    code: z.string().min(1).max(200_000),
    tools: z
      .array(toolName)
      .max(512)
      .refine((names) => new Set(names).size === names.length),
    reset: z.boolean(),
    /** Native v3: stop the complete interpreter unit after every source call. */
    fresh: z.boolean().optional(),
    /** Native v3: load copied helpers with this owned browser session. */
    browserSession: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
      .optional(),
    maxToolCalls: z.number().int().min(1).max(200),
    outputBytes: z.number().int().min(256).max(131072),
  })
  .strict()
  .refine(
    (cell) =>
      cell.browserSession === undefined ||
      (cell.fresh === true && cell.tools.includes("browser_harness_rpc")),
    "Browser helpers require a fresh cell and their bound RPC catalog",
  );
export const nativePythonArgsSchema = z
  .object({
    command: z.literal("Python cell"),
    cwd: z.string().transform((value, ctx) => {
      try {
        return workspacePath(value);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : "Invalid Python workspace",
        });
        return z.NEVER;
      }
    }),
    timeoutMs: z.number().int().min(1).max(1_800_000),
    background: z.literal(false),
    pythonCell: pythonCellSchema,
  })
  .strict();
export function pythonCapabilityCompatible(
  version: number,
  args: z.output<typeof nativePythonArgsSchema>,
) {
  return (
    [1, 2, 3].includes(version) &&
    (version !== 1 || args.cwd === "/workspace") &&
    (version === 3 || (args.pythonCell.fresh === undefined && args.timeoutMs <= 900_000))
  );
}
export const nativePythonReplyArgsSchema = z
  .object({
    operation: z.literal("python-reply"),
    operationId,
    requestSequence: z.number().int().min(1).max(200),
    requestHash: digest,
    replyReference: z.uuid(),
    replyHash: digest,
    replyBytes: z.number().int().min(1).max(PYTHON_WIRE_BYTES),
  })
  .strict();
export const pythonRpcSchema = z
  .object({
    sequence: z.number().int().min(1).max(200),
    json: z.string().min(1).max(PYTHON_WIRE_BYTES),
    sha256: digest,
  })
  .strict();
export function parsePythonRpc(raw: unknown) {
  const rpc = pythonRpcSchema.parse(raw);
  if (
    Buffer.byteLength(rpc.json) > PYTHON_WIRE_BYTES ||
    createHash("sha256").update(rpc.json).digest("hex") !== rpc.sha256
  )
    throw new AppError("Native Python tool request digest or byte binding changed", 502);
  const call = z
    .object({ name: toolName, args: z.record(z.string(), z.unknown()) })
    .strict()
    .parse(JSON.parse(rpc.json));
  return { ...rpc, ...call };
}
export type PythonRpc = ReturnType<typeof parsePythonRpc>;
export function pythonBrowserRequestBound(
  cell: z.infer<typeof pythonCellSchema>,
  request: Pick<PythonRpc, "name" | "args">,
) {
  return (
    request.name !== "browser_harness_rpc" ||
    (cell.browserSession !== undefined && request.args.session === cell.browserSession)
  );
}
export function pythonRpcWire(request: Pick<PythonRpc, "sequence" | "json" | "sha256">) {
  return { sequence: request.sequence, json: request.json, sha256: request.sha256 };
}
export function pythonHostCallId(parentId: string, rpc: Pick<PythonRpc, "sequence" | "sha256">) {
  return `python_${createHash("sha256")
    .update(JSON.stringify([parentId, rpc.sequence, rpc.sha256]))
    .digest("hex")}`;
}
export const pythonReplyValueSchema = z.union([
  z.object({ result: z.unknown(), continue: z.boolean() }).strict(),
  z.object({ error: z.string().max(2000), continue: z.boolean() }).strict(),
]);
export type PythonReplyValue = z.infer<typeof pythonReplyValueSchema>;
const output = z
  .string()
  .max(131072)
  .refine((text) => Buffer.byteLength(text) <= 131072);
export const pythonResultSchema = z
  .object({
    status: z.enum(["ok", "error", "exit", "interrupted", "paused", "timeout", "not_started"]),
    reused: z.boolean(),
    state_reset: z.boolean(),
    state_lost: z.boolean(),
    cleanup_confirmed: z.boolean(),
    stdout: output,
    stderr: output,
    traceback: output.optional(),
    raw_stdout: z.string().max(262144).optional(),
    raw_stderr: z.string().max(262144).optional(),
    stdout_clipped: z.boolean().optional(),
    stderr_clipped: z.boolean().optional(),
    traceback_clipped: z.boolean().optional(),
    stdout_spill_path: z.string().max(2048).optional(),
    spill_clipped: z.boolean().optional(),
    execution_count: z.number().int().nonnegative().optional(),
    duration_seconds: z.number().min(0).max(1800),
    host_call_pending: z.boolean(),
    error: z.string().max(4000).optional(),
    tool_calls: z
      .array(
        z
          .object({
            id: z.string().max(128),
            name: toolName,
            args_preview: z.string().max(1000),
            status: z.enum(["running", "settled", "error"]),
            result_preview: z.string().max(1000).optional(),
            result: z.unknown().optional(),
            result_clipped: z.boolean().optional(),
            error: z.string().max(4000).optional(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
export type PythonResult = z.infer<typeof pythonResultSchema>;
