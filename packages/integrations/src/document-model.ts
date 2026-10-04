import { Lexer, type Token, type Tokens } from "marked";
import { z } from "zod";
import { PdfError } from "./pdf.ts";

export type DocumentRun = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
};

export type DocumentListItem = {
  runs: DocumentRun[];
  level: number;
  ordered?: boolean;
  number?: number;
  listId?: number;
};

export type DocumentBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; runs: DocumentRun[] }
  | {
      type: "list";
      ordered: boolean;
      start: number;
      items: DocumentListItem[];
    }
  | { type: "quote"; runs: DocumentRun[] }
  | { type: "table"; headers: DocumentRun[][]; rows: DocumentRun[][][] }
  | { type: "code"; text: string; language?: string }
  | { type: "rule" }
  | { type: "image"; fileId: string; caption: string }
  | { type: "chart"; title: string; labels: string[]; values: number[]; unit?: string }
  | { type: "metrics"; items: { label: string; value: string; detail?: string }[] }
  | { type: "steps"; items: { title: string; detail?: string }[] };

export type DocumentTheme = {
  id: string;
  label: string;
  paper: string;
  ink: string;
  muted: string;
  accent: string;
  surface: string;
  display: "serif" | "sans";
};

export type DocumentDesign = {
  reference?: string;
  subtitle?: string;
  eyebrow?: string;
  footer?: string;
  cover?: boolean;
};

export type DocumentImage = {
  id: string;
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
};

export type DocumentModel = {
  title?: string;
  blocks: DocumentBlock[];
  theme: DocumentTheme;
  design: DocumentDesign;
  images: ReadonlyMap<string, DocumentImage>;
};

export const defaultDocumentTheme: DocumentTheme = {
  id: "editorial",
  label: "Editorial",
  paper: "#FAF9F5",
  ink: "#30302E",
  muted: "#65645F",
  accent: "#C96442",
  surface: "#EAE8E0",
  display: "serif",
};

export const runsText = (runs: readonly DocumentRun[]) => runs.map((run) => run.text).join("");

const chart = z
  .object({
    title: z.string().min(1).max(160),
    labels: z.array(z.string().min(1).max(100)).min(1).max(12),
    values: z.array(z.number().finite()).min(1).max(12),
    unit: z.string().max(24).optional(),
  })
  .strict()
  .refine(
    (value) => value.labels.length === value.values.length,
    "Chart labels and values must match",
  );
