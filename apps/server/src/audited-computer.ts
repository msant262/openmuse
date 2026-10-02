import { createHash, randomUUID } from "node:crypto";
import type { ComputerCommand } from "../../../packages/domain/src/computer.ts";
import { type ActionLog, type LogAction, unknownOutcome } from "./action-log.ts";
import type { ComputerBackend } from "./computer-contract.ts";
import { backgroundFailure } from "./log.ts";

/** Covers app and model calls at the shared backend boundary, without command/output payloads. */
export function auditedComputer(
  backend: ComputerBackend,
  log: ActionLog,
  provider: "rpc" | "docker" = "docker",
): ComputerBackend {
  const readCommand = backend.command?.bind(backend);
  const cancelCommand = backend.cancel?.bind(backend);
  const mediaCommand = backend.media?.bind(backend);
  const run = <T>(owner: string, tool: string, operation: () => Promise<T>) =>
    log.run(
      owner,
      { tool: `computer.${tool}`, target: "Private workspace", summary: `Computer ${tool}` },
      operation,
    );
  const finish = async (owner: string, receipt: ComputerCommand) => {
    if (receipt.status === "running") return;
    const action = await log.db.get<LogAction>(owner, "computer-audit", receipt.id);
    if (!action) return;
    await log.finish(
      owner,
      action,
      receipt.status === "succeeded"
        ? "succeeded"
        : receipt.status === "interrupted" || receipt.status === "timed_out"
          ? "outcome_unknown"
          : "failed",
    );
  };
  const command = async (
    owner: string,
    tool: string,
    options: { idempotencyKey?: string; signal?: AbortSignal },
    operation: (bound: typeof options) => Promise<ComputerCommand>,
  ) => {
    const bound = { ...options, idempotencyKey: options.idempotencyKey ?? randomUUID() };
    const receiptId = createHash("sha256")
      .update(
        provider === "rpc"
          ? `${owner}:${bound.idempotencyKey}`
          : `computer-command:${bound.idempotencyKey}`,
      )
      .digest("hex");
    const action = {
      tool: `computer.${tool}`,
      target: "Private workspace",
      summary: `Computer ${tool}`,
      operationId: receiptId,
    };
    await log.append(owner, action, "started");
    await log.db.insertIfAbsent(owner, "computer-audit", { ...action, id: receiptId });
    let receipt: ComputerCommand;
    try {
      receipt = await operation(bound);
    } catch (error) {
      const saved = await log.db.get<{ status: string }>(owner, "computer-commands", receiptId);
      await log.finish(
        owner,
        action,
        unknownOutcome(error) || saved?.status === "interrupted" || saved?.status === "timed_out"
          ? "outcome_unknown"
          : "failed",
      );
      throw error;
    }
    await log.db.insertIfAbsent(owner, "computer-audit", { ...action, id: receipt.id });
    await finish(owner, receipt);
    return receipt;
  };
  return {
    snapshot: async (owner) => {
      const value = await backend.snapshot(owner);
      for (const receipt of value.commands) await finish(owner, receipt);
      return value;
    },
    start: (owner) => run(owner, "start", () => backend.start(owner)),
    stop: (owner) => run(owner, "stop", () => backend.stop(owner)),
    execute: (owner, raw, options = {}) =>
      command(owner, "command", options, (bound) => backend.execute(owner, raw, bound)),
    list: (owner, path) => run(owner, "list", () => backend.list(owner, path)),
    read: (owner, path) => run(owner, "read", () => backend.read(owner, path)),
    write: (owner, path, text) => run(owner, "write", () => backend.write(owner, path, text)),
    mkdir: (owner, path) => run(owner, "mkdir", () => backend.mkdir(owner, path)),
    writePdf: (owner, path, bytes) =>
      run(owner, "import", () => backend.writePdf(owner, path, bytes)),
    pdfBytes: (owner, path) => run(owner, "export", () => backend.pdfBytes(owner, path)),
    writeBytes: (owner, path, bytes) =>
      run(owner, "import", () => backend.writeBytes(owner, path, bytes)),
    fileBytes: (owner, path) => run(owner, "export", () => backend.fileBytes(owner, path)),
    ...(readCommand && {
      command: async (owner: string, id: string) => {
        const receipt = await readCommand(owner, id);
        await finish(owner, receipt);
        return receipt;
      },
    }),
    ...(cancelCommand && {
      cancel: (owner: string, id: string) =>
        run(owner, "cancel", async () => {
          const receipt = await cancelCommand(owner, id);
          await finish(owner, receipt);
          return receipt;
        }),
    }),
    ...(mediaCommand && {
      media: (
        owner: string,
        kind: "transcribe" | "preview",
        raw: unknown,
        options: { idempotencyKey?: string; signal?: AbortSignal } = {},
      ) => command(owner, kind, options, (bound) => mediaCommand(owner, kind, raw, bound)),
    }),
  };
}

/** Reconcile background results from their owned backend receipts, without rerunning commands. */
export async function reconcileComputerAudit(backend: ComputerBackend, log: ActionLog) {
  if (!backend.command) return;
  for (const { owner, value } of await log.db.scan<{
    id: string;
    operationId: string;
    complete?: boolean;
  }>("computer-audit")) {
    if (value.complete) continue;
    const saved = await log.db.get<{ status: string }>(owner, "computer-commands", value.id);
    if (!saved) {
      await log.db.compareAndSwap(owner, "computer-audit", value.id, {}, { complete: true });
      continue;
    }
    try {
      const receipt = await backend.command(owner, value.id);
      if (receipt.status !== "running")
        await log.db.compareAndSwap(owner, "computer-audit", value.id, {}, { complete: true });
    } catch (error) {
      backgroundFailure("computer audit reconciliation", error);
    }
  }
}
