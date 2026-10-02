import { posix } from "node:path";
import { inflateRawSync } from "node:zlib";
import { DOMParser, type Document, type Element } from "@xmldom/xmldom";

const packageNs = "http://schemas.openxmlformats.org/package/2006/";
const officeNs = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const wordNs = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const sheetNs = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const slideNs = "http://schemas.openxmlformats.org/presentationml/2006/main";
const drawingNs = "http://schemas.openxmlformats.org/drawingml/2006/main";
const memberLimit = 2 * 1024 * 1024,
  totalLimit = 16 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Read the central directory rather than scanning untrusted compressed bytes for headers. */
function members(bytes: Uint8Array) {
  const zip = Buffer.from(bytes);
  if (zip.length > 32 * 1024 * 1024) throw new Error("Office archive is too large");
  let end = -1;
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 65557); offset--)
    if (
      zip.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + zip.readUInt16LE(offset + 20) === zip.length
    ) {
      end = offset;
      break;
    }
  if (end < 0 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6))
    throw new Error("Invalid Office ZIP directory");
  const count = zip.readUInt16LE(end + 10),
    start = zip.readUInt32LE(end + 16),
    size = zip.readUInt32LE(end + 12);
  if (!count || count > 1024 || zip.readUInt16LE(end + 8) !== count || start + size !== end)
    throw new Error("Invalid or unsupported Office ZIP directory");
  const result = new Map<string, Uint8Array>();
  let offset = start,
    total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || zip.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("Invalid Office ZIP member");
    const flags = zip.readUInt16LE(offset + 8),
      method = zip.readUInt16LE(offset + 10);
    const compressed = zip.readUInt32LE(offset + 20),
      expanded = zip.readUInt32LE(offset + 24);
    const nameSize = zip.readUInt16LE(offset + 28),
      extraSize = zip.readUInt16LE(offset + 30),
      commentSize = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42),
      next = offset + 46 + nameSize + extraSize + commentSize;
    total += expanded;
    if (
      next > end ||
      flags & ~0x0808 ||
      ![0, 8].includes(method) ||
      expanded > memberLimit ||
      total > totalLimit
    )
      throw new Error("Unsupported or oversized Office ZIP member");
    const name = utf8.decode(zip.subarray(offset + 46, offset + 46 + nameSize));
    if (
      !name ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.includes("\0") ||
      name.split("/").includes("..") ||
      result.has(name)
    )
      throw new Error("Invalid Office member path");
    if (
      local + 30 > start ||
      zip.readUInt32LE(local) !== 0x04034b50 ||
      zip.readUInt16LE(local + 6) !== flags ||
      zip.readUInt16LE(local + 8) !== method
    )
      throw new Error("Invalid local Office ZIP header");
    const localNameSize = zip.readUInt16LE(local + 26),
      dataStart = local + 30 + localNameSize + zip.readUInt16LE(local + 28);
    if (
      dataStart + compressed > start ||
      utf8.decode(zip.subarray(local + 30, local + 30 + localNameSize)) !== name
    )
      throw new Error("Invalid Office ZIP data bounds");
    const compressedBytes = zip.subarray(dataStart, dataStart + compressed);
    const data =
      method === 0
        ? compressedBytes
        : inflateRawSync(compressedBytes, { maxOutputLength: memberLimit });
    if (data.length !== expanded || crc32(data) !== zip.readUInt32LE(offset + 16))
      throw new Error("Invalid Office ZIP size or checksum");
    result.set(name, data);
    offset = next;
  }
  if (offset !== end) throw new Error("Invalid Office ZIP directory size");
  return result;
}
function parseXml(bytes: Uint8Array): Document {
  const source = utf8.decode(bytes);
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(source))
    throw new Error("Office XML declarations are unsupported");
  return new DOMParser({
    onError: (_level, message) => {
      throw new Error(message);
    },
  }).parseFromString(source, "application/xml");
}
function root(doc: Document, namespace: string, name: string) {
  const element = doc.documentElement;
  if (!element || element.namespaceURI !== namespace || element.localName !== name)
    throw new Error("Unexpected Office XML structure");
  return element;
}
function elements(element: Element, namespace: string, name: string) {
  return Array.from(element.getElementsByTagNameNS(namespace, name));
}
function children(element: Element, namespace: string, name: string) {
  return Array.from(element.childNodes).filter(
    (node): node is Element =>
      node.nodeType === 1 &&
      (node as Element).namespaceURI === namespace &&
      (node as Element).localName === name,
  );
}
function texts(element: Element, namespace: string, name: string) {
  return elements(element, namespace, name)
    .map((entry) => entry.textContent ?? "")
    .join(" ");
}

