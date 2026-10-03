import type { AgentArtifact } from "../../../packages/domain/src/agent";

export function presentationRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstText(row: Record<string, unknown>, keys: string[]) {
  return keys.map((key) => text(row[key])).find(Boolean);
}

/** Sources are links, never executable URLs or automatically loaded remote media. */
export function resultSourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (
      ["https:", "http:"].includes(url.protocol) &&
      url.hostname &&
      !url.username &&
      !url.password
    )
      return url.href;
  } catch {}
}

export type ResultItem = {
  title: string;
  detail?: string;
  price?: string;
  url?: string;
  pros: string[];
  cons: string[];
};

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((value) => {
        const content = text(value);
        return content ? [content] : [];
      })
    : [];
}

function item(value: unknown): ResultItem | undefined {
  const plain = text(value);
  if (plain) return { title: plain, pros: [], cons: [] };
  const row = presentationRecord(value);
  if (!row) return;
  const title = firstText(row, ["title", "name", "label", "action", "step"]);
  const detail = firstText(row, ["description", "detail", "summary", "body", "content", "text"]);
  if (!title && !detail) return;
  const price =
    typeof row.price === "number" && Number.isFinite(row.price)
      ? `${row.price}${text(row.currency) ? ` ${text(row.currency)}` : ""}`
      : text(row.price);
  return {
    title: title ?? detail ?? "",
    detail: title ? detail : undefined,
    price,
    url: resultSourceUrl(row.url ?? row.sourceUrl ?? presentationRecord(row.source)?.url),
    pros: strings(row.pros),
    cons: strings(row.cons),
  };
}

function normalizedText(value: string) {
  return value
    .replace(/[\s*_`#]+/g, " ")
    .trim()
    .toLowerCase();
}

function includesItems(value: string | undefined, items: ResultItem[], details: boolean) {
  if (!value || !items.length) return false;
  const content = normalizedText(value);
  return items.every(
    (entry) =>
      content.includes(normalizedText(entry.title)) &&
      (!details || !entry.detail || content.includes(normalizedText(entry.detail))),
  );
}

/** Tolerates historical text plans and structured results without exposing schema fields. */
export function artifactPresentation(artifact: AgentArtifact) {
  const data = artifact.data;
  const body = firstText(data, ["text", "markdown", "content", "body", "report", "plan"]);
  const keys =
    artifact.kind === "comparison"
      ? ["options", "items", "results", "rows", "comparison"]
      : ["steps", "milestones", "actions"];
  const list = keys.map((key) => data[key]).find(Array.isArray);
  const items = Array.isArray(list)
    ? list.flatMap((value) => {
        const entry = item(value);
        return entry ? [entry] : [];
      })
    : [];
  const sections = Array.isArray(data.sections)
    ? data.sections.flatMap((value) => {
        const entry = item(value);
        return entry ? [entry] : [];
      })
    : [];
  const excerpt = artifact.summary.trim() || body || sections[0]?.detail || "";
  return {
    body,
    items,
    sections,
    previewExcerpt: includesItems(excerpt, items.slice(0, 3), false) ? "" : excerpt,
    showItems: artifact.kind === "comparison" || !includesItems(body, items, true),
    showSummary:
      Boolean(artifact.summary.trim()) &&
      (!body || !normalizedText(body).includes(normalizedText(artifact.summary))),
    hasContent: Boolean(body || items.length || sections.length),
  };
}

/** Compact receipts use visible option labels rather than internal option IDs. */
export function questionReceiptAnswers(
  request: import("../../../packages/domain/src/runtime").InteractionRequest,
) {
  if (request.kind !== "question" || request.status !== "answered") return [];
  return request.schema.fields.flatMap((field) => {
    const value = request.answer?.[field.id];
    if (field.type === "text")
      return typeof value === "string" && value.trim() ? [{ label: field.label, value }] : [];
    const selected = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
    const labels = field.options
      .filter((option) => selected.includes(option.id))
      .map((option) => option.label);
    return labels.length ? [{ label: field.label, value: labels.join(", ") }] : [];
  });
}
