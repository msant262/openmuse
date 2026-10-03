export interface ParsedAddress {
  email: string;
  name: string;
}

export function sanitizeUnicode(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] + value[index + 1];
        index++;
      } else result += "\ufffd";
    } else if (code >= 0xdc00 && code <= 0xdfff) result += "\ufffd";
    else result += value[index];
  }
  return result;
}

export function unfoldHeaderValue(value: string): string {
  return sanitizeUnicode(value.replace(/\r?\n[ \t]+/g, " ").replace(/[\r\n]/g, " "));
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    // A mailbox may contain an unsupported label. UTF-8 replacement decoding keeps
    // that message readable and prevents one old message from aborting a sync.
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function decodeQWord(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "_") bytes.push(0x20);
    else if (
      character === "=" &&
      index + 2 < value.length &&
      /^[\da-f]{2}$/i.test(value.slice(index + 1, index + 3))
    ) {
      bytes.push(Number.parseInt(value.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      const code = value.charCodeAt(index);
      if (code <= 0xff) bytes.push(code);
      else bytes.push(...Buffer.from(character, "utf8"));
    }
  }
  return Uint8Array.from(bytes);
}

export function decodeMimeHeader(value: string): string {
  return sanitizeUnicode(
    unfoldHeaderValue(value)
      .replace(/(\?=)[ \t]+(?==\?)/g, "$1")
      .replace(
        /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,
        (original, charset: string, encoding: string, text: string) => {
          try {
            const bytes =
              encoding.toLowerCase() === "b" ? Buffer.from(text, "base64") : decodeQWord(text);
            return decodeBytes(bytes, charset);
          } catch {
            return original;
          }
        },
      ),
  );
}

function splitAddressList(value: string): string[] {
  const entries: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let angleDepth = 0;
  let commentDepth = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (commentDepth > 0 && character === "\\") {
      escaped = true;
      continue;
    }
    if (commentDepth > 0) {
      if (character === "(") commentDepth++;
      else if (character === ")") commentDepth--;
      continue;
    }
    if (!quoted && character === "(") {
      commentDepth++;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === "<") angleDepth++;
    else if (!quoted && character === ">") angleDepth = Math.max(0, angleDepth - 1);
    else if (!quoted && angleDepth === 0 && character === ",") {
      entries.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  entries.push(value.slice(start).trim());
  return entries.filter(Boolean);
}

function withoutComments(value: string): string {
  let result = "";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      if (depth === 0) result += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && (quoted || depth > 0)) {
      escaped = true;
      if (depth === 0) result += character;
      continue;
    }
    if (depth > 0) {
      if (character === "(") depth++;
      else if (character === ")") depth--;
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (!quoted && character === "(") {
      depth++;
      continue;
    }
    result += character;
  }
  return result.trim();
}

function cleanDisplayName(value: string): string {
  const clean = withoutComments(value).trim();
  const unquoted = clean.startsWith('"') && clean.endsWith('"') ? clean.slice(1, -1) : clean;
  return decodeMimeHeader(unquoted.replace(/\\([\\"])/g, "$1")).trim();
}

function angleAddress(segment: string): { mailbox: string; displayName: string } | undefined {
  let quoted = false;
  let escaped = false;
  let commentDepth = 0;
  let openAngle = -1;
  for (let index = 0; index < segment.length; index++) {
    const character = segment[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && (quoted || commentDepth > 0)) {
      escaped = true;
      continue;
    }
    if (commentDepth > 0) {
      if (character === "(") commentDepth++;
      else if (character === ")") commentDepth--;
      continue;
    }
    if (!quoted && character === "(") {
      commentDepth++;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === "<") {
      if (openAngle >= 0) return undefined;
      openAngle = index;
    } else if (character === ">") {
      if (openAngle < 0 || withoutComments(segment.slice(index + 1)).trim()) return undefined;
      return {
        mailbox: segment.slice(openAngle + 1, index),
        displayName: cleanDisplayName(segment.slice(0, openAngle)),
      };
    }
  }
  return undefined;
}

function isLocalAtomCharacter(character: string): boolean {
  if (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]$/.test(character)) return true;
  return /^[\p{L}\p{M}\p{N}]$/u.test(character);
}

function isDomainLabel(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 63 &&
    /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u.test(value)
  );
}

function skipWhitespace(value: string, index: number): number {
  while (index < value.length && /\s/.test(value[index])) index++;
  return index;
}

function isMailboxControl(character: string, includeSpace: boolean): boolean {
  const code = character.charCodeAt(0);
  return code < (includeSpace ? 0x21 : 0x20) || code === 0x7f;
}

/** Validate and return one complete RFC-style mailbox, never an email-looking substring. */
function parseMailbox(value: string): string | undefined {
  const mailbox = withoutComments(value).trim();
  let index = 0;
  let local = "";

  if (mailbox[index] === '"') {
    const start = index++;
    let closed = false;
    while (index < mailbox.length) {
      const character = mailbox[index++];
      if (character === "\\") {
        if (index >= mailbox.length || isMailboxControl(mailbox[index], false)) return undefined;
        index++;
      } else if (character === '"') {
        closed = true;
        break;
      } else if (isMailboxControl(character, false)) return undefined;
    }
    if (!closed) return undefined;
    local = mailbox.slice(start, index);
  } else {
    const start = index;
    while (index < mailbox.length && mailbox[index] !== "@" && !/\s/.test(mailbox[index])) index++;
    local = mailbox.slice(start, index);
    if (
      !local ||
      local
        .split(".")
        .some(
          (atom) => !atom || Array.from(atom).some((character) => !isLocalAtomCharacter(character)),
        )
    )
      return undefined;
  }

  index = skipWhitespace(mailbox, index);
  if (mailbox[index] !== "@") return undefined;
  index = skipWhitespace(mailbox, index + 1);
  const domainStart = index;

  if (mailbox[index] === "[") {
    let escaped = false;
    index++;
    let closed = false;
    while (index < mailbox.length) {
      const character = mailbox[index++];
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "]") {
        closed = true;
        break;
      } else if (isMailboxControl(character, true)) return undefined;
    }
    if (!closed) return undefined;
  } else {
    while (index < mailbox.length && !/\s/.test(mailbox[index])) index++;
    const domain = mailbox.slice(domainStart, index);
    if (!domain || domain.split(".").some((label) => !isDomainLabel(label))) return undefined;
  }

  index = skipWhitespace(mailbox, index);
  return index === mailbox.length
    ? `${local}@${mailbox.slice(domainStart, index).trim()}`
    : undefined;
}

function trailingCommentName(segment: string): string | undefined {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let start = -1;
  for (let index = 0; index < segment.length; index++) {
    const character = segment[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && (quoted || depth > 0)) {
      escaped = true;
      continue;
    }
    if (depth > 0) {
      if (character === "(") depth++;
      else if (character === ")" && --depth === 0) {
        if (withoutComments(segment.slice(index + 1)).trim()) start = -1;
        else return cleanDisplayName(segment.slice(start + 1, index));
      }
      continue;
    }
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === "(") {
      depth = 1;
      start = index;
    }
  }
  return undefined;
}

function parseAddress(segment: string): ParsedAddress | undefined {
  const angle = angleAddress(segment);
  const email = parseMailbox(angle?.mailbox ?? segment);
  if (!email) return undefined;
  const name = angle?.displayName || trailingCommentName(segment) || email;
  return { email: sanitizeUnicode(email), name: sanitizeUnicode(name) };
}

export function parseAddressList(value: string): ParsedAddress[] {
  return splitAddressList(unfoldHeaderValue(value))
    .map(parseAddress)
    .filter((address): address is ParsedAddress => address !== undefined);
}

export function decodeMimeText(bytes: Uint8Array, charset: string): string {
  return sanitizeUnicode(decodeBytes(bytes, charset));
}

export function decodeMailSnippet(value: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return sanitizeUnicode(
    value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (original, entity: string) => {
      if (!entity.startsWith("#")) return entities[entity.toLowerCase()] ?? original;
      const code =
        entity[1].toLowerCase() === "x"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : "\ufffd";
    }),
  );
}
