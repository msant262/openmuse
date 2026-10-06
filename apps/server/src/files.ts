import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  attachmentLimit,
  attachmentMime,
  rasterMime,
} from "../../../packages/domain/src/attachments.ts";
import type { Artifact } from "../../../packages/domain/src/index.ts";
import { fillPdf, inspectPdf } from "../../../packages/integrations/src/pdf.ts";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { authorizeTaskEffect, taskOperationId } from "./engine/task-journal.ts";
import { AppError } from "./errors.ts";

export class Files {
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly auth: Auth,
  ) {}
  async importAttachment(
    owner: string,
    name: string,
    bytes: Uint8Array,
    source: string,
    mimeType?: string,
    operationId: string | undefined = taskOperationId(),
    internal = false,
  ): Promise<Artifact> {
    if (bytes.length > attachmentLimit)
      throw new AppError("Attachments must be 25 MB or smaller", 413);
    const mime = attachmentMime(name, mimeType);
    if (mime === "application/pdf")
      return this.import(owner, name, bytes, source, undefined, operationId);
    if (mime.startsWith("image/") && rasterMime(bytes) !== mime)
      throw new AppError("The image content does not match its file type", 422);
    const safeName = this.safeName(name);
    const id = operationId
      ? createHash("sha256").update(`${owner}:file:${operationId}:${safeName}`).digest("hex")
      : randomUUID();
    const artifact: Artifact = {
      id,
      name: safeName,
      mimeType: mime,
      size: bytes.length,
      pageCount: 0,
      url: "",
      createdAt: new Date().toISOString(),
      source,
      ...(internal && { internal: true }),
    };
    const directory = join(this.config.dataDir, "files");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.publish(owner, artifact, bytes, join(directory, `${id}.bin`), operationId);
    return this.signed(owner, artifact);
  }
  private safeName(name: string) {
    return (
      Array.from(name.split(/[\\/]/).at(-1) ?? "attachment.bin")
        .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
        .join("")
        .slice(0, 180) || "attachment.bin"
    );
  }
  private async publish(
    owner: string,
    artifact: Artifact,
    bytes: Uint8Array,
    path: string,
    operationId?: string,
  ) {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const binding = createHash("sha256")
      .update(
        JSON.stringify({
          name: artifact.name,
          mimeType: artifact.mimeType,
          sha256,
          source: artifact.source,
          parentId: artifact.parentId,
          internal: artifact.internal,
        }),
      )
      .digest("hex");
    const id = artifact.id;
    const intent = {
      id,
      operationId: operationId ?? id,
      binding,
      artifact,
      sha256,
      status: "prepared",
    };
    const previous =
      (await this.db.insertIfAbsent(owner, "file-publications", intent)) ??
      (await this.db.get<typeof intent>(owner, "file-publications", id));
    if (!previous || previous.binding !== binding)
      throw new AppError("File intention is bound to different content", 409);
    // Publishing these already-copied bytes is a separate physical step. A
    // preceding native read has released its remote file lease; retain the
    // task/revision barrier without borrowing that completed read's handles.
    await authorizeTaskEffect([], `file-publication:${id}`);
    try {
      await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (!operationId || !(error instanceof Error && "code" in error && error.code === "EEXIST"))
        throw error;
      const existing = await readFile(path);
      if (createHash("sha256").update(existing).digest("hex") !== sha256)
        throw new AppError("Published file content conflicts with its intention", 409);
    }
    try {
      await this.db.put(owner, "files", previous.artifact);
    } catch (error) {
      if (error instanceof Error) Object.assign(error, { outcomeUnknown: true });
      throw error;
    }
    await this.db.compareAndSwap(
      owner,
      "file-publications",
      id,
      { binding },
      { status: "published" },
    );
  }
  async reference(owner: string, id: string) {
    const file = await this.get(owner, id);
    return {
      attachment: !file.internal,
      fileId: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      ...(file.mimeType.startsWith("image/") &&
        file.size <= 8 * 1024 * 1024 && { fileImage: true }),
    };
  }
  async reconcilePublications(owner: string, operationId: string) {
    const publications = (
      await this.db.list<{
        id: string;
        operationId: string;
        artifact: Artifact;
        sha256: string;
        binding: string;
      }>(owner, "file-publications")
    ).filter((entry) => entry.operationId === operationId);
    const recovered: Artifact[] = [];
    for (const publication of publications) {
      try {
        const extension = publication.artifact.mimeType === "application/pdf" ? "pdf" : "bin";
        const bytes = await readFile(
          join(this.config.dataDir, "files", `${publication.artifact.id}.${extension}`),
        );
        if (
          createHash("sha256").update(bytes).digest("hex") !== publication.sha256 ||
          bytes.length !== publication.artifact.size
        )
          continue;
        await this.db.put(owner, "files", publication.artifact);
        await this.db.compareAndSwap(
          owner,
          "file-publications",
          publication.id,
          { binding: publication.binding },
          { status: "published" },
        );
        recovered.push(publication.artifact);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    return recovered;
  }
  async imageContent(owner: string, id: string) {
    const file = await this.get(owner, id);
    const bytes = await this.bytes(owner, id);
    if (
      !file.mimeType.startsWith("image/") ||
      rasterMime(bytes) !== file.mimeType ||
      bytes.length > 8 * 1024 * 1024
    )
      throw new AppError("Choose a raster image of 8 MB or smaller", 422);
    return {
      type: "image" as const,
      source: {
        type: "data" as const,
        value: Buffer.from(bytes).toString("base64"),
        mimeType: file.mimeType,
      },
    };
  }
  async import(
    owner: string,
    name: string,
    bytes: Uint8Array,
    source: string,
    parentId?: string,
    operationId: string | undefined = taskOperationId(),
  ): Promise<Artifact> {
    if (bytes.length > 10 * 1024 * 1024) throw new AppError("PDFs must be 10 MB or smaller", 413);
    const metadata = await inspectPdf(bytes);
    if (metadata.pageCount > 500) throw new AppError("PDFs must have 500 pages or fewer", 422);
    const safeName = this.safeName(name);
    const id = operationId
      ? createHash("sha256").update(`${owner}:file:${operationId}:${safeName}`).digest("hex")
      : randomUUID();
    const artifact: Artifact = {
      id,
      name: safeName,
      mimeType: "application/pdf",
      size: bytes.length,
      pageCount: metadata.pageCount,
      fields: metadata.fields,
      url: "",
      createdAt: new Date().toISOString(),
      source,
      parentId,
    };
    const directory = join(this.config.dataDir, "files");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.publish(owner, artifact, bytes, join(directory, `${id}.pdf`), operationId);
    return this.signed(owner, artifact);
  }
  signed(owner: string, file: Artifact): Artifact {
    return { ...file, url: this.auth.sign(owner, `/api/files/${file.id}/content`) };
  }
  async list(owner: string) {
    return (await this.db.visibleRecords<Artifact>(owner, "files"))
      .filter((file) => !file.internal)
      .map((file) => this.signed(owner, file));
  }
  async get(owner: string, id: string) {
    const file = await this.db.get<Artifact>(owner, "files", id);
    if (!file) throw new AppError("File not found", 404);
    return file;
  }
  async bytes(owner: string, id: string) {
    const file = await this.get(owner, id);
    try {
      return await readFile(
        join(
          this.config.dataDir,
          "files",
          `${file.id}.${file.mimeType === "application/pdf" ? "pdf" : "bin"}`,
        ),
      );
    } catch {
      throw new AppError("File content is unavailable", 404);
    }
  }
  async fill(owner: string, id: string, values: Record<string, string | boolean>) {
    const file = await this.get(owner, id);
    if (file.mimeType !== "application/pdf")
      throw new AppError("Only PDF forms can be filled", 422);
    const bytes = await this.bytes(owner, id);
    const output = await fillPdf(bytes, values);
    return this.import(
      owner,
      `${file.name.replace(/\.pdf$/i, "")} — filled.pdf`,
      output,
      `Filled from ${file.name}`,
      id,
    );
  }
}
