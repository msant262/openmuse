import { PdfError } from "./pdf.ts";

/** Read encoded dimensions before allocating a native decoded image. */
export function documentImageSize(bytes: Uint8Array): { width: number; height: number } {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0,
    height = 0;
  if (
    data.length >= 24 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    data.toString("ascii", 12, 16) === "IHDR"
  ) {
    width = data.readUInt32BE(16);
    height = data.readUInt32BE(20);
  } else if (data.length >= 4 && data[0] === 255 && data[1] === 216) {
    let cursor = 2;
    while (cursor + 3 < data.length) {
      if (data[cursor++] !== 255) break;
      while (data[cursor] === 255) cursor++;
      const marker = data[cursor++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (cursor + 2 > data.length) break;
      const length = data.readUInt16BE(cursor);
      if (length < 2 || cursor + length > data.length) break;
      if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
        if (length < 8) break;
        height = data.readUInt16BE(cursor + 3);
        width = data.readUInt16BE(cursor + 5);
        break;
      }
      cursor += length;
    }
  }
  if (!width || !height) throw new PdfError("Document image has invalid PNG/JPEG dimensions");
  if (width * height > 16_000_000) throw new PdfError("Document image exceeds 16 million pixels");
  return { width, height };
}
