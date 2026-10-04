import JSZip from "jszip";

/** Stable package dates prevent a retried publication from producing different bytes. */
export async function normalizeOfficePackage(bytes: Uint8Array): Promise<Uint8Array> {
  const archive = await JSZip.loadAsync(bytes);
  const stable = new JSZip();
  const parts = new Map<string, Uint8Array>();
  const chartNames = Object.keys(archive.files)
    .filter((name) => /\/charts\/chart\d+\.xml$/.test(name))
    .sort(
      (a, b) => Number(a.match(/chart(\d+)\.xml$/)?.[1]) - Number(b.match(/chart(\d+)\.xml$/)?.[1]),
    );
  const charts = new Map(
    chartNames.map((name, index) => [name.split("/").at(-1) ?? name, `chart${index + 1}.xml`]),
  );
  const workbookNames = Object.keys(archive.files)
    .filter((name) => /\/embeddings\/Microsoft_Excel_Worksheet\d+\.xlsx$/.test(name))
    .sort(
      (a, b) => Number(a.match(/Worksheet(\d+)/)?.[1]) - Number(b.match(/Worksheet(\d+)/)?.[1]),
    );
  const workbooks = new Map(
    workbookNames.map((name, index) => [
      name.split("/").at(-1) ?? name,
      `Microsoft_Excel_Worksheet${index + 1}.xlsx`,
    ]),
  );
  const pathName = (name: string) =>
    name.replace(
      /chart\d+\.xml|Microsoft_Excel_Worksheet\d+\.xlsx/g,
      (part) => charts.get(part) ?? workbooks.get(part) ?? part,
    );
  for (const name of Object.keys(archive.files).sort()) {
    const entry = archive.files[name];
    if (entry.dir) continue;
    let data = await entry.async("uint8array");
    if (/\.(xlsx|docx|pptx)$/.test(name)) data = await normalizeOfficePackage(data);
    if (name === "docProps/core.xml") {
      data = Buffer.from(
        Buffer.from(data)
          .toString("utf8")
          .replace(
            /(<dcterms:(?:created|modified)[^>]*>)[^<]*(<\/dcterms:(?:created|modified)>)/g,
            (_, open, close) => `${open}2000-01-01T00:00:00Z${close}`,
          ),
      );
    }
    if (/\.(xml|rels)$/.test(name)) {
      let drawing = 0;
      data = Buffer.from(
        Buffer.from(data)
          .toString("utf8")
          .replace(
            /((?:Target|PartName)=")([^"]+)(")/g,
            (_, open, path, close) => `${open}${pathName(path)}${close}`,
          )
          .replace(
            /(<wp:docPr\b[^>]*\bid=")\d+("[^>]*>)/g,
            (_, open, close) => `${open}${++drawing}${close}`,
          ),
      );
    }
    parts.set(pathName(name), data);
  }
  // docx assigns random identifiers to hyperlinks and chart workbook relations.
  // Renumber each relationship scope and its owner's references together.
  for (const [name, data] of parts) {
    if (!name.endsWith(".rels")) continue;
    const ids = new Map<string, string>();
    const xml = Buffer.from(data)
      .toString("utf8")
      .replace(/(<Relationship\b[^>]*\bId=")([^"]+)(")/g, (_, open, id, close) => {
        const stableId = `rIdStable${ids.size + 1}`;
        ids.set(id, stableId);
        return `${open}${stableId}${close}`;
      });
    parts.set(name, Buffer.from(xml));
    const owner = name.replace(/(^|\/)_rels\//, "$1").replace(/\.rels$/, "");
    const ownerBytes = parts.get(owner);
    if (ownerBytes)
      parts.set(
        owner,
        Buffer.from(
          Buffer.from(ownerBytes)
            .toString("utf8")
            .replace(
              /(r:(?:id|embed|link)=")([^"]+)(")/g,
              (_, open, id, close) => `${open}${ids.get(id) ?? id}${close}`,
            ),
        ),
      );
  }
  for (const [name, data] of [...parts].sort(([a], [b]) => a.localeCompare(b)))
    stable.file(name, data, {
      date: new Date("2000-01-01T00:00:00Z"),
      createFolders: false,
    });
  return stable.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: "DOS",
  });
}
