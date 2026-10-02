/** Strict standard base64 with constant stack use, even at the attachment limit.
 * Validate alphabet, canonical padding bits and decoded size before allocating bytes. */
export const base64Limit = (maxBytes: number) => Math.ceil(maxBytes / 3) * 4;

function sextet(code: number) {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

export function decodeBase64(encoded: string, maxBytes: number): Buffer<ArrayBuffer> | undefined {
  if (encoded.length > base64Limit(maxBytes) || encoded.length % 4 !== 0) return undefined;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  if ((encoded.length / 4) * 3 - padding > maxBytes) return undefined;
  let final = 0;
  for (let index = 0; index < encoded.length - padding; index++) {
    final = sextet(encoded.charCodeAt(index));
    if (final < 0) return undefined;
  }
  if ((padding === 2 && final % 16 !== 0) || (padding === 1 && final % 4 !== 0)) return undefined;
  return Buffer.from(encoded, "base64");
}
