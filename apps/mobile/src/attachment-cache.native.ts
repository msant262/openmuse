import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import * as Legacy from "expo-file-system/legacy";
import { API_URL, type MuseApi } from "./api";
import type { CachedAttachment, PendingAttachment } from "./attachment-queue";
export type PickedAttachment = { uri: string; name: string; mimeType: string; file?: unknown };
const directory = () => {
  const dir = new Directory(Paths.document, "openmuse-attachments");
  dir.create({ idempotent: true, intermediates: true });
  return dir;
};
function fileFor(key: string) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid attachment cache identity");
  return new File(directory(), key);
}
export async function attachmentDigest(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(
      await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes as Uint8Array<ArrayBuffer>),
    ),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}
export async function cacheAttachment(
  key: string,
  picked: PickedAttachment,
): Promise<CachedAttachment> {
  if (!/^(?:file|content):/.test(picked.uri)) throw new Error("Choose a local attachment");
  const source = new File(picked.uri);
  if (source.size > 25 * 1024 * 1024) throw new Error("Anexos devem ter até 25 MB.");
  const bytes = await source.bytes();
  if (bytes.length < 1 || bytes.length > 25 * 1024 * 1024)
    throw new Error("Anexos devem ter até 25 MB.");
  const sha256 = await attachmentDigest(bytes);
  const target = fileFor(key);
  if (target.exists) {
    if ((await attachmentDigest(await target.bytes())) !== sha256)
      throw new Error("O arquivo compartilhado mudou durante a recuperação.");
  } else {
    target.create();
    target.write(bytes);
  }
  if ((await attachmentDigest(await target.bytes())) !== sha256)
    throw new Error("Could not confirm saved attachment");
  return { key, name: picked.name, mimeType: picked.mimeType, size: bytes.length, sha256 };
}
export async function uploadCachedAttachment(api: MuseApi, item: PendingAttachment) {
  const file = fileFor(item.key);
  if (!file.exists || (await attachmentDigest(await file.bytes())) !== item.sha256)
    throw new Error("O anexo local está indisponível ou mudou. Escolha o arquivo novamente.");
  return api.upload<{ id: string }>((authorization) =>
    Legacy.uploadAsync(`${API_URL}/api/files`, file.uri, {
      httpMethod: "POST",
      uploadType: Legacy.FileSystemUploadType.MULTIPART,
      fieldName: "file",
      mimeType: item.mimeType,
      parameters: { uploadId: item.id, fileName: item.name },
      headers: { Authorization: authorization },
    }),
  );
}
export async function removeCachedAttachment(key: string) {
  const file = fileFor(key);
  if (file.exists) file.delete();
}

export async function cacheTextAttachment(key: string, text: string): Promise<CachedAttachment> {
  const bytes = new TextEncoder().encode(text),
    sha256 = await attachmentDigest(bytes);
  const target = fileFor(key);
  if (target.exists) {
    if ((await attachmentDigest(await target.bytes())) !== sha256)
      throw new Error("O texto compartilhado mudou.");
  } else {
    target.create();
    target.write(bytes);
  }
  return {
    key,
    name: "texto-compartilhado.txt",
    mimeType: "text/plain",
    size: bytes.length,
    sha256,
  };
}
