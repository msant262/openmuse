import type { z } from "zod";
import {
  composeDocument,
  defaultDocumentTheme,
  runsText,
} from "../../../../packages/integrations/src/document-model.ts";
import type { documentArgs } from "../media-tools.ts";

const words = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) ?? [];

/** Layout choices do not change facts; visible titles/footers still do. */
export function researchDocumentContent(args: z.output<typeof documentArgs>) {
  return JSON.stringify({
    content: args.content,
    title: args.title,
    subtitle: args.design?.subtitle,
    eyebrow: args.design?.eyebrow,
    footer: args.design?.footer,
  });
}

/** The trusted authoring receipt binds input to bytes. Extraction additionally
 * checks that reviewed facts survived rendering. Page headers may interrupt a
 * sentence; they cannot substitute for missing words, negations or values.
 * Images need independent factual review and never qualify for this shortcut. */
export function reviewedDocumentTextPresent(
  args: z.output<typeof documentArgs>,
  actual: { text: string; nextOffset: number | null },
) {
  if (actual.nextOffset !== null) return false;
  if (args.format === "text" || args.format === "markdown") return actual.text === args.content;
  const model = composeDocument(args.content, args.title, args.design, defaultDocumentTheme);
  const fragments: string[] = [
    model.title ?? "",
    model.design.subtitle ?? "",
    model.design.eyebrow ?? "",
    model.design.footer ?? "",
  ];
  for (const block of model.blocks) {
    switch (block.type) {
      case "heading":
      case "code":
        fragments.push(block.text);
        break;
      case "paragraph":
      case "quote":
        fragments.push(runsText(block.runs));
        break;
      case "list":
        fragments.push(...block.items.map((item) => runsText(item.runs)));
        break;
      case "table":
        fragments.push(
          ...block.headers.map(runsText),
          ...block.rows.flatMap((row) => row.map(runsText)),
        );
        break;
      case "metrics":
        fragments.push(
          ...block.items.flatMap((item) => [item.label, item.value, item.detail ?? ""]),
        );
        break;
      case "steps":
        fragments.push(...block.items.flatMap((item) => [item.title, item.detail ?? ""]));
        break;
      case "chart":
        fragments.push(block.title, ...block.labels, ...block.values.map(String), block.unit ?? "");
        break;
      case "image":
        return false;
      case "rule":
        break;
    }
  }
  const observed = words(actual.text);
  return fragments.every((fragment) => {
    const expected = words(fragment);
    if (!expected.length) return true;
    let matched = 0;
    for (const word of observed) {
      if (word === expected[matched]) matched++;
      if (matched === expected.length) return true;
    }
    return false;
  });
}