/** Standard OOXML packages only. Unsupported formats remain unverified. */
export function officeContent(bytes: Uint8Array, mimeType: string): string {
  const archive = members(bytes),
    xml = new Map<string, Document>();
  for (const [name, data] of archive) if (/\.(xml|rels)$/.test(name)) xml.set(name, parseXml(data));
  const document = (name: string) => {
    const doc = xml.get(name);
    if (!doc) throw new Error(`Required Office part is missing: ${name}`);
    return doc;
  };
  const types = root(document("[Content_Types].xml"), `${packageNs}content-types`, "Types");
  const overrides = new Map<string, string>();
  for (const entry of children(types, `${packageNs}content-types`, "Override")) {
    const part = entry.getAttribute("PartName"),
      type = entry.getAttribute("ContentType");
    if (!part || !type || overrides.has(part)) throw new Error("Invalid Office content type");
    overrides.set(part, type);
  }
  const requireType = (name: string, type: string) => {
    if (overrides.get(`/${name}`) !== type)
      throw new Error("Required Office content type is missing");
  };
  const relationships = (part: string) => {
    const name = part
      ? posix.join(posix.dirname(part), "_rels", `${posix.basename(part)}.rels`)
      : "_rels/.rels";
    const result = new Map<string, { target: string; type: string; external: boolean }>();
    for (const entry of children(
      root(document(name), `${packageNs}relationships`, "Relationships"),
      `${packageNs}relationships`,
      "Relationship",
    )) {
      const id = entry.getAttribute("Id"),
        target = entry.getAttribute("Target"),
        type = entry.getAttribute("Type");
      if (!id || !target || !type || result.has(id)) throw new Error("Invalid Office relationship");
      const resolved = posix.normalize(posix.join(part ? posix.dirname(part) : "", target));
      if (resolved.startsWith("../") || resolved.startsWith("/") || resolved.includes("\\"))
        throw new Error("Invalid Office relationship target");
      result.set(id, {
        target: resolved,
        type,
        external: entry.getAttribute("TargetMode") === "External",
      });
    }
    return result;
  };
  const main = /wordprocessingml/.test(mimeType)
    ? "word/document.xml"
    : /spreadsheetml/.test(mimeType)
      ? "xl/workbook.xml"
      : /presentationml/.test(mimeType)
        ? "ppt/presentation.xml"
        : undefined;
  if (
    !main ||
    !Array.from(relationships("").values()).some(
      (entry) =>
        !entry.external && entry.target === main && entry.type === `${officeNs}/officeDocument`,
    )
  )
    throw new Error("Office document relationship is missing");
  if (main === "word/document.xml") {
    requireType(
      main,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    );
    const body = children(root(document(main), wordNs, "document"), wordNs, "body");
    if (body.length !== 1) throw new Error("Word document body is missing");
    const content = texts(body[0], wordNs, "t").trim();
    if (!content) throw new Error("Word document has no useful content");
    return content;
  }
  const workbook = main === "xl/workbook.xml";
  requireType(
    main,
    workbook
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
      : "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  );
  const namespace = workbook ? sheetNs : slideNs;
  const lists = children(
    root(document(main), namespace, workbook ? "workbook" : "presentation"),
    namespace,
    workbook ? "sheets" : "sldIdLst",
  );
  if (lists.length !== 1) throw new Error("Office content list is missing");
  const ids = children(lists[0], namespace, workbook ? "sheet" : "sldId");
  if (!ids.length || ids.length > 128)
    throw new Error("Office document has no supported content parts");
  const links = relationships(main),
    content: string[] = [];
  let usefulParts = 0;
  for (const id of ids) {
    const link = links.get(id.getAttributeNS(officeNs, "id") ?? "");
    if (!link || link.external || link.type !== `${officeNs}/${workbook ? "worksheet" : "slide"}`)
      throw new Error("Office content relationship is missing");
    requireType(
      link.target,
      workbook
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"
        : "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
    );
    const part = root(document(link.target), namespace, workbook ? "worksheet" : "sld");
    let text = "";
    if (workbook) {
      const data = children(part, sheetNs, "sheetData");
      if (data.length !== 1) throw new Error("Worksheet data is missing");
      const values: string[] = [];
      for (const cell of elements(data[0], sheetNs, "c")) {
        if (cell.getAttribute("t") === "s") {
          const shared = root(document("xl/sharedStrings.xml"), sheetNs, "sst");
          const index = Number(texts(cell, sheetNs, "v"));
          const value = elements(shared, sheetNs, "si")[index];
          if (!Number.isInteger(index) || index < 0 || !value)
            throw new Error("Shared string reference is invalid");
          values.push(texts(value, sheetNs, "t"));
        } else values.push(texts(cell, sheetNs, "v"), texts(cell, sheetNs, "t"));
      }
      text = values.join(" ").trim();
    } else {
      if (children(part, slideNs, "cSld").length !== 1) throw new Error("Slide content is missing");
      text = texts(part, drawingNs, "t").trim();
    }
    if (text) usefulParts++;
    content.push(text);
  }
  if (!usefulParts) throw new Error("Office document has no useful content");
  return content.join("\n");
}
