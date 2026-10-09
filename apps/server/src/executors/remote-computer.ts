import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import { attachmentLimit } from "../../../../packages/domain/src/attachments.ts";
import type {
  ComputerCommand,
  ComputerDirectory,
  ComputerSnapshot,
} from "../../../../packages/domain/src/computer.ts";
import { base64Limit, decodeBase64 } from "../base64.ts";
import { computerCommandSchema, workspacePath } from "../computer.ts";
import {
  type ComputerBackend,
  type ComputerDispatchOptions,
  commandReceiptSchema,
  computerSearchParameters,
  computerSearchReceipt,
  mediaSchema,
} from "../computer-contract.ts";
import { AppError } from "../errors.ts";
import { FileVersions } from "../file-versions.ts";
import {
  type ExecutorDispatchContext,
  type ExecutorOperation,
  type ExecutorRequest,
  executorRequestSchema,
} from "./protocol.ts";
import type { ExecutorRegistry } from "./registry.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const directorySchema = z.object({
  path: z.string(),
  entries: z
    .array(
      z.object({
        name: z.string(),
        path: z.string(),
        type: z.enum(["file", "directory", "symlink"]),
        size: z.number().nonnegative(),
      }),
    )
    .max(1000),
});

/** Production ComputerBackend over supervisor pull. The server never opens a
 * shell/SSH or native UID endpoint, and cannot dispatch without M4 authority.
 */
