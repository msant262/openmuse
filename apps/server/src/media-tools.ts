import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { defineTool } from "@copilotkit/runtime/v2";
import { loadImage } from "@napi-rs/canvas";
import { z } from "zod";
import { rasterMime } from "../../../packages/domain/src/attachments.ts";
import type { ComputerCommand } from "../../../packages/domain/src/computer.ts";
import {
  createDocumentPdf,
  documentCharacterLimit,
} from "../../../packages/integrations/src/document.ts";
import { createDocumentDocx } from "../../../packages/integrations/src/document-docx.ts";
import { documentImageSize } from "../../../packages/integrations/src/document-image.ts";
import {
  composeDocument,
  type DocumentDesign,
  type DocumentImage,
  defaultDocumentTheme,
  documentDesignSchema,
} from "../../../packages/integrations/src/document-model.ts";
import { createDocumentPptx } from "../../../packages/integrations/src/document-pptx.ts";
import {
  documentRendererVersion,
  renderDocument,
} from "../../../packages/integrations/src/document-render.ts";
import { ActionLog } from "./action-log.ts";
import { base64Limit, decodeBase64 } from "./base64.ts";
import {
  type ComputerBackend,
  commandReceiptSchema,
  computerCommandCleanupConfirmed,
} from "./computer-contract.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { getDesignProfile, getDesignReference } from "./design-catalog.ts";
import { DocumentReview } from "./document-review.ts";
import { ResourceBusyError } from "./engine/resource-leases.ts";
import { RuntimePausedError } from "./engine/runtime-pause.ts";
import { authorizeTaskEffect, taskOperationId } from "./engine/task-journal.ts";
import { AppError } from "./errors.ts";
import type { Files } from "./files.ts";
import { modelProviderConfig } from "./providers/config.ts";
import { ImageNotDispatchedError } from "./providers/image-errors.ts";
import { availableImageModels, imageProvider } from "./providers/images.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const hashBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const imageArgs = z.object({
  prompt: z.string().trim().min(1).max(8000),
  operationId: z.string().min(1).max(120),
  name: z.string().trim().min(1).max(120).optional(),
  provider: z.enum(["auto", "chatgpt", "grok", "selected"]).default("auto"),
  aspectRatio: z.enum(["1:1", "3:4", "4:3", "9:16", "16:9"]).optional(),
});
const documentArgs = z
  .object({
    name: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(200).optional(),
    content: z
      .string()
      .min(1)
      .max(documentCharacterLimit)
      .refine(
        (value) =>
          value.trim().length > 0 &&
          Buffer.from(value, "utf8").toString("utf8") === value &&
          Array.from(value).every(
            (character) =>
              [9, 10, 13].includes(character.charCodeAt(0)) ||
              (character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
          ),
        "Use nonempty document text without control characters",
      ),
    format: z.enum(["pdf", "docx", "pptx", "text", "markdown"]).default("pdf"),
    design: documentDesignSchema.optional(),
    replaceFileId: z.string().min(1).max(128).optional(),
    operationId: z.string().min(1).max(120),
  })
  .strict();
type AppliedDocumentDesign = {
  reference: string;
  layout: NonNullable<DocumentDesign["layout"]>;
  display: NonNullable<DocumentDesign["display"]>;
  palette: NonNullable<DocumentDesign["palette"]>;
  rationale?: string;
};
type DocumentGeneration = {
  id: string;
  binding: string;
  fileId?: string;
  sha256?: string;
  scope?: string;
  designVersion?: number;
  replacesFileId?: string;
  design?: AppliedDocumentDesign;
  title?: string;
  createdAt?: string;
};
export class MediaService {
  readonly documentReview: DocumentReview;
  constructor(
    readonly db: Store,
    readonly files: Files,
    readonly config: Config,
    readonly upstream: typeof fetch = fetch,
  ) {
    this.documentReview = new DocumentReview(db, files);
  }
  async recentDocumentDesigns(owner: string) {
    const generations = (await this.db.list<DocumentGeneration>(owner, "document-generations"))
      .filter(
        (entry): entry is DocumentGeneration & { fileId: string; design: AppliedDocumentDesign } =>
          Boolean(entry.fileId && entry.design),
      )
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    const seen = new Set<string>();
    return generations
      .filter((entry) => {
        const key = entry.scope?.startsWith("task:") ? entry.scope : entry.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 5)
      .map((entry) => ({
        reference: entry.design.reference,
        layout: entry.design.layout,
        ...(entry.title && { title: entry.title.slice(0, 100) }),
      }));
  }
  async createDocument(owner: string, raw: unknown, scope: string) {
    const args = documentArgs.parse(raw);
    const operationId = taskOperationId() ?? `${scope}:${args.operationId}`;
    const id = hash(operationId);
    const binding = hash(JSON.stringify(args));
    const designed = ["pdf", "docx", "pptx"].includes(args.format);
    type Receipt = DocumentGeneration;
    if (args.replaceFileId) {
      const task = scope.startsWith("task:")
        ? await this.db.get<{ id: string; artifactIds: string[] }>(owner, "tasks", scope.slice(5))
        : undefined;
      const old = (await this.db.list<Receipt>(owner, "document-generations")).find(
        (entry) => entry.fileId === args.replaceFileId && entry.scope === scope,
      );
      if (!task?.artifactIds.includes(args.replaceFileId) || !old) {
        // Idempotent retries may occur after the replacement was attached already.
        const completed = await this.db.get<Receipt>(owner, "document-generations", id);
        if (
          !completed?.fileId ||
          completed.binding !== binding ||
          completed.replacesFileId !== args.replaceFileId ||
          !task?.artifactIds.includes(completed.fileId)
        )
          throw new AppError("Only a document draft belonging to this task can be replaced", 409);
      }
    }
    const reference = async (fileId: string, design?: AppliedDocumentDesign) => ({
      ...(await this.files.reference(owner, fileId)),
      ...(design && { design }),
      ...(args.replaceFileId && { replacesFileId: args.replaceFileId }),
      ...(designed && {
        designReview: {
          required: true,
          next: "inspect_document, inspect the returned page images, then confirm_document_review for every page before finish_task",
        },
      }),
    });
    const previous =
      (await this.db.insertIfAbsent<Receipt>(owner, "document-generations", {
        id,
        binding,
        scope,
        ...(designed && { designVersion: 2 }),
        ...(args.replaceFileId && { replacesFileId: args.replaceFileId }),
      })) ?? (await this.db.get<Receipt>(owner, "document-generations", id));
    if (!previous || previous.binding !== binding)
      throw new AppError("Operation ID already belongs to a different document request", 409);
    if (previous.fileId) {
      if (hashBytes(await this.files.bytes(owner, previous.fileId)) !== previous.sha256)
        throw new AppError("Published document content no longer matches its receipt", 409);
      return reference(previous.fileId, previous.design);
    }
    const extension = { pdf: "pdf", docx: "docx", pptx: "pptx", text: "txt", markdown: "md" }[
      args.format
    ];
    const baseName =
      args.name
        .split(/[\\/]/)
        .at(-1)
        ?.replace(/\.[^.]+$/, "") ?? "document";
    const name = `${
      Array.from(baseName)
        .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
        .join("") || "document"
    }.${extension}`;
    let bytes: Uint8Array;
    let intention = previous;
    let appliedDesign: AppliedDocumentDesign | undefined;
    if (designed) {
      const referenceId = args.design?.reference ?? "claude";
      const profile = await getDesignProfile(referenceId);
      const source = profile ? undefined : await getDesignReference(referenceId);
      if (!profile && !source)
        throw new AppError(
          "Unknown document reference; use design_references for an exact reference ID",
          422,
        );
      if (!profile && (!args.design?.palette || !args.design.layout || !args.design.display))
        throw new AppError(
          "This reference has no preset palette. Read it and supply design.palette (paper, ink, muted, accent, surface), design.layout and design.display to adapt its visual direction.",
          422,
        );
      const images = new Map<string, DocumentImage>();
      const model = composeDocument(
        args.content,
        args.title,
        args.design,
        profile
          ? { id: profile.id, label: profile.label, display: profile.display, ...profile.tokens }
          : { ...defaultDocumentTheme, id: referenceId, label: source?.title ?? referenceId },
        images,
      );
      const { paper, ink, muted, accent, surface } = model.theme;
      appliedDesign = {
        reference: referenceId,
        layout: model.design.layout ?? "editorial",
        display: model.theme.display,
        palette: { paper, ink, muted, accent, surface },
        ...(model.design.rationale && { rationale: model.design.rationale }),
      };
      intention = {
        ...previous,
        design: appliedDesign,
        title: args.title ?? model.title,
        createdAt: previous.createdAt ?? new Date().toISOString(),
      };
      await this.db.put(owner, "document-generations", intention);
      const ids = [
        ...new Set(model.blocks.flatMap((block) => (block.type === "image" ? [block.fileId] : []))),
      ];
      if (ids.length > 12)
        throw new AppError("A document supports at most 12 image attachments", 422);
      for (const imageId of ids) {
        const image = await this.files.get(owner, imageId);
        if (!["image/png", "image/jpeg"].includes(image.mimeType) || image.size > 8 * 1024 * 1024)
          throw new AppError("Document images must be owned PNG/JPEG attachments up to 8 MB", 422);
        const imageBytes = await this.files.bytes(owner, imageId);
        const dimensions = documentImageSize(imageBytes);
        const decoded = await loadImage(imageBytes);
        if (decoded.width !== dimensions.width || decoded.height !== dimensions.height)
          throw new AppError("Document image dimensions do not match its header", 422);
        images.set(imageId, {
          id: imageId,
          bytes: imageBytes,
          mimeType: image.mimeType as "image/png" | "image/jpeg",
          width: decoded.width,
          height: decoded.height,
        });
      }
      bytes =
        args.format === "pdf"
          ? await createDocumentPdf(model)
          : args.format === "docx"
            ? await createDocumentDocx(model)
            : await createDocumentPptx(model);
    } else bytes = Buffer.from(args.content, "utf8");
    const file = await this.files.importAttachment(
      owner,
      name,
      bytes,
      "Created document",
      undefined,
      operationId,
    );
    const sha256 = hashBytes(bytes);
    if (hashBytes(await this.files.bytes(owner, file.id)) !== sha256)
      throw new AppError("Document persistence verification failed", 409);
    await this.db.put(owner, "document-generations", { ...intention, fileId: file.id, sha256 });
    return reference(file.id, appliedDesign);
  }
  /** Cached private reader preview; authored bytes are checked before Office conversion. */
  async previewDocument(owner: string, fileId: string, signal?: AbortSignal) {
    const file = await this.files.get(owner, fileId);
    const generation = (await this.db.list<DocumentGeneration>(owner, "document-generations")).find(
      (item) => item.fileId === fileId && item.designVersion === 2,
    );
    if (!generation) throw new AppError("Only server-authored documents use this preview", 422);
    const bytes = await this.files.bytes(owner, fileId);
    if (hashBytes(bytes) !== generation.sha256)
      throw new AppError("Document bytes differ from their authoring receipt", 409);
    const id = hash(`${fileId}:${generation.sha256}:${documentRendererVersion}`);
    const cached = await this.db.get<{ fileId: string }>(owner, "document-reader-previews", id);
    if (cached) return this.files.signed(owner, await this.files.get(owner, cached.fileId));
    const format = file.mimeType.includes("presentationml")
      ? "pptx"
      : file.mimeType.includes("wordprocessingml")
        ? "docx"
        : undefined;
    if (!format) throw new AppError("Document format cannot be previewed", 422);
    const rendered = await renderDocument(bytes, format, 1, 1, signal);
    signal?.throwIfAborted();
    const preview = await this.files.importAttachment(
      owner,
      file.name.replace(/\.[^.]+$/, ".pdf"),
      rendered.pdfBytes,
      "Document reader preview",
      "application/pdf",
      `reader:${id}`,
      true,
    );
    await this.db.put(owner, "document-reader-previews", { id, fileId: preview.id });
    return this.files.signed(owner, preview);
  }
  async inspectDocument(
    owner: string,
    args: { fileId: string; startPage: number; pageCount: number },
    scope: string,
    revision: number,
    signal?: AbortSignal,
  ) {
    const generation = (await this.db.list<DocumentGeneration>(owner, "document-generations")).find(
      (item) => item.fileId === args.fileId && item.designVersion === 2,
    );
    if (!generation)
      throw new AppError(
        "Inspect a document authored by create_document; arbitrary imported files are not passed to the Office renderer",
        422,
      );
    const file = await this.files.get(owner, args.fileId),
      bytes = await this.files.bytes(owner, args.fileId);
    if (hashBytes(bytes) !== generation.sha256)
      throw new AppError("Document bytes differ from their authoring receipt", 409);
    const format =
      file.mimeType === "application/pdf"
        ? "pdf"
        : file.mimeType.includes("wordprocessingml")
          ? "docx"
          : file.mimeType.includes("presentationml")
            ? "pptx"
            : undefined;
    if (!format) throw new AppError("Document format cannot be rendered", 422);
    const rendered = await renderDocument(bytes, format, args.startPage, args.pageCount, signal);
    signal?.throwIfAborted();
    const preview = await this.files.importAttachment(
      owner,
      `document-review-${args.startPage}-${args.startPage + rendered.pages.length - 1}.png`,
      rendered.bytes,
      "Document visual inspection",
      "image/png",
      taskOperationId() ??
        `${scope}:document-preview:${hash(JSON.stringify({ fileId: file.id, sha256: generation.sha256, pages: rendered.pages, renderer: documentRendererVersion }))}`,
      true,
    );
    const inspection = await this.documentReview.recordInspection(owner, {
      scope,
      revision,
      fileId: file.id,
      sha256: generation.sha256,
      pageCount: rendered.pageCount,
      pages: rendered.pages,
      previewFileId: preview.id,
      rendererVersion: documentRendererVersion,
    });
    return {
      ...(await this.files.reference(owner, preview.id)),
      attachment: false,
      receiptId: inspection.receiptId,
      documentFileId: file.id,
      documentSha256: generation.sha256,
      ...(generation.design && { design: generation.design }),
      pageCount: rendered.pageCount,
      pages: rendered.pages,
      nextPage: rendered.pages.at(-1)! < rendered.pageCount ? rendered.pages.at(-1)! + 1 : null,
      instruction:
        "Examine the actual pixels against the applied design and its rationale, not only clipping/readability. Assess dominant message, hierarchy, typography, meaningful composition/visuals and consistency with the intended audience. Report concrete mismatches (for example all slides use the same text layout despite a process/comparison brief); ordinary whitespace is not a defect. Do not approve a generic template merely because it has no overlap. Use confirm_document_review in the next turn. Correct a failed draft with create_document.replaceFileId and a fresh operationId, then inspect its new bytes.",
    };
  }
  async imageCapabilities(model: string | undefined) {
    const config = this.config.modelProviders ?? modelProviderConfig(this.config.dataDir);
    const models = await availableImageModels(model, config);
    return {
      available: models.length > 0,
      providers: models.map((spec) => ({
        provider: spec.split("/")[0],
        model: imageProvider(spec, config)?.model,
        subscription: /^(codex|grok|xai-oauth)\//.test(spec),
      })),
      ...(existsSync(config.chatgptFile) && {
        chatgpt: {
          connected: true,
          imageGeneration: models.some((model) => model.startsWith("codex/")),
          reason: models.some((model) => model.startsWith("codex/"))
            ? undefined
            : "Connect GPT Image separately in Settings using ChatGPT device authorization. The existing chat token-sharing grant does not include image_generation. No paid API key is required or used automatically.",
        },
      }),
      unavailable: models.length
        ? undefined
        : "Connect an image-capable subscription or explicitly configure an image provider in Settings.",
    };
  }
  async generatedImage(
    owner: string,
    model: string | undefined,
    raw: unknown,
    scope: string,
    signal?: AbortSignal,
    beforeDispatch?: () => Promise<void>,
  ): Promise<Awaited<ReturnType<Files["reference"]>> | { disabled: boolean; message: string }> {
    const args = imageArgs.parse(raw);
    const config = this.config.modelProviders ?? modelProviderConfig(this.config.dataDir);
    const available = await availableImageModels(model, config);
    const imageModel =
      args.provider === "selected"
        ? model
        : args.provider === "chatgpt"
          ? available.find((spec) => spec.startsWith("codex/"))
          : args.provider === "grok"
            ? available.find((spec) => /^(grok|xai-oauth)\//.test(spec))
            : available[0];
    const provider = imageModel ? imageProvider(imageModel, config, this.upstream) : undefined;
    if (!provider)
      return {
        disabled: true,
        message:
          "No connected image generator is available for this selection. Check image_generation_status and connect an image-capable subscription in Settings.",
      };
    const id = hash(taskOperationId() ?? `${scope}:${args.operationId}`);
    type Receipt = {
      id: string;
      binding: string;
      status: "pending" | "succeeded" | "uncertain";
      fileId?: string;
    };
    const binding = hash(
      JSON.stringify({
        provider: args.provider,
        prompt: args.prompt,
        aspectRatio: args.aspectRatio,
      }),
    );
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
      await authorizeTaskEffect();
      dispatchGuardPassed = true;
      const response = await provider.generate(
        {
          prompt: args.prompt,
          n: 1,
          ...(args.aspectRatio && { aspect_ratio: args.aspectRatio }),
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
        `${
          (args.name ?? "image")
            .replace(/[^\p{L}\p{N} _.-]/gu, "")
            .replace(/\.[^.]+$/, "")
            .slice(0, 100) || "image"
        }-${id.slice(0, 6)}.${mime === "image/jpeg" ? "jpg" : mime.split("/")[1]}`,
        bytes,
        args.name ?? "Generated image",
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
      if (!dispatchGuardPassed || error instanceof ImageNotDispatchedError) {
        await new ActionLog(this.db).finish(owner, audit, "rejected_not_dispatched");
        await this.db.remove(owner, "image-generations", id);
        throw error;
      }
      await new ActionLog(this.db).finish(owner, audit, "outcome_unknown");
      await this.db.put(owner, "image-generations", { id, binding, status: "uncertain" });
      throw error;
    }
  }
  async completed(
    owner: string,
    computer: ComputerBackend,
    receipt: ComputerCommand,
    options: {
      readOutput?: (path: string, id: string) => Promise<{ name: string; bytes: Uint8Array }>;
      beforePublish?: () => Promise<void>;
    } = {},
  ) {
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
        const { name, bytes } = options.readOutput
          ? await options.readOutput(path, id)
          : await computer.fileBytes(owner, path, { idempotencyKey: `media-output:${id}` });
        await options.beforePublish?.();
        const version = createHash("sha256").update(bytes).digest("hex");
        const versionId = hash(`${id}:${version}`);
        const file = await this.files.importAttachment(
          owner,
          name,
          bytes,
          receipt.kind === "transcribe"
            ? name.toLowerCase().endsWith(".srt")
              ? "Transcript subtitles"
              : "Transcript"
            : "Office preview",
          undefined,
          `computer-output:${versionId}`,
        );
        await this.db.put(owner, "computer-outputs", {
          id,
          fileId: file.id,
          version,
          versionId,
        });
        fileId = file.id;
      }
      attachments.push(await this.files.reference(owner, fileId));
    }
    return { ...receipt, attachments };
  }
}

export const mediaInstructions =
  "For PDF, DOCX and PPTX, read the document-design skill and the format skill before composing. Use design_references recommend/read to compare suitable directions. Apply the chosen reference with explicit design.layout, display, palette and rationale; all catalog references are usable, not only the legacy presets. Critique the rendered composition against that intent, not only overflow. create_document accepts complete Markdown with headings, emphasis, lists, tables, quotes, owned file: images and chart/metrics/steps JSON blocks; it creates designed PDF or native editable DOCX/PPTX without a computer or source form. Choose design.reference, subtitle, eyebrow, footer and cover when useful. Do not substitute unformatted prose for an authored document. After creating a draft, call inspect_document in batches, examine the returned page pixels, then confirm_document_review in the next model turn. Review every page before finish_task. Correct problems by creating a fresh operation with replaceFileId for the current task draft and inspecting the new bytes. Internal previews are not deliverables. Text and Markdown formats preserve exact UTF-8. Use fill_pdf only for existing forms. For an image, illustration, poster or infographic, use generate_image to create the actual downloadable image. For an infographic about current facts, first research and verify sources, then include the exact verified facts, dates, labels and source names in a detailed visual prompt in the user's language; do not stop at a text outline. The image generator is independent of the chat model: image_generation_status lists connected image capabilities, including subscriptions. Auto selection prefers separately connected GPT Image through ChatGPT/Codex authorization, then Grok Imagine, independently of the chat model. For an explicit ChatGPT/GPT Image request use provider chatgpt; for Grok use provider grok. If the requested provider is not connected, show its Settings connection rather than substitute a different provider. Never add a billed API implicitly. No email or PDF attachment is needed to create an image. Give the image a descriptive name. Generated attachments are delivered automatically; refer to them naturally without exposing internal IDs. Use transcribe for owned audio/video in the computer; use preview_computer_file for Office-to-PDF. Long computer media jobs may run in background; poll computer_command_status and report actual receipts. Never claim success before a completed file receipt or repeat a pending/uncertain generation automatically.";

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
    artifact?: (id: string, replacesFileId?: string) => Promise<void>;
    revision?: () => number;
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
              if (computerCommandCleanupConfirmed(receipt.data))
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
                attachment: z.boolean().optional(),
                fileId: z.string().optional(),
                replacesFileId: z.string().optional(),
                attachments: z.array(z.object({ fileId: z.string() })).optional(),
              })
              .safeParse(result);
            if (refs.success && refs.data.attachment !== false && name !== "inspect_document")
              for (const id of [
                refs.data.fileId,
                ...(refs.data.attachments ?? []).map((a) => a.fileId),
              ].filter((id): id is string => Boolean(id)))
                if (!(await media.files.get(owner, id)).internal)
                  await options.artifact?.(id, refs.data.replacesFileId);
            return result;
          } catch (error) {
            if (
              error instanceof RuntimePausedError ||
              error instanceof ResourceBusyError ||
              (error instanceof Error &&
                [
                  "LostLeaseError",
                  "TaskAbortError",
                  "TaskSupersededError",
                  "TaskValidityExpiredError",
                  "TaskOutcomeUnknownError",
                ].includes(error.name))
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
            return {
              error: error instanceof Error ? error.message : "Media processing failed",
              ...(error &&
              typeof error === "object" &&
              "outcomeUnknown" in error &&
              error.outcomeUnknown === true
                ? { outcomeUnknown: true }
                : {}),
            };
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
        idempotencyKey: taskOperationId() ?? `${scope}:${operationId}`,
        signal: options.signal,
        dispatchGuard: options.effectBefore ?? options.before,
        onDispatch: options.onComputerDispatch,
      },
    );
    return media.completed(owner, computer, receipt);
  };
  return [
    tool(
      "create_document",
      "Compose a designed PDF or editable DOCX/PPTX from complete Markdown content, locally. Read document-design and format skill first. Supports headings, emphasis, lists, tables, quotes, owned file: images and chart/metrics/steps JSON fences. Choose design.reference from the full design_references catalog. Set layout (editorial/briefing/signal), display (serif/sans/mono), palette (paper/ink/muted/accent/surface hex colors) and rationale. Non-preset references require palette/layout/display. Optional subtitle, eyebrow, footer and cover. Text/markdown preserve exact UTF-8. Maximum120000 characters/100 PDF pages. Returns a draft attachment requiring inspect_document and visual review before completion. For a correction use replaceFileId of this task's draft plus a fresh operationId; other deliverables stay attached.",
      documentArgs,
      (args) => media.createDocument(owner, args, scope),
      true,
    ),
    tool(
      "inspect_document",
      "Render 1–4 pages of an owned server-authored PDF/DOCX/PPTX into a visual contact sheet. Actual page pixels are supplied to the next model turn. Inspect hierarchy, overlap, clipping, spacing and data; then confirm_document_review. Repeat until all pages are reviewed. Previews are internal and are not delivered as attachments.",
      z.object({
        fileId: z.string().min(1).max(128),
        startPage: z.number().int().min(1).max(100).default(1),
        pageCount: z.number().int().min(1).max(4).default(2),
      }),
      (args) =>
        media.inspectDocument(owner, args, scope, options.revision?.() ?? 0, options.signal),
      true,
    ),
    tool(
      "image_generation_status",
      "List connected image generators independently of the chat model; returns capability and subscription status without credentials",
      z.object({}),
      async () => media.imageCapabilities(options.model()),
    ),
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
      "Create an actual image, poster or infographic using an available connected image generator. Auto uses subscription image generation independently of the chat model. Provide a complete visual prompt with verified facts and a descriptive name. Returns a downloadable image attachment.",
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
