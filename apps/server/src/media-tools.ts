import { createHash } from "node:crypto";
import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import { rasterMime } from "../../../packages/domain/src/attachments.ts";
import type { ComputerCommand } from "../../../packages/domain/src/computer.ts";
import { ActionLog } from "./action-log.ts";
import { base64Limit, decodeBase64 } from "./base64.ts";
import { type ComputerBackend, commandReceiptSchema } from "./computer-contract.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { ResourceBusyError } from "./engine/resource-leases.ts";
import { RuntimePausedError } from "./engine/runtime-pause.ts";
import { AppError } from "./errors.ts";
import type { Files } from "./files.ts";
import { modelProviderConfig } from "./providers/config.ts";
import { imageProvider } from "./providers/images.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const imageArgs = z.object({
  prompt: z.string().trim().min(1).max(8000),
  operationId: z.string().min(1).max(120),
});
export class MediaService {
  constructor(
    readonly db: Store,
    readonly files: Files,
    readonly config: Config,
    readonly upstream: typeof fetch = fetch,
  ) {}
  async generatedImage(
    owner: string,
    model: string | undefined,
    raw: unknown,
    scope: string,
    signal?: AbortSignal,
    beforeDispatch?: () => Promise<void>,
  ): Promise<Awaited<ReturnType<Files["reference"]>> | { disabled: boolean; message: string }> {
    const args = imageArgs.parse(raw);
    const provider = model
      ? imageProvider(
          model,
          this.config.modelProviders ?? modelProviderConfig(this.config.dataDir),
          this.upstream,
        )
      : undefined;
    if (!provider)
      return {
        disabled: true,
        message:
          "Image generation is disabled for the selected provider. Configure its documented image model/endpoint; ChatGPT Sign in and MiMo do not expose an image route here.",
      };
    const id = hash(`${scope}:${args.operationId}`);
    type Receipt = {
      id: string;
      binding: string;
      status: "pending" | "succeeded" | "uncertain";
      fileId?: string;
    };
    const binding = hash(JSON.stringify({ model, prompt: args.prompt }));
    const previous = await this.db.get<Receipt>(owner, "image-generations", id);
    if (previous) {
      if (previous.binding !== binding)
        throw new AppError("Operation ID already belongs to a different image request", 409);
      if (previous.status === "succeeded" && previous.fileId)
        return this.files.reference(owner, previous.fileId);
      throw new AppError(
        "Image request outcome is unknown or pending; it will not be repeated automatically",
        409,
      );
    }
    if (
      !(await this.db.insertIfAbsent(owner, "image-generations", {
        id,
        binding,
        status: "pending",
      }))
    )
      return this.generatedImage(owner, model, args, scope, signal);
    const audit = {
      operationId: `image:${id}`,
      tool: "generate_image",
      target: "Selected image provider",
      summary: "Generate image",
    };
    await new ActionLog(this.db).append(owner, audit, "started");
    let dispatchGuardPassed = false;
    try {
      await beforeDispatch?.();
      dispatchGuardPassed = true;
      const response = await provider.generate(
        {
          prompt: args.prompt,
          n: 1,
          ...(!provider.model.startsWith("gpt-image-") && { response_format: "b64_json" }),
        },
        signal,
      );
      const reader = response.body?.getReader();
      if (!reader) throw new AppError("Image provider returned no image", 502);
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 12 * 1024 * 1024) {
          await reader.cancel();
          throw new AppError("Generated image exceeds the size limit", 413);
        }
        chunks.push(value);
      }
      const data = z
        .object({
          data: z
            .array(
              z.object({
                b64_json: z
                  .string()
                  .min(4)
                  .max(base64Limit(8 * 1024 * 1024)),
              }),
            )
            .length(1),
        })
        .safeParse(JSON.parse(Buffer.concat(chunks).toString()));
      if (!data.success)
        throw new AppError(
          "Image provider must return bounded base64 image data; URL downloads are not enabled",
          502,
        );
      const bytes = decodeBase64(data.data.data[0].b64_json, 8 * 1024 * 1024);
      if (!bytes) throw new AppError("Image provider must return bounded base64 image data", 502);
      const mime = rasterMime(bytes);
      if (!mime || bytes.length > 8 * 1024 * 1024)
        throw new AppError(
          "Provider returned an invalid or oversized PNG, JPEG or WebP image",
          422,
        );
      const file = await this.files.importAttachment(
        owner,
        `image-${id.slice(0, 10)}.${mime === "image/jpeg" ? "jpg" : mime.split("/")[1]}`,
        bytes,
        "Generated image",
        mime,
      );
      await this.db.put(owner, "image-generations", {
        id,
        binding,
        status: "succeeded",
        fileId: file.id,
      });
      await new ActionLog(this.db).finish(owner, audit, "succeeded");
      return this.files.reference(owner, file.id);
    } catch (error) {
      if (!dispatchGuardPassed) {
        await new ActionLog(this.db).finish(owner, audit, "rejected_not_dispatched");
        await this.db.remove(owner, "image-generations", id);
        throw error;
      }
      await new ActionLog(this.db).finish(owner, audit, "outcome_unknown");
      await this.db.put(owner, "image-generations", { id, binding, status: "uncertain" });
      throw error;
    }
  }
  async completed(owner: string, computer: ComputerBackend, receipt: ComputerCommand) {
    if (receipt.status !== "succeeded" || !receipt.result) return receipt;
    const paths = [
      receipt.result.textPath,
      receipt.result.srtPath,
      receipt.result.previewPath,
    ].filter((path): path is string => Boolean(path));
    const attachments = [];
    for (const path of paths) {
      const id = hash(`${receipt.id}:${path}`);
      const previous = await this.db.get<{ id: string; fileId: string }>(
        owner,
        "computer-outputs",
        id,
      );
      let fileId = previous?.fileId;
      if (!fileId) {
        const { name, bytes } = await computer.fileBytes(owner, path);
        const file = await this.files.importAttachment(
          owner,
          name,
          bytes,
          receipt.kind === "transcribe" ? "Transcript" : "Office preview",
        );
        await this.db.put(owner, "computer-outputs", { id, fileId: file.id });
        fileId = file.id;
      }
      attachments.push(await this.files.reference(owner, fileId));
    }
    return { ...receipt, attachments };
  }
}

