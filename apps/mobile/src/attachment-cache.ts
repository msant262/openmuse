import * as Crypto from "expo-crypto";
import type { MuseApi } from "./api";
import type { CachedAttachment, PendingAttachment } from "./attachment-queue";
export type PickedAttachment = { uri: string; name: string; mimeType: string; file?: File };
export async function attachmentDigest(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(
      await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes as Uint8Array<ArrayBuffer>),
    ),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}
async function blobs(key: string, write?: Blob | null): Promise<Blob | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open("openmuse-attachments", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("pending");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise<Blob | undefined>((resolve, reject) => {
      const tx = db.transaction("pending", write === undefined ? "readonly" : "readwrite");
      const store = tx.objectStore("pending");
      const request =
        write === undefined
          ? store.get(key)
          : write === null
            ? store.delete(key)
            : store.put(write, key);
      tx.oncomplete = () => resolve(request.result instanceof Blob ? request.result : undefined);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Could not persist attachment"));
    });
  } finally {
    db.close();
  }
}
export async function cacheAttachment(
  key: string,
  picked: PickedAttachment,
): Promise<CachedAttachment> {
  const file = picked.file ?? (await (await fetch(picked.uri)).blob());
  if (file.size < 1 || file.size > 25 * 1024 * 1024) throw new Error("Anexos devem ter até 25 MB.");
  const sha256 = await attachmentDigest(new Uint8Array(await file.arrayBuffer()));
  await blobs(key, file);
  return { key, name: picked.name, mimeType: picked.mimeType, size: file.size, sha256 };
}
export async function uploadCachedAttachment(api: MuseApi, item: PendingAttachment) {
  const file = await blobs(item.key);
  if (!file || (await attachmentDigest(new Uint8Array(await file.arrayBuffer()))) !== item.sha256)
    throw new Error("O anexo local está indisponível ou mudou. Escolha o arquivo novamente.");
  const form = new FormData();
  form.append("file", file, item.name);
  form.append("uploadId", item.id);
  return api.request<{ id: string }>("/api/files", form);
}
export async function removeCachedAttachment(key: string) {
  await blobs(key, null);
}

export async function cacheTextAttachment(key: string, text: string): Promise<CachedAttachment> {
  const file = new File([text], "texto-compartilhado.txt", { type: "text/plain" });
  return cacheAttachment(key, { uri: "", name: file.name, mimeType: file.type, file });
}
