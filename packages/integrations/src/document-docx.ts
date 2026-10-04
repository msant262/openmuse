import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  type INumberingOptions,
  type IParagraphOptions,
  LevelFormat,
  LineRuleType,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  type ParagraphChild,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { ChartRun } from "docx/charts";
import { documentAccentText } from "./document-colors.ts";
import type { DocumentBlock, DocumentModel, DocumentRun } from "./document-model.ts";
import { normalizeOfficePackage } from "./document-office-package.ts";

const hex = (value: string) => value.replace(/^#/, "");
const bodyFont = "DejaVu Sans";
const textWidth = 9930;
const noBorder = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const headingLevels = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

/** Native paragraphs, cells, numbering and charts remain editable in Word. */
export async function createDocumentDocx(model: DocumentModel): Promise<Uint8Array> {
  const { theme, design } = model;
  const family = design.layout ?? "editorial";
  const ink = hex(theme.ink),
    accent = hex(theme.accent),
    muted = hex(theme.muted),
    surface = hex(theme.surface);
  const displayFont =
    theme.display === "serif"
      ? "DejaVu Serif"
      : theme.display === "mono"
        ? "DejaVu Sans Mono"
        : bodyFont;
  const accentText = documentAccentText(accent, [hex(theme.paper), surface], ink);
  const accentLarge = documentAccentText(accent, [surface], ink, true);
  const children: (Paragraph | Table)[] = [];
  const numbering: INumberingOptions["config"][number][] = [];
  const runs = (
    values: readonly DocumentRun[],
    overrides: { color?: string; size?: number; bold?: boolean } = {},
  ): ParagraphChild[] =>
    values.flatMap<ParagraphChild>((run) => {
      const parts = run.text.split("\n").flatMap((text, index) => [
        ...(index ? [new TextRun({ break: 1 })] : []),
        new TextRun({
          text,
          bold: run.bold || overrides.bold,
          italics: run.italic,
          font: run.code ? "DejaVu Sans Mono" : bodyFont,
          color: overrides.color ?? (run.href ? accentText : ink),
          size: overrides.size,
          ...(run.code ? { shading: { fill: surface } } : {}),
          ...(run.href ? { underline: {} } : {}),
        }),
      ]);
      return run.href ? [new ExternalHyperlink({ link: run.href, children: parts })] : parts;
    });
  const paragraph = (values: readonly DocumentRun[], options: IParagraphOptions = {}) =>
    new Paragraph({ children: runs(values), ...options });
  const plain = (text: string, options: IParagraphOptions = {}) => paragraph([{ text }], options);
  const spacer = () => plain("", { spacing: { after: 100, line: 60 } });
  const small = (text: string) =>
    new Paragraph({
      children: [new TextRun({ text, size: 18, color: muted, font: bodyFont })],
      spacing: { before: 90, after: 220 },
    });

  if (family !== "editorial" && model.title) {
    const signal = family === "signal";
    const titleColor = signal ? hex(theme.paper) : ink;
    const titleParagraph = new Paragraph({
      children: [
        new TextRun({
          text: model.title,
          font: displayFont,
          size: signal ? 76 : 56,
          color: titleColor,
        }),
      ],
      heading: HeadingLevel.TITLE,
      spacing: {
        before: design.cover ? 700 : 160,
        after: 320,
        line: 300,
        lineRule: LineRuleType.AUTO,
      },
      keepNext: true,
    });
    const metadata = [
      ...(design.eyebrow
        ? [
            new Paragraph({
              children: [
                new TextRun({ text: design.eyebrow, bold: true, size: 19, color: titleColor }),
              ],
              spacing: { after: 220 },
              keepNext: true,
            }),
          ]
        : []),
      ...(design.subtitle
        ? [
            new Paragraph({
              children: [new TextRun({ text: design.subtitle, size: 24, color: titleColor })],
              spacing: { after: 240 },
              keepNext: true,
            }),
          ]
        : []),
    ];
    const widths = signal ? [textWidth] : [6500, textWidth - 6500];
    children.push(
      new Table({
        width: { size: textWidth, type: WidthType.DXA },
        columnWidths: widths,
        layout: TableLayoutType.FIXED,
        margins: { top: signal ? 420 : 200, bottom: signal ? 500 : 200, left: 350, right: 350 },
        borders: {
          top: { style: BorderStyle.SINGLE, size: signal ? 24 : 8, color: accent },
          bottom: noBorder,
          left: noBorder,
          right: noBorder,
          insideHorizontal: noBorder,
          insideVertical: { style: BorderStyle.SINGLE, size: 6, color: hex(theme.paper) },
        },
        rows: [
          new TableRow({
            children: widths.map(
              (width, index) =>
                new TableCell({
                  width: { size: width, type: WidthType.DXA },
                  shading: { fill: signal ? ink : surface },
                  children: signal
                    ? [
                        ...metadata.slice(0, design.eyebrow ? 1 : 0),
                        titleParagraph,
                        ...metadata.slice(design.eyebrow ? 1 : 0),
                      ]
                    : index === 0
                      ? [titleParagraph]
                      : metadata.length
                        ? metadata
                        : [plain("")],
                }),
            ),
          }),
        ],
      }),
      spacer(),
    );
  } else {
    if (design.eyebrow)
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: design.eyebrow, size: 20, bold: true, color: accentText }),
          ],
          spacing: { before: design.cover ? 1800 : 80, after: 260 },
        }),
      );
    if (model.title)
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: model.title,
              font: displayFont,
              size: design.cover ? 72 : 52,
              color: ink,
            }),
          ],
          heading: HeadingLevel.TITLE,
          spacing: {
            before: design.cover && !design.eyebrow ? 1800 : 0,
            after: 300,
            line: 300,
            lineRule: LineRuleType.AUTO,
          },
          border: { bottom: { style: BorderStyle.SINGLE, size: 16, color: accent, space: 18 } },
          keepNext: true,
        }),
      );
    if (design.subtitle)
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: design.subtitle, color: muted, size: design.cover ? 29 : 24 }),
          ],
          spacing: { before: 160, after: design.cover ? 700 : 360 },
          keepNext: !design.cover,
        }),
      );
  }
  if (design.cover && model.title) children.push(new Paragraph({ children: [new PageBreak()] }));

  const table = (block: Extract<DocumentBlock, { type: "table" }>) => {
    const count = Math.max(1, block.headers.length);
    const widths = Array.from({ length: count }, () => Math.floor(textWidth / count));
    return new Table({
      width: { size: textWidth, type: WidthType.DXA },
      columnWidths: widths,
      layout: TableLayoutType.FIXED,
      margins: { top: 140, bottom: 140, left: 160, right: 160 },
      borders: {
        top: noBorder,
        bottom: noBorder,
        left: noBorder,
        right: noBorder,
        insideVertical: noBorder,
        insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: surface },
      },
      rows: [block.headers, ...block.rows].map(
        (row, index) =>
          new TableRow({
            tableHeader: index === 0,
            cantSplit: true,
            children: row.map(
              (cell, column) =>
                new TableCell({
                  width: { size: widths[column], type: WidthType.DXA },
                  shading: { fill: index === 0 ? ink : index % 2 ? hex(theme.paper) : surface },
                  children: [
                    new Paragraph({
                      children: runs(cell, {
                        color: index === 0 ? hex(theme.paper) : ink,
                        bold: index === 0,
                        size: 20,
                      }),
                      spacing: { after: 20, line: 270 },
                      widowControl: true,
                    }),
                  ],
                }),
            ),
          }),
      ),
    });
  };

  for (const [index, block] of model.blocks.entries()) {
    switch (block.type) {
      case "heading":
        children.push(
          new Paragraph({
            text: block.text,
            heading: headingLevels[Math.min(5, Math.max(0, block.level - 1))],
            keepNext: true,
            ...(block.level <= 2 && family === "briefing"
              ? {
                  shading: { fill: surface },
                  border: {
                    bottom: { style: BorderStyle.SINGLE, size: 6, color: accent, space: 6 },
                  },
                  indent: { left: 160, right: 160 },
                }
              : {}),
            ...(block.level <= 2 && family === "signal"
              ? {
                  border: {
                    left: { style: BorderStyle.SINGLE, size: 24, color: accent, space: 12 },
                  },
                  indent: { left: 400 },
                }
              : {}),
          }),
        );
        break;
      case "paragraph":
        children.push(
          paragraph(block.runs, family === "signal" ? { indent: { left: 400, right: 200 } } : {}),
        );
        break;
      case "list": {
        const configured = new Set<number>();
        for (const item of block.items) {
          const listId = item.listId ?? 0,
            reference = `list-${index}-${listId}`;
          const ordered = item.ordered ?? block.ordered;
          if (!configured.has(listId)) {
            numbering.push({
              reference,
              levels: Array.from({ length: 9 }, (_, level) => ({
                level,
                format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
                text: ordered ? `%${level + 1}.` : level % 2 ? "◦" : "•",
                start: ordered ? (item.number ?? block.start) : 1,
                alignment: AlignmentType.LEFT,
                style: {
                  paragraph: { indent: { left: 420 + level * 340, hanging: 260 } },
                  run: { color: accentText, font: bodyFont },
                },
              })),
            });
            configured.add(listId);
          }
          children.push(
            paragraph(item.runs, {
              numbering: { reference, level: Math.max(0, Math.min(8, item.level)) },
              spacing: { after: 100 },
            }),
          );
        }
        children.push(spacer());
        break;
      }
      case "quote":
        children.push(
          paragraph(block.runs, {
            border: { left: { style: BorderStyle.SINGLE, size: 22, color: accent, space: 12 } },
            shading: { fill: surface },
            indent: { left: 280, right: 240 },
            spacing: { before: 180, after: 240, line: 340 },
          }),
        );
        break;
      case "table":
        children.push(table(block), spacer());
        break;
      case "code":
        for (const line of block.text.split("\n"))
          children.push(
            new Paragraph({
              children: [
                new TextRun({ text: line, font: "DejaVu Sans Mono", size: 18, color: ink }),
              ],
              shading: { fill: surface },
              spacing: { after: 0, line: 240 },
              indent: { left: 180, right: 180 },
            }),
          );
        children.push(spacer());
        break;
      case "rule":
        children.push(
          plain("", {
            border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: accent } },
            spacing: { before: 180, after: 260 },
          }),
        );
        break;
      case "image": {
        const image = model.images.get(block.fileId);
        if (!image) throw new Error(`Document image is missing: ${block.fileId}`);
        const scale = Math.min(662 / image.width, 600 / image.height);
        children.push(
          new Paragraph({
            children: [
              new ImageRun({
                type: image.mimeType === "image/png" ? "png" : "jpg",
                data: image.bytes,
                transformation: { width: image.width * scale, height: image.height * scale },
                altText: {
                  name: block.caption || "Document image",
                  description: block.caption,
                  title: block.caption,
                },
              }),
            ],
            alignment: AlignmentType.CENTER,
            keepNext: Boolean(block.caption),
            spacing: { before: 200, after: 80 },
          }),
        );
        if (block.caption) children.push(small(block.caption));
        break;
      }
      case "chart":
        children.push(
          new Paragraph({
            children: [
              new ChartRun({
                type: "bar",
                title: { text: block.title, font: { name: displayFont, size: 16, color: ink } },
                categories: block.labels,
                series: [{ name: block.unit ?? block.title, values: block.values, color: accent }],
                legend: false,
                dataLabels: {
                  value: true,
                  position: "outsideEnd",
                  font: { name: bodyFont, size: 10, color: ink },
                },
                font: { name: bodyFont, color: ink },
                categoryAxis: { reverseOrder: true, font: { size: 10 } },
                valueAxis: { font: { size: 9 }, title: block.unit },
                chartArea: { fill: hex(theme.paper), border: "none" },
                transformation: {
                  width: 650,
                  height: Math.max(290, Math.min(520, 145 + block.labels.length * 27)),
                },
              }),
            ],
            spacing: { before: 180, after: 220 },
          }),
        );
        break;
      case "metrics": {
        const columns = family === "signal" ? 1 : family === "briefing" ? 2 : 3;
        for (let offset = 0; offset < block.items.length; offset += columns) {
          const items = block.items.slice(offset, offset + columns);
          children.push(
            new Table({
              width: { size: textWidth, type: WidthType.DXA },
              columnWidths: items.map(() => Math.floor(textWidth / items.length)),
              margins: { top: 230, bottom: 230, left: 220, right: 220 },
              borders: {
                top: noBorder,
                bottom: noBorder,
                left: noBorder,
                right: noBorder,
                insideHorizontal: noBorder,
                insideVertical: { style: BorderStyle.SINGLE, size: 24, color: "FFFFFF" },
              },
              rows: [
                new TableRow({
                  cantSplit: true,
                  children: items.map(
                    (item) =>
                      new TableCell({
                        shading: { fill: surface },
                        children: [
                          new Paragraph({
                            children: [
                              new TextRun({
                                text: item.value,
                                font: displayFont,
                                size: family === "signal" ? 64 : 42,
                                color: accentLarge,
                              }),
                            ],
                            spacing: { after: 140 },
                          }),
                          new Paragraph({
                            children: [
                              new TextRun({ text: item.label, bold: true, size: 21, color: ink }),
                            ],
                            spacing: { after: item.detail ? 100 : 0 },
                          }),
                          ...(item.detail
                            ? [
                                new Paragraph({
                                  children: [
                                    new TextRun({ text: item.detail, size: 19, color: muted }),
                                  ],
                                  spacing: { after: 0 },
                                }),
                              ]
                            : []),
                        ],
                      }),
                  ),
                }),
              ],
            }),
            spacer(),
          );
        }
        break;
      }
      case "steps":
        for (const [stepIndex, item] of block.items.entries()) {
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: `${String(stepIndex + 1).padStart(2, "0")}   `,
                  color: accentText,
                  bold: true,
                  size: 24,
                }),
                new TextRun({ text: item.title, bold: true, size: 24, color: ink }),
              ],
              keepNext: Boolean(item.detail),
              spacing: { before: 200, after: 100 },
            }),
          );
          if (item.detail) children.push(plain(item.detail, { indent: { left: 540 } }));
        }
        break;
    }
  }

  const folio = (design.footer ?? model.title ?? "").slice(0, 100);
  const doc = new Document({
    title: model.title,
    description: design.subtitle,
    background: { color: hex(theme.paper) },
    theme: {
      colors: { accent1: accent, dark1: ink, light1: hex(theme.paper) },
      fonts: { headings: displayFont, body: bodyFont },
    },
    numbering: { config: numbering },
    styles: {
      default: {
        document: {
          run: { font: bodyFont, size: 22, color: ink },
          // Older LibreOffice versions interpret an inherited w:line without
          // w:lineRule as a fixed body-sized height, overlapping large text.
          paragraph: {
            spacing: {
              after: family === "briefing" ? 140 : 180,
              line: family === "briefing" ? 290 : 310,
              lineRule: LineRuleType.AUTO,
            },
          },
        },
        heading1: {
          run: {
            font: displayFont,
            size: family === "signal" ? 48 : family === "briefing" ? 32 : 36,
            color: ink,
          },
          paragraph: {
            spacing: { before: 420, after: 200, line: 300, lineRule: LineRuleType.AUTO },
            keepNext: true,
          },
        },
        heading2: {
          run: {
            font: displayFont,
            size: family === "signal" ? 40 : family === "briefing" ? 28 : 29,
            color: ink,
          },
          paragraph: {
            spacing: { before: 320, after: 150, line: 300, lineRule: LineRuleType.AUTO },
            keepNext: true,
          },
        },
        heading3: {
          run: { font: bodyFont, size: 24, bold: true, color: accentText },
          paragraph: {
            spacing: { before: 240, after: 130, line: 300, lineRule: LineRuleType.AUTO },
            keepNext: true,
          },
        },
        heading4: {
          run: { font: bodyFont, size: 22, bold: true, color: ink },
          paragraph: { keepNext: true },
        },
        heading5: {
          run: { font: bodyFont, size: 22, bold: true, color: ink },
          paragraph: { keepNext: true },
        },
        heading6: {
          run: { font: bodyFont, size: 22, italics: true, color: ink },
          paragraph: { keepNext: true },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 1100, bottom: 1100, left: 988, right: 988, header: 480, footer: 480 },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                children: [new TextRun({ text: design.eyebrow ?? "", color: muted, size: 16 })],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: folio, color: muted, size: 16 }),
                  new TextRun({ text: "    ·    ", color: muted, size: 16 }),
                  new TextRun({ children: [PageNumber.CURRENT], color: muted, size: 16 }),
                ],
                border: { top: { style: BorderStyle.SINGLE, size: 4, color: surface, space: 8 } },
                spacing: { before: 100 },
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return normalizeOfficePackage(new Uint8Array(await Packer.toBuffer(doc)));
}
