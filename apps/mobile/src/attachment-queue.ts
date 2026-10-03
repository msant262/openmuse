import type { MessageStorage } from "./message-storage";
export type CachedAttachment = {
  key: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
};
export type TranscriptFileReference = {
  fileId: string;
  name: string;
  mimeType: string;
  size?: number;
};
export type PendingAttachment = CachedAttachment & {
  id: string;
  transcribe: boolean;
  fileId?: string;
  includeSubtitles?: boolean;
  transcriptionTaskId?: string;
  transcriptionStatus?: "queued" | "running" | "error" | "complete";
  transcriptionStage?: string;
  transcriptionMessage?: string;
  transcriptionError?: string;
  transcriptionFiles?: TranscriptFileReference[];
  transcriptionLanguage?: string;
  transcriptionLanguageProbability?: number;
  transcriptionDuration?: number;
  // Kept for local queue records created by earlier app versions.
  commandId?: string;
  transcript?: string;
  error?: string;
};
export class AttachmentQueue {
  private flushing?: Promise<void>;
  constructor(
    readonly key: string,
    private readonly storage: MessageStorage,
    private readonly upload: (item: PendingAttachment) => Promise<{ id: string }>,
  ) {}
  async list(): Promise<PendingAttachment[]> {
    return JSON.parse((await this.storage.read(this.key)) ?? "[]");
  }
  async add(value: PendingAttachment) {
    if (value.size > 25 * 1024 * 1024 || value.size < 1)
      throw new Error("Anexos devem ter até 25 MB e não podem estar vazios.");
    await this.change((items) => {
      if (items.some((item) => item.id === value.id)) return items;
      if (items.length >= 8) throw new Error("Conclua ou remova um dos oito anexos pendentes.");
      return [...items, value];
    });
  }
  async remove(id: string) {
    await this.change((items) => items.filter((item) => item.id !== id));
  }
  async patch(
    id: string,
    patch: Partial<
      Pick<
        PendingAttachment,
        | "transcribe"
        | "commandId"
        | "transcript"
        | "error"
        | "includeSubtitles"
        | "transcriptionTaskId"
        | "transcriptionStatus"
        | "transcriptionStage"
        | "transcriptionMessage"
        | "transcriptionError"
        | "transcriptionFiles"
        | "transcriptionLanguage"
        | "transcriptionLanguageProbability"
        | "transcriptionDuration"
      >
    >,
  ) {
    await this.change((items) =>
      items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }
  private async change(change: (items: PendingAttachment[]) => PendingAttachment[]) {
    await this.storage.update(this.key, (previous) =>
      JSON.stringify(change(JSON.parse(previous ?? "[]"))),
    );
  }
  flush() {
    if (this.flushing) return this.flushing;
    this.flushing = this.perform().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }
  private async perform() {
    for (const item of await this.list()) {
      if (item.fileId) continue;
      try {
        const result = await this.upload(item);
        await this.change((items) =>
          items.map((value) =>
            value.id === item.id ? { ...value, fileId: result.id, error: undefined } : value,
          ),
        );
      } catch (error) {
        await this.change((items) =>
          items.map((value) =>
            value.id === item.id
              ? {
                  ...value,
                  error: error instanceof Error ? error.message : "Envio pendente; tente novamente",
                }
              : value,
          ),
        );
      }
    }
  }
}