export class RemoteComputerBackend implements ComputerBackend {
  readonly recovery: FileVersions;
  constructor(
    readonly registry: ExecutorRegistry,
    readonly options: {
      executorId: string;
      enabled?: boolean;
      timeoutMs?: number;
      fileWaitMs?: number;
      pollMs?: number;
      retentionDays?: number;
      maxVersionBytes?: number;
      context?: (
        owner: string,
        requestId: string,
        request?: ExecutorRequest,
      ) => Promise<ExecutorDispatchContext | undefined>;
      manualContext?: (
        owner: string,
        requestId: string,
        request?: ExecutorRequest,
      ) => Promise<ExecutorDispatchContext>;
    },
  ) {
    this.recovery = new FileVersions(registry, {
      context: options.context,
      manualContext: options.manualContext,
      pollMs: options.pollMs,
      retentionDays: options.retentionDays,
      maxVersionBytes: options.maxVersionBytes,
    });
  }
  private check(owner: string) {
    const registration = this.registry.registration(this.options.executorId);
    if (registration.owner !== owner)
      throw new AppError("Native computer belongs to another owner", 403);
    if (this.options.enabled === false) throw new AppError("Native computer is disabled", 503);
    if (!this.registry.authorized)
      throw new AppError(
        "Native dispatch authority is unavailable; compose authoritative journal authorization",
        503,
      );
    return registration;
  }
  private id(owner: string, key?: string) {
    return hash(`${owner}:${key ?? randomUUID()}`);
  }
  private async submit(
    owner: string,
    input: Omit<ExecutorRequest, "id" | "executorId">,
    options: ComputerDispatchOptions = {},
  ) {
    this.check(owner);
    options.signal?.throwIfAborted();
    await options.dispatchGuard?.();
    const id = this.id(owner, options.idempotencyKey);
    const request = executorRequestSchema.parse({
      ...input,
      id,
      executorId: this.options.executorId,
    });
    const context =
      (await this.options.context?.(owner, id, request)) ??
      options.dispatchContext ??
      (await this.options.manualContext?.(owner, id, request));
    if (!context)
      throw new AppError(
        "Native dispatch requires trusted task context or authenticated manual-operation authorization",
        503,
      );
    // Persist M3 physical resource linkage before publishing for node delivery.
    return this.registry.enqueue(owner, request, context, { onDispatch: options.onDispatch });
  }
  private async wait(owner: string, operation: ExecutorOperation, signal?: AbortSignal) {
    const deadline =
      Date.now() +
      (["command", "media"].includes(operation.kind)
        ? (this.options.timeoutMs ?? 1800000) + 10000
        : (this.options.fileWaitMs ?? 30000));
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const delivery = await this.registry.delivery(owner, operation.id);
      if (!delivery)
        throw new AppError("Native operation delivery is missing; outcome unknown", 503);
      if (delivery.receipt && delivery.receipt.status !== "running") {
        // A command's nonzero exit is a completed execution, not a lost
        // transport acknowledgement. Return through command() so its bound
        // exit/output receipt is persisted and the caller can repair the script.
        if (
          ["command", "media"].includes(operation.kind) &&
          ["failed", "rejected_not_dispatched"].includes(delivery.receipt.status)
        )
          return delivery.receipt.data ?? {};
        if (delivery.receipt.status !== "succeeded")
          throw new AppError(
            delivery.receipt.message ??
              "Native effect was not confirmed; inspect its receipt before repeating",
            503,
          );
        const data = delivery.receipt.data ?? {};
        if (
          operation.kind === "file" &&
          ["write", "write_binary", "stat"].includes(String(operation.args.operation))
        ) {
          const conflict = await this.registry.publicationConflict(
            owner,
            operation.executorId,
            data,
          );
          if (conflict)
            throw new AppError(
              `Origin artifact publication conflicted: ${conflict.reason}; inspect the current file`,
              503,
            );
          const artifact = await this.registry.db.get<{
            published: boolean;
            version: string;
            sha256: string;
            generation?: number;
            versionId?: string;
          }>(owner, "native-artifacts", String(data.artifactId));
          if (
            artifact?.published &&
            artifact.version === data.version &&
            artifact.sha256 === data.sha256 &&
            (artifact.generation ?? 1) === (data.generation ?? 1) &&
            artifact.versionId === data.versionId
          )
            return { ...data, published: true };
        } else return data;
      }
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 100));
    }
    throw new AppError(
      "Native effect receipt is still pending; operation will not be repeated",
      503,
    );
  }
  async snapshot(owner: string): Promise<ComputerSnapshot> {
    const registration = this.registry.registration(this.options.executorId);
    if (registration.owner !== owner)
      throw new AppError("Native computer belongs to another owner", 403);
    const node = await this.registry.node(this.options.executorId);
    const commands = (await this.registry.deliveries(owner, this.options.executorId))
      .filter((value) => ["command", "media"].includes(value.operation.kind))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100);
    const receipts = [];
    for (const delivery of commands) receipts.push(await this.command(owner, delivery.id));
    const base: ComputerSnapshot = {
      enabled: this.options.enabled !== false,
      provider: "native",
      workspacePath: "/workspace",
      network: "public-only",
      profile: "open",
      maxTimeoutMs: this.options.timeoutMs ?? 1800000,
      commands: receipts,
      executorId: this.options.executorId,
      executorEpoch: node?.epoch,
      connected: node?.connected ?? false,
      trustMode: registration.trustMode,
      containmentGuaranteed:
        registration.trustMode === "restricted" &&
        Boolean(node?.hello.readiness.containmentGuaranteed),
      readiness: node?.hello.readiness,
      status: "stopped",
    };
    if (!base.enabled) return { ...base, status: "unconfigured" };
    if (!this.registry.authorized)
      return { ...base, status: "error", message: "Native dispatch authority is unavailable" };
    if (!this.options.context && !this.options.manualContext)
      return {
        ...base,
        status: "error",
        message: "Trusted native task/manual context resolver is unavailable",
      };
    if (!node?.connected || !node.reconciled)
      return {
        ...base,
        status: "error",
        message: "Native executor is offline or awaiting handshake/reconciliation",
      };
    if (
      node.hello.readiness.account.state !== "ready" ||
      node.hello.readiness.runtime.state !== "ready"
    )
      return {
        ...base,
        status: "error",
        message:
          node.hello.readiness.account.reason ??
          node.hello.readiness.runtime.reason ??
          "Native account/runtime preflight unavailable",
      };
    return {
      ...base,
      status: "running",
      ...(registration.trustMode === "full-trust" && {
        message:
          "Full-trust native account: sudo/group access disables containment-based mutable failover guarantees",
      }),
    };
  }
  async start(owner: string) {
    const operation = await this.submit(owner, {
      kind: "session",
      capability: "command",
      capabilityVersion: 1,
      args: { operation: "start" },
    });
    await this.wait(owner, operation);
    return this.snapshot(owner);
  }
  async stop(owner: string) {
    const operation = await this.submit(owner, {
      kind: "session",
      capability: "command",
      capabilityVersion: 1,
      args: { operation: "stop" },
    });
    await this.wait(owner, operation);
    return this.snapshot(owner);
  }
  async execute(
    owner: string,
    raw: unknown,
    options: ComputerDispatchOptions = {},
  ): Promise<ComputerCommand> {
    const parsed = computerCommandSchema.parse(raw),
      timeoutMs = parsed.timeoutMs ?? this.options.timeoutMs ?? 1800000;
    if (timeoutMs > (this.options.timeoutMs ?? 1800000))
      throw new AppError("Command timeout exceeds native executor maximum", 422);
    const args = {
      ...parsed,
      cwd: workspacePath(parsed.cwd),
      timeoutMs,
      background: parsed.background ?? false,
    };
    const operation = await this.submit(
      owner,
      { kind: "command", capability: "command", capabilityVersion: 1, args },
      options,
    );
    const receipt = await this.command(owner, operation.id);
    if (args.background || receipt.status !== "running") return receipt;
    try {
      await this.wait(owner, operation, options.signal);
    } catch (error) {
      // A connection failure never becomes another command. Unknown/pending IDs
      // remain inspectable; task's M3 admission/resource holds survive.
      if (options.signal?.aborted && this.cancel)
        await this.cancel(owner, operation.id).catch(() => {});
      throw error;
    }
    return this.command(owner, operation.id);
  }
  async media(
    owner: string,
    kind: "transcribe" | "preview",
    raw: unknown,
    options: ComputerDispatchOptions = {},
  ): Promise<ComputerCommand> {
    const {
      timeoutMs = this.options.timeoutMs ?? 1800000,
      background,
      ...parsed
    } = mediaSchema.parse(raw);
    if (timeoutMs > (this.options.timeoutMs ?? 1800000))
      throw new AppError("Media timeout exceeds native maximum", 422);
    // Stable output names belong to this intention; native helper refuses overwrite.
    const key = options.idempotencyKey ?? randomUUID();
    const suffix = this.id(owner, key).slice(0, 20);
    const parameters = {
      path: workspacePath(parsed.path),
      ...(kind === "transcribe"
        ? {
            language: parsed.language,
            textPath: workspacePath(parsed.textPath ?? `/workspace/transcript-${suffix}.txt`),
            ...(parsed.srtPath ? { srtPath: workspacePath(parsed.srtPath) } : {}),
          }
        : { outputPath: workspacePath(parsed.outputPath ?? `/workspace/preview-${suffix}.pdf`) }),
    };
    const operation = await this.submit(
      owner,
      {
        kind: "media",
        capability: kind === "transcribe" ? "transcribe" : "command",
        capabilityVersion: 1,
        args: { mediaKind: kind, parameters, timeoutMs, background, cwd: "/workspace" },
      },
      { ...options, idempotencyKey: key },
    );
    const receipt = await this.command(owner, operation.id);
    if (background || receipt.status !== "running") return receipt;
    await this.wait(owner, operation, options.signal);
    return this.command(owner, operation.id);
  }
  async command(owner: string, id: string): Promise<ComputerCommand> {
    const delivery = await this.registry.delivery(owner, id);
    if (
      !delivery ||
      delivery.operation.executorId !== this.options.executorId ||
      !["command", "media"].includes(delivery.operation.kind)
    )
      throw new AppError("Native computer command not found", 404);
    const operation = delivery.operation,
      args = operation.args;
    const intent: ComputerCommand = {
      id,
      command: String(args.command ?? args.mediaKind),
      cwd: String(args.cwd ?? "/workspace"),
      kind:
        operation.kind === "media"
          ? z.enum(["transcribe", "preview"]).parse(args.mediaKind)
          : "command",
      timeoutMs: Number(args.timeoutMs ?? 1800000),
      background: Boolean(args.background),
      status: "running",
      stdout: "",
      stderr: "",
      truncated: false,
      startedAt: operation.createdAt,
    };
    let receipt = intent;
    if (delivery.receipt?.data) {
      const parsed = commandReceiptSchema.safeParse(delivery.receipt.data);
      if (parsed.success) {
        if (
          parsed.data.id !== id ||
          parsed.data.command !== intent.command ||
          parsed.data.cwd !== intent.cwd ||
          parsed.data.kind !== intent.kind ||
          parsed.data.timeoutMs !== intent.timeoutMs ||
          parsed.data.background !== intent.background
        )
          throw new AppError("Native command receipt binding does not match", 502);
        receipt = parsed.data;
      } else if (delivery.receipt.status === "succeeded")
        throw new AppError("Native successful command receipt is malformed", 502);
    }
    if (delivery.receipt && delivery.receipt.status !== "running" && receipt.status === "running")
      receipt = {
        ...intent,
        status:
          delivery.receipt.status === "succeeded"
            ? "succeeded"
            : delivery.receipt.status === "failed"
              ? "failed"
              : delivery.receipt.status === "rejected_not_dispatched"
                ? "rejected_not_dispatched"
                : "interrupted",
        stderr:
          delivery.receipt.message ?? "Native command outcome unknown; inspect before repeating",
        completedAt: new Date().toISOString(),
      };
    if (
      delivery.receipt?.status === "outcome_unknown" &&
      delivery.receipt.data?.cleanupConfirmed !== true
    )
      receipt = {
        ...receipt,
        status: "running",
        outcomeUnknown: true,
        cleanupConfirmed: false,
        completedAt: undefined,
      };
    else if (delivery.receipt?.status === "outcome_unknown")
      receipt = { ...receipt, outcomeUnknown: true, cleanupConfirmed: true };
    // Monotonic physical receipts consumed by M3 and the existing ActionLog.
    await this.registry.db.insertIfAbsent(owner, "computer-commands", receipt);
    await this.registry.db.compareAndSwap(
      owner,
      "computer-commands",
      id,
      { status: "running" },
      { ...receipt },
    );
    return commandReceiptSchema.parse(
      (await this.registry.db.get(owner, "computer-commands", id)) ?? receipt,
    );
  }
  async cancel(owner: string, id: string) {
    const target = await this.registry.delivery(owner, id);
    if (!target || target.operation.executorId !== this.options.executorId)
      throw new AppError("Native computer command not found", 404);
    const operation = await this.submit(
      owner,
      { kind: "cancel", capability: "command", capabilityVersion: 1, args: { operationId: id } },
      { idempotencyKey: `cancel:${id}` },
    );
    await this.wait(owner, operation);
    return this.command(owner, id);
  }
  async physicalOperation(owner: string, id: string) {
    const delivery = await this.registry.delivery(owner, id);
    if (!delivery) return { cleanupConfirmed: true }; // No transport publication exists.
    if (delivery.operation.executorId !== this.options.executorId)
      throw new AppError("Native operation belongs to another executor", 403);
    const receipt = delivery.receipt;
    return {
      cleanupConfirmed: Boolean(
        receipt &&
          receipt.status !== "running" &&
          (receipt.status !== "outcome_unknown" || receipt.data?.cleanupConfirmed === true),
      ),
    };
  }
  async artifact(owner: string, path: string) {
    return this.file(owner, "stat", path);
  }
  private async file(
    owner: string,
    operation: string,
    path: string,
    extra: Record<string, unknown> = {},
    options: ComputerDispatchOptions = {},
  ) {
    const request = await this.submit(
      owner,
      {
        kind: "file",
        capability: "files",
        capabilityVersion: 1,
        inspection: ["list", "search", "read", "read_binary", "stat"].includes(operation),
        args: { operation, path: workspacePath(path), ...extra },
      },
      options,
    );
    return this.wait(owner, request, options.signal);
  }
  async list(owner: string, path = "/workspace"): Promise<ComputerDirectory> {
    return directorySchema.parse(await this.file(owner, "list", path));
  }
  async search(
    owner: string,
    path: string,
    raw: z.output<typeof computerSearchParameters>,
    options: Pick<ComputerDispatchOptions, "signal"> = {},
  ) {
    const canonical = workspacePath(path);
    const parameters = computerSearchParameters.parse(raw);
    const result = computerSearchReceipt.parse(
      await this.file(owner, "search", canonical, { parameters }, options),
    );
    if (
      result.path !== canonical ||
      result.results.some((item) => {
        const observed = workspacePath(item.path);
        return (
          observed !== item.path ||
          !(observed === canonical || observed.startsWith(`${canonical.replace(/\/+$/, "")}/`))
        );
      })
    )
      throw new AppError("Native file search returned a path outside the requested scope", 502);
    return result;
  }
  async read(owner: string, path: string) {
    const result = z
      .object({ path: z.string(), text: z.string().max(262144) })
      .parse(await this.file(owner, "read", path));
    if (result.path !== workspacePath(path))
      throw new AppError("Native file receipt returned another path", 502);
    return result;
  }
  async write(owner: string, path: string, text: string) {
    if (Buffer.byteLength(text) > 262144)
      throw new AppError("Text files must be 256 KB or smaller", 413);
    return z
      .object({ path: z.string() })
      .parse(
        await this.file(owner, "write", path, { text, ...(await this.expected(owner, path)) }),
      );
  }
  async patch(
    owner: string,
    input: {
      path: string;
      oldString: string;
      newString: string;
      replaceAll: boolean;
    },
  ) {
    const path = workspacePath(input.path);
    const reject = (error: string) => ({
      path,
      status: "rejected_not_dispatched" as const,
      dispatched: false as const,
      error,
    });
    if (!input.oldString || input.oldString === input.newString)
      return reject("Choose a nonempty old_string and a different new_string.");
    let source: Awaited<ReturnType<typeof this.read>>;
    try {
      source = await this.read(owner, path);
    } catch (error) {
      // A native inspection cannot edit the user's file. Only handle known
      // backend/read failures here; task cancellation and uncertain prior
      // effects retain their ordinary exceptions. No write has been submitted.
      if (error instanceof AppError)
        return reject(`The source could not be read; no patch was written. ${error.message}`);
      throw error;
    }
    const matches = source.text.split(input.oldString).length - 1;
    if (!matches)
      return reject("old_string was not found. Read the current file and use its exact text.");
    if (matches > 1 && !input.replaceAll)
      return reject(
        `old_string matches ${matches} locations. Include unique surrounding text or explicitly choose replace_all.`,
      );
    // split/join preserves literal dollar/backslash sequences in replacement
    // text; String.replace would interpret $&, $` and related substitutions.
    const text = source.text.split(input.oldString).join(input.newString);
    if (Buffer.byteLength(text) > 262144)
      return reject("The edited text exceeds 256 KB; no patch was written.");
    const beforeSha256 = hash(source.text),
      afterSha256 = hash(text);
    const receipt = await this.file(owner, "write", path, { text, expectedVersion: beforeSha256 });
    if (
      (receipt as { path?: string }).path !== path ||
      (receipt as { sha256?: string }).sha256 !== afterSha256
    )
      throw new AppError("Native patch receipt does not confirm the intended file bytes", 502);
    return {
      path,
      status: "succeeded" as const,
      replacements: input.replaceAll ? matches : 1,
      beforeSha256,
      afterSha256,
    };
  }
  private async expected(owner: string, path: string) {
    const canonical = workspacePath(path);
    const artifacts = await this.registry.db.list<{
      version: string;
      executorId: string;
      path: string;
    }>(owner, "native-artifacts");
    const artifact = artifacts.find(
      (value) => value.path === canonical && value.executorId === this.options.executorId,
    );
    return artifact ? { expectedVersion: artifact.version } : { captureCurrent: true };
  }
  async mkdir(owner: string, path: string) {
    return z.object({ path: z.string() }).parse(await this.file(owner, "mkdir", path));
  }
  async writeBytes(owner: string, path: string, bytes: Uint8Array) {
    if (bytes.length > attachmentLimit)
      throw new AppError("Attachments must be 25 MB or smaller", 413);
    return z.object({ path: z.string() }).parse(
      await this.file(owner, "write_binary", path, {
        base64: Buffer.from(bytes).toString("base64"),
        ...(await this.expected(owner, path)),
      }),
    );
  }
  async fileBytes(
    owner: string,
    path: string,
    options: Pick<ComputerDispatchOptions, "idempotencyKey" | "signal"> = {},
  ) {
    const raw = z
      .object({
        path: z.string(),
        base64: z.string().max(base64Limit(attachmentLimit)),
        sha256: z.string(),
        size: z.number().int(),
      })
      .parse(
        await this.file(
          owner,
          "read_binary",
          path,
          {},
          {
            ...options,
            idempotencyKey: options.idempotencyKey ?? randomUUID(),
          },
        ),
      );
    const bytes = decodeBase64(raw.base64, attachmentLimit);
    if (
      !bytes ||
      raw.path !== workspacePath(path) ||
      raw.size !== bytes.length ||
      createHash("sha256").update(bytes).digest("hex") !== raw.sha256
    )
      throw new AppError(
        "Native file transfer path/hash/size is invalid; artifact not published",
        502,
      );
    return { name: posix.basename(raw.path), bytes };
  }
  async writePdf(owner: string, path: string, bytes: Uint8Array) {
    if (bytes.length > 10 * 1024 * 1024 || Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-")
      throw new AppError("Choose a PDF of 10 MB or smaller", 422);
    return this.writeBytes(owner, path, bytes);
  }
  async pdfBytes(owner: string, path: string) {
    const result = await this.fileBytes(owner, path);
    if (
      result.bytes.length > 10 * 1024 * 1024 ||
      result.bytes.subarray(0, 5).toString() !== "%PDF-"
    )
      throw new AppError("Choose a PDF of 10 MB or smaller", 422);
    return result;
  }
}
