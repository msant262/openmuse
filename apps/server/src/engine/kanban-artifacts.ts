import { createHash } from "node:crypto";
import { attachmentLimit } from "../../../../packages/domain/src/attachments.ts";
import type { ComputerBackend } from "../computer-contract.ts";
import { AppError } from "../errors.ts";
import type { Files } from "../files.ts";
import type { PublicWeb } from "../public-web.ts";
import type {
  Handoff,
  KanbanAttachment,
  KanbanCard,
  KanbanScope,
  KanbanWorkflow,
} from "./kanban-workflow.ts";

/** Materialize Hermes handoff artifacts in the app's durable owner file store.
 * Native workspace files are copied before any board/run can be terminated. */
export class KanbanArtifacts {
  constructor(
    private readonly owner: string,
    private readonly files: Files,
    private readonly computer: Pick<ComputerBackend, "fileBytes">,
    private readonly web: PublicWeb,
    private readonly verify: (card: KanbanCard, handoff: Handoff) => Promise<void>,
  ) {}
  async store(
    card: KanbanCard,
    scope: KanbanScope,
    input: { filename: string; bytes: Uint8Array; contentType?: string },
    requestId: string,
  ): Promise<KanbanAttachment> {
    const file = await this.files.importBinaryAttachment(
      this.owner,
      input.filename,
      input.bytes,
      `kanban:${card.id}`,
      input.contentType,
      `kanban:${card.id}:${requestId}`,
    );
    return {
      id: requestId,
      taskId: card.id,
      fileId: file.id,
      filename: file.name,
      contentType: file.mimeType,
      size: file.size,
      sha256: createHash("sha256").update(input.bytes).digest("hex"),
      uploadedBy: scope.profile,
      createdAt: file.createdAt,
    };
  }
  async handoff(card: KanbanCard, handoff: Handoff, requestId: string) {
    const attachments: KanbanAttachment[] = [];
    for (const [index, path] of (handoff.artifacts ?? []).entries()) {
      const id = createHash("sha256").update(`${card.id}:${requestId}:${index}`).digest("hex");
      if (/^[a-f0-9]{64}$/.test(path)) {
        const file = await this.files.get(this.owner, path);
        const bytes = await this.files.bytes(this.owner, path);
        if (bytes.length !== file.size || bytes.length > attachmentLimit)
          throw new AppError("Actual handoff file bytes do not match their recorded size", 409);
        attachments.push({
          id,
          taskId: card.id,
          fileId: file.id,
          filename: file.name,
          contentType: file.mimeType,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          uploadedBy: card.currentRun?.profile ?? card.assignee,
          createdAt: file.createdAt,
        });
      } else {
        if (!path.startsWith("/workspace/"))
          throw new AppError(
            "Handoff artifacts require an actual app file ID or an absolute native /workspace path",
            422,
          );
        const native = await this.computer.fileBytes(this.owner, path, {
          idempotencyKey: `kanban-preserve:${id}`,
        });
        attachments.push(
          await this.store(
            card,
            { role: "orchestrator", profile: card.currentRun?.profile ?? card.assignee },
            { filename: native.name, bytes: native.bytes },
            id,
          ),
        );
      }
    }
    const result = {
      ...handoff,
      ...(handoff.artifacts && { artifacts: attachments.map((a) => a.fileId) }),
    };
    await this.verify(card, result);
    return { handoff: result, attachments };
  }
  async attachUrl(
    board: KanbanWorkflow,
    scope: KanbanScope,
    taskId: string,
    input: { url: string; filename?: string; contentType?: string },
    requestId: string,
    signal?: AbortSignal,
  ) {
    return board.attachUrl(scope, taskId, input, requestId, async () => {
      const download = await this.web.download(input.url, attachmentLimit, signal);
      let leaf = new URL(download.url).pathname.split("/").at(-1) ?? "";
      try {
        leaf = decodeURIComponent(leaf);
      } catch {
        /* Preserve the observed filename if its escape is malformed. */
      }
      return {
        filename: input.filename || leaf || "download.bin",
        bytes: download.bytes,
        contentType: input.contentType ?? download.contentType,
      };
    });
  }
}
