import type { AttachmentQueue, CachedAttachment } from "./attachment-queue";
import { sha256 } from "./message-hash";

export type SharedFile = { path: string; fileName: string; mimeType: string; size?: number | null };
export type SharedInput = {
  text?: string | null;
  webUrl?: string | null;
  files?: SharedFile[] | null;
};
/** Sharing stages owned copies, never sends a message or grants task authority. */
export async function stageSharedInput(
  input: SharedInput,
  queue: AttachmentQueue,
  cache: (key: string, input: SharedFile) => Promise<CachedAttachment>,
  cacheText: (key: string, text: string) => Promise<CachedAttachment>,
) {
  const files = input.files ?? [];
  const text = input.text || input.webUrl || "";
  if (files.length + Number(Boolean(text)) > 8)
    throw new Error("Compartilhe até oito anexos por vez.");
  if (text.length > 24000) throw new Error("O texto compartilhado excede 24.000 caracteres.");
  for (const file of files) {
    if (!/^(?:file|content):/.test(file.path))
      throw new Error("O compartilhamento precisa conter arquivos locais.");
    if (file.size && file.size > 25 * 1024 * 1024) throw new Error("Anexos devem ter até 25 MB.");
  }
  const fingerprint = sha256(JSON.stringify(input));
  for (let i = 0; i < files.length; i++) {
    const id = `share-${sha256(`${queue.key}:${fingerprint}:${i}`)}`;
    const saved = await cache(sha256(id), files[i]);
    await queue.add({ ...saved, id, transcribe: false });
  }
  if (text) {
    const id = `share-${sha256(`${queue.key}:${fingerprint}:text`)}`;
    await queue.add({ ...(await cacheText(sha256(id), text)), id, transcribe: false });
  }
  return files.length + Number(Boolean(text));
}