const metrics = z
  .object({
    items: z
      .array(
        z
          .object({
            label: z.string().min(1).max(100),
            value: z.string().min(1).max(36),
            detail: z.string().max(200).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict();
const steps = z
  .object({
    items: z
      .array(
        z
          .object({
            title: z.string().min(1).max(100),
            detail: z.string().max(400).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();

function inline(tokens: Token[], style: Omit<DocumentRun, "text"> = {}): DocumentRun[] {
  return tokens.flatMap((token): DocumentRun[] => {
    if (token.type === "strong")
      return inline((token as Tokens.Strong).tokens, { ...style, bold: true });
    if (token.type === "em") return inline((token as Tokens.Em).tokens, { ...style, italic: true });
    if (token.type === "link") {
      const link = token as Tokens.Link;
      if (!/^(https?:|mailto:)/i.test(link.href))
        throw new PdfError("Document links must use HTTP(S) or mailto");
      return inline(link.tokens, { ...style, href: link.href });
    }
    if (token.type === "br") return [{ ...style, text: "\n" }];
    if (token.type === "codespan")
      return [{ ...style, text: (token as Tokens.Codespan).text, code: true }];
    if (token.type === "html")
      throw new PdfError("Raw HTML is not supported in authored documents; use Markdown");
    if (token.type === "image")
      throw new PdfError("Place each owned file: image on its own paragraph");
    if ("tokens" in token && Array.isArray(token.tokens)) return inline(token.tokens, style);
    return [{ ...style, text: "text" in token ? String(token.text) : token.raw }];
  });
}

function imageBlock(token: Tokens.Image): DocumentBlock {
  const id = token.href.match(/^file:([a-f0-9]{64}|[a-f0-9-]{36})$/)?.[1];
  if (!id)
    throw new PdfError(
      "Use an owned image attachment with ![caption](file:FILE_ID); remote images are not fetched",
    );
  return { type: "image", fileId: id, caption: token.text };
}

function blocksFrom(tokens: Token[], depth = 0): DocumentBlock[] {
  if (depth > 12) throw new PdfError("Document nesting exceeds 12 levels");
  return tokens.flatMap((token): DocumentBlock[] => {
    if (token.type === "space" || token.type === "def") return [];
    if (token.type === "html")
      throw new PdfError("Raw HTML is not supported in authored documents; use Markdown");
    if (token.type === "heading") {
      const heading = token as Tokens.Heading;
      return [{ type: "heading", level: heading.depth, text: runsText(inline(heading.tokens)) }];
    }
    if (token.type === "hr") return [{ type: "rule" }];
    if (token.type === "paragraph" || token.type === "text") {
      const paragraph = token as Tokens.Paragraph;
      const items = paragraph.tokens ?? Lexer.lexInline(paragraph.text);
      if (items.length === 1 && items[0].type === "image")
        return [imageBlock(items[0] as Tokens.Image)];
      return [{ type: "paragraph", runs: inline(items) }];
    }
    if (token.type === "blockquote") {
      const children = blocksFrom((token as Tokens.Blockquote).tokens, depth + 1);
      return children.flatMap((block): DocumentBlock[] =>
        block.type === "paragraph" ? [{ type: "quote", runs: block.runs }] : [block],
      );
    }
    if (token.type === "list") {
      const list = token as Tokens.List;
      const items: DocumentListItem[] = [];
      let nextListId = 0;
      const walk = (current: Tokens.List, level: number) => {
        if (level > 8) throw new PdfError("Document lists exceed 8 levels");
        const listId = nextListId++;
        for (const [index, item] of current.items.entries()) {
          const own = item.tokens.filter((entry) => entry.type !== "list");
          const text = own
            .map((entry) => ("text" in entry ? String(entry.text) : entry.raw))
            .join("\n");
          items.push({
            runs: inline(Lexer.lexInline(text)),
            level,
            ordered: current.ordered,
            number: current.ordered ? (Number(current.start) || 1) + index : undefined,
            listId,
          });
          for (const nested of item.tokens.filter((entry) => entry.type === "list"))
            walk(nested as Tokens.List, level + 1);
        }
      };
      walk(list, 0);
      return [{ type: "list", ordered: list.ordered, start: Number(list.start) || 1, items }];
    }
    if (token.type === "table") {
      const table = token as Tokens.Table;
      if (table.header.length > 8 || table.rows.length > 1000)
        throw new PdfError("Tables support at most 8 columns and 1000 rows; split larger tables");
      return [
        {
          type: "table",
          headers: table.header.map((cell) => inline(cell.tokens)),
          rows: table.rows.map((row) => row.map((cell) => inline(cell.tokens))),
        },
      ];
    }
    if (token.type === "code") {
      const code = token as Tokens.Code;
      if (["chart", "metrics", "steps"].includes(code.lang ?? "")) {
        try {
          const value = JSON.parse(code.text);
          if (code.lang === "chart") return [{ type: "chart", ...chart.parse(value) }];
          if (code.lang === "metrics") return [{ type: "metrics", ...metrics.parse(value) }];
          return [{ type: "steps", ...steps.parse(value) }];
        } catch (error) {
          throw new PdfError(
            `Invalid ${code.lang} block: ${error instanceof Error ? error.message.slice(0, 300) : "invalid JSON"}`,
          );
        }
      }
      return [{ type: "code", text: code.text, language: code.lang }];
    }
    throw new PdfError(`Unsupported document Markdown block: ${token.type}`);
  });
}

/** Interpret Markdown as bounded native elements, never as executable HTML. */
export function composeDocument(
  content: string,
  title?: string,
  design: DocumentDesign = {},
  theme: DocumentTheme = defaultDocumentTheme,
  images: ReadonlyMap<string, DocumentImage> = new Map(),
): DocumentModel {
  if (!content.trim() || content.length > 120000 || (title?.length ?? 0) > 200)
    throw new PdfError(
      "Document content must be nonempty and at most 120000 characters; title at most 200",
    );
  const blocks = blocksFrom(
    Lexer.lex(content.normalize("NFC").replace(/\r\n?/g, "\n"), { gfm: true }),
  );
  let heading = title?.normalize("NFC");
  const first = blocks[0];
  if (
    first?.type === "heading" &&
    first.level === 1 &&
    (!heading || first.text.toLocaleLowerCase() === heading.toLocaleLowerCase())
  ) {
    heading ??= first.text;
    blocks.shift();
  }
  if ((heading?.length ?? 0) > 200)
    throw new PdfError(
      "Document title must be at most 200 characters; use a shorter title and put detail in the body",
    );
  return { title: heading, blocks, design, theme, images };
}