export const mediaInstructions =
  "Use transcribe for owned audio/video in the computer: offline Whisper small CPU int8 detects Portuguese, English and German; optionally override language. Use preview_computer_file for Office-to-PDF. Long media jobs may run in background; poll computer_command_status and report actual receipts. Completed media returns owned attachment IDs, never claim success before completion. generate_image uses only the currently selected provider's explicitly configured capability and never falls back to a billed image API. Disabled capability is reported clearly. Never repeat a pending/uncertain image generation automatically.";

export function mediaTools(
  media: MediaService,
  computer: ComputerBackend,
  owner: string,
  scope: string,
  options: {
    model: () => string | undefined;
    signal?: AbortSignal;
    before?: () => Promise<void>;
    effectBefore?: () => Promise<void>;
    artifact?: (id: string) => Promise<void>;
    onComputerDispatch?: (receiptId: string) => Promise<void>;
    onComputerReceipt?: (receipt: z.infer<typeof commandReceiptSchema>) => Promise<void>;
    onWaitingJob?: (receipt: { id: string; uncertain?: boolean }) => Promise<void>;
    queue?: <T>(operation: () => Promise<T>) => Promise<T>;
  },
) {
  const tool = <T extends z.ZodType>(
    name: string,
    description: string,
    parameters: T,
    action: (args: z.output<T>) => Promise<unknown>,
    automatedEffect = false,
  ) =>
    defineTool({
      name,
      description,
      parameters,
      execute: (args) => {
        const operation = async () => {
          try {
            await options.before?.();
            if (automatedEffect) await options.effectBefore?.();
            options.signal?.throwIfAborted();
            const result = await action(parameters.parse(args));
            const receipt = commandReceiptSchema.safeParse(result);
            if (automatedEffect && receipt.success) {
              if (["succeeded", "failed", "rejected_not_dispatched"].includes(receipt.data.status))
                await options.onComputerReceipt?.(receipt.data);
              else
                await options.onWaitingJob?.({
                  id: receipt.data.id,
                  ...(["interrupted", "timed_out"].includes(receipt.data.status) && {
                    uncertain: true,
                  }),
                });
            }
            const refs = z
              .object({
                fileId: z.string().optional(),
                attachments: z.array(z.object({ fileId: z.string() })).optional(),
              })
              .safeParse(result);
            if (refs.success)
              for (const id of [
                refs.data.fileId,
                ...(refs.data.attachments ?? []).map((a) => a.fileId),
              ].filter((id): id is string => Boolean(id)))
                await options.artifact?.(id);
            return result;
          } catch (error) {
            if (
              error instanceof RuntimePausedError ||
              error instanceof ResourceBusyError ||
              (error instanceof Error && error.name === "LostLeaseError")
            )
              throw error;
            const commandId =
              error && typeof error === "object" && "computerCommandId" in error
                ? String(error.computerCommandId)
                : undefined;
            if (automatedEffect && commandId && options.onWaitingJob) {
              await options.onWaitingJob({ id: commandId, uncertain: true });
              return { id: commandId, status: "running", outcomeUnknown: true };
            }
            return { error: error instanceof Error ? error.message : "Media processing failed" };
          }
        };
        return options.queue ? options.queue(operation) : operation();
      },
    });
  const runMedia = async (
    kind: "transcribe" | "preview",
    args: {
      path?: string;
      fileId?: string;
      operationId: string;
      language?: "auto" | "pt" | "en" | "de";
      textPath?: string;
      srtPath?: string;
      outputPath?: string;
      timeoutMs?: number;
      background?: boolean;
    },
  ) => {
    if (!computer.media)
      return {
        disabled: true,
        message: "Transcription and Office previews require the open RPC computer image.",
      };
    let path = args.path;
    if (args.fileId) {
      const file = await media.files.get(owner, args.fileId);
      path ??= `/workspace/${file.name}`;
      await computer.writeBytes(owner, path, await media.files.bytes(owner, file.id));
    }
    if (!path) throw new AppError("Choose a workspace path or an owned attachment ID", 422);
    const { fileId: _, operationId, ...parameters } = args;
    const receipt = await computer.media(
      owner,
      kind,
      { ...parameters, path },
      {
        idempotencyKey: `${scope}:${operationId}`,
        signal: options.signal,
        dispatchGuard: options.effectBefore ?? options.before,
        onDispatch: options.onComputerDispatch,
      },
    );
    return media.completed(owner, computer, receipt);
  };
  return [
    tool(
      "view_file",
      "Inspect an owned raster image attachment using the model's image input capability",
      z.object({ fileId: z.string().min(1).max(128) }),
      async ({ fileId }) => {
        const file = await media.files.get(owner, fileId);
        if (!file.mimeType.startsWith("image/") || file.size > 8 * 1024 * 1024)
          return {
            disabled: true,
            message:
              "Image input requires a raster image of 8 MB or smaller. Use the computer to resize it or process other file types.",
          };
        return media.files.reference(owner, fileId);
      },
    ),
    tool(
      "generate_image",
      "Generate an image via the selected provider's configured image capability",
      imageArgs,
      (args) =>
        media.generatedImage(
          owner,
          options.model(),
          args,
          scope,
          options.signal,
          options.effectBefore ?? options.before,
        ),
      true,
    ),
    tool(
      "transcribe",
      "Transcribe owned audio/video offline and return text plus optional downloadable SRT",
      z.object({
        path: z.string().max(2048).optional(),
        fileId: z.string().max(128).optional(),
        language: z.enum(["auto", "pt", "en", "de"]).default("auto"),
        textPath: z.string().max(2048).optional(),
        srtPath: z.string().max(2048).optional(),
        timeoutMs: z.number().int().min(1000).max(1800000).optional(),
        background: z.boolean().default(false),
        operationId: z.string().min(1).max(120),
      }),
      (args) => runMedia("transcribe", args),
      true,
    ),
    tool(
      "preview_computer_file",
      "Convert an Office file to a downloadable PDF inside the computer",
      z.object({
        path: z.string().min(1).max(2048),
        outputPath: z.string().max(2048).optional(),
        background: z.boolean().default(false),
        operationId: z.string().min(1).max(120),
      }),
      (args) => runMedia("preview", args),
      true,
    ),
    tool(
      "computer_command_status",
      "Read an owned durable command/media job and return completed attachments",
      z.object({ id: z.string().min(1).max(128) }),
      async ({ id }) => {
        if (!computer.command)
          return { disabled: true, message: "Background jobs require the open RPC computer." };
        return media.completed(owner, computer, await computer.command(owner, id));
      },
    ),
    tool(
      "cancel_computer_command",
      "Cancel an owned background job; inspect the interruption receipt",
      z.object({ id: z.string().min(1).max(128) }),
      async ({ id }) => {
        if (!computer.cancel)
          return { disabled: true, message: "Background jobs require the open RPC computer." };
        return computer.cancel(owner, id);
      },
    ),
  ];
}
