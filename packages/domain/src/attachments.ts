import type { Artifact } from "./index.ts";

export const attachmentLimit = 25 * 1024 * 1024;
export const pdfLimit = 10 * 1024 * 1024;
const types: Record<string, string> = {
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  srt: "application/x-subrip",
  json: "application/json",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};
export function attachmentMime(name: string, supplied?: string) {
  const known = types[name.split(".").at(-1)?.toLowerCase() ?? ""];
  if (known) return known;
  // Unknown content is download-only, even if its uploader claims HTML or an image.
  return supplied && /^(?:audio|video)\/[a-z0-9.+-]+$/i.test(supplied)
    ? supplied.toLowerCase()
    : "application/octet-stream";
}
export function rasterMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v))
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  )
    return "image/webp";
  return undefined;
}
export function attachmentLabel(file: Pick<Artifact, "name" | "mimeType" | "pageCount" | "size">) {
  return file.mimeType === "application/pdf"
    ? `${file.pageCount} ${file.pageCount === 1 ? "page" : "pages"} · PDF`
    : `${file.name.split(".").at(-1)?.toUpperCase() || "FILE"} · ${Math.max(1, Math.ceil(file.size / 1024))} KB`;
}
