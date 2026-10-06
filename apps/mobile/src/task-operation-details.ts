import type { Evidence } from "../../../packages/domain/src/agent";
import type { CompletionCriterion } from "../../../packages/domain/src/runtime";
import { presentationRecord, resultSourceUrl } from "./artifact-presentation";

export type TaskOperationDetail = {
  id: string;
  toolName: string;
  status: string;
  args?: unknown;
  receipt?: unknown;
  error?: string;
};

export type OperationNode =
  | { kind: "text"; label?: string; value: string | number | boolean; localized?: boolean }
  | { kind: "group"; label?: string; children: OperationNode[] }
  | { kind: "source"; title: string; url: string; excerpt?: string; consulted?: boolean }
  | { kind: "file"; fileId: string; name: string; mimeType?: string; size?: number }
  | { kind: "check"; label: string; passed: boolean };

const labels: Record<string, string> = {
  query: "Search terms",
  limit: "Requested results",
  prompt: "Image brief",
  name: "Name",
  title: "Title",
  summary: "Summary",
  text: "Content",
  content: "Content",
  body: "Content",
  markdown: "Content",
  description: "Description",
  detail: "Details",
  details: "Details",
  message: "Message",
  error: "Needs attention",
  reason: "Reason",
  status: "Status",
  outcome: "Outcome",
  results: "Results",
  items: "Items",
  rows: "Results",
  steps: "Steps",
  verification: "Verification",
  requiredTools: "Required tools",
  inputs: "Inputs",
  output: "Output",
  date: "Date",
  start: "Start",
  end: "End",
  location: "Location",
  timeZone: "Time zone",
  primary: "Primary calendar",
  subject: "Subject",
  to: "To",
  from: "From",
  count: "Count",
  total: "Total",
  available: "Available",
  success: "Successful",
  aspectRatio: "Aspect ratio",
  size: "Size",
  model: "Image model",
  observedAt: "Checked at",
  createdAt: "Created at",
  remaining: "Still needed",
  includeArchived: "Include archived",
  stdout: "Output",
  stderr: "Needs attention",
};
const statuses: Record<string, string> = {
  ok: "Completed",
  succeeded: "Completed",
  completed: "Completed",
  verified: "Delivery verified",
  partial: "Partial delivery",
  failed: "Failed",
  error: "Failed",
  unavailable: "Unavailable",
  disconnected: "Disconnected",
  pending: "Awaiting result",
  running: "In progress",
  queued: "Queued",
  unknown: "Not checked yet",
  cancelled: "Cancelled",
};
const technicalKey =
  /(?:token|password|secret|credential|api_?key|base64|^provenance$|^spill$|^extraction$|^sourceLength$|^links$|^dataSources$|^maxChars$|^mode$|^provider$|^fileImage$|^attachment$|^truncated$)/i;
const identifierKey = /(?:^ids?$|[_-]ids?$|Id$|Ids$)/;
const string = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const label = (key: string) =>
  labels[key] ??
  key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .replace(/^./, (c) => c.toUpperCase());

function savedValue(value: unknown): unknown {
  if (typeof value !== "string" || !/^[\s]*[[{]/.test(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function readable(value: unknown, depth = 0): OperationNode[] {
  value = savedValue(value);
  if (value === null || value === undefined || depth > 6) return [];
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number")
    return [{ kind: "text", value }];
  if (Array.isArray(value)) return value.flatMap((v) => readable(v, depth + 1));
  const row = presentationRecord(value);
  if (!row) return [];
  const nodes: OperationNode[] = [];
  const consumed = new Set<string>();
  const fileId = string(row.fileId) ?? (string(row.mimeType) ? string(row.id) : undefined);
  if (fileId) {
    nodes.push({
      kind: "file",
      fileId,
      name: string(row.name) ?? "Attachment",
      mimeType: string(row.mimeType),
      size: typeof row.size === "number" ? row.size : undefined,
    });
    for (const key of ["name", "mimeType", "size"]) consumed.add(key);
  }
  const url = resultSourceUrl(row.url ?? row.sourceUrl);
  if (url) {
    nodes.push({
      kind: "source",
      title: string(row.title) ?? string(row.name) ?? new URL(url).hostname,
      url,
      excerpt: string(row.snippet) ?? string(row.description),
    });
    for (const key of ["title", "name", "description", "snippet"]) consumed.add(key);
  }
  for (const [key, entry] of Object.entries(row)) {
    if (
      consumed.has(key) ||
      identifierKey.test(key) ||
      technicalKey.test(key) ||
      key === "url" ||
      key === "sourceUrl"
    )
      continue;
    if (key === "generation") {
      const model = string(presentationRecord(entry)?.model);
      if (model) nodes.push({ kind: "text", label: "Image model", value: model });
      continue;
    }
    if (entry === null || entry === undefined) continue;
    if ((key === "status" || key === "outcome") && typeof entry === "string" && statuses[entry]) {
      nodes.push({ kind: "text", label: label(key), value: statuses[entry], localized: true });
      continue;
    }
    const children = readable(entry, depth + 1);
    if (children.length === 1 && children[0].kind === "text")
      nodes.push({ ...children[0], label: label(key) });
    else if (children.length) nodes.push({ kind: "group", label: label(key), children });
  }
  return nodes;
}

/** Interpret saved receipts only; completion, source excerpts and errors keep their actual meaning. */
export function operationPresentation(
  operation: TaskOperationDetail,
  criteria: readonly Pick<CompletionCriterion, "id" | "description">[] = [],
) {
  const args = presentationRecord(savedValue(operation.args)) ?? {};
  const result = savedValue(operation.receipt);
  const receipt = presentationRecord(result);
  const tool = operation.toolName.replace(/^primitive\./, "");
  let input = readable(operation.args);
  let output = readable(result);
  if (
    tool === "execute_google_workspace_tool" &&
    typeof args.toolId === "string" &&
    /^calendar\.(calendarList|calendars)\./.test(args.toolId)
  ) {
    const data = presentationRecord(receipt?.data) ?? {};
    const calendar = (value: unknown) => {
      const entry = presentationRecord(value) ?? {};
      return {
        title: entry.summary,
        description: entry.description,
        timeZone: entry.timeZone,
        primary: entry.primary,
      };
    };
    input = readable({ account: args.account });
    output = readable({
      status: receipt?.status,
      account: receipt?.account,
      ...(Array.isArray(data.items) ? { items: data.items.map(calendar) } : calendar(data)),
    });
  } else if (tool === "search_web") {
    input = readable({ query: args.query, limit: args.limit });
    output = readable(
      receipt
        ? {
            status: receipt.status,
            error: receipt.error,
            message: receipt.message,
            sources: receipt.sources,
            observedAt: receipt.observedAt,
          }
        : result,
    );
    // Render cards directly so the source list reads naturally rather than as a nested schema.
    const sources = readable(receipt?.sources);
    output = output.filter((n) => n.kind !== "group" || n.label !== "Sources");
    output.push(...sources);
    if (Array.isArray(receipt?.sources) && !receipt.sources.length)
      output.push({ kind: "text", value: "No sources found.", localized: true });
  } else if (tool === "web_fetch") {
    input = readable({ url: args.url });
    output = readable(
      receipt
        ? {
            title: receipt.title,
            url: receipt.url ?? args.url,
            text: receipt.text,
            error: receipt.error,
            status: receipt.status,
            observedAt: receipt.observedAt,
          }
        : result,
    );
    if (receipt?.truncated === true)
      output.push({
        kind: "text",
        value: "This is a saved excerpt. Open the source to read the full page.",
        localized: true,
      });
  } else if (tool === "finish_task") {
    input = readable({ summary: args.summary });
    output = [
      ...readable({ summary: receipt?.summary }),
      ...completionPresentation(receipt?.completion, criteria),
    ];
    const ids = Array.isArray(args.artifactIds) ? args.artifactIds : [];
    output.push(
      ...ids
        .filter((id): id is string => typeof id === "string")
        .map((fileId) => ({ kind: "file" as const, fileId, name: "Attachment" })),
    );
    if (!output.length) output = readable(result);
  }
  if (operation.error)
    output.push({ kind: "text", label: "Needs attention", value: operation.error });
  return { input, output };
}

export function taskOperationValue(value: unknown): string {
  if (value === undefined) return "";
  const parsed = savedValue(value);
  return typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
}

/** Completion is the recorded assessment, not inferred from the presence of a file. */
export function completionPresentation(
  value: unknown,
  criteria: readonly Pick<CompletionCriterion, "id" | "description">[] = [],
): OperationNode[] {
  const completion = presentationRecord(value);
  if (!completion) return [];
  const nodes = readable({ outcome: completion.status });
  if (Array.isArray(completion.checks)) {
    for (const entry of completion.checks) {
      const check = presentationRecord(entry);
      if (!check || typeof check.passed !== "boolean") continue;
      nodes.push({
        kind: "check",
        label:
          check.criterionId === "requested-image"
            ? "Requested image delivered"
            : (criteria.find((c) => c.id === check.criterionId)?.description ?? "Delivery check"),
        passed: check.passed,
      });
    }
  }
  nodes.push(...readable({ remaining: completion.remaining }));
  return nodes;
}

function sourceExcerpt(value: unknown) {
  const content = string(value);
  if (!content || /^[\s]*[[{]/.test(content)) return undefined;
  // Page navigation is not a useful summary of its contents. Preserve Markdown
  // in the first actual paragraph; the complete saved receipt stays available.
  const paragraph = content
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .find(
      (s) =>
        s &&
        !/^(?:Breadcrumb$|Share$|Read AI-generated summary$|In this article$|#+\s|[-*]\s|\||!\[|\[[^\]]+\]\([^)]+\)$)/i.test(
          s,
        ),
    );
  return (
    paragraph && (paragraph.length > 600 ? `${paragraph.slice(0, 600).trimEnd()}…` : paragraph)
  );
}

/** Recover source cards from complete receipts, not guessed repairs to clipped JSON evidence. */
export function taskSourcesPresentation(
  evidence: readonly Evidence[],
  operations: readonly TaskOperationDetail[],
) {
  type Source = Extract<OperationNode, { kind: "source" }> & { consulted: boolean };
  const sources = new Map<string, Source>();
  function add(value: unknown, consulted = false) {
    const row = presentationRecord(value);
    const url = resultSourceUrl(row?.url);
    if (!row || !url) return;
    const source: Source = {
      kind: "source",
      url,
      title: string(row.title) ?? new URL(url).hostname,
      excerpt: sourceExcerpt(row.snippet ?? row.excerpt ?? row.text),
      consulted,
    };
    const previous = sources.get(url);
    sources.set(
      url,
      previous
        ? {
            ...source,
            title: consulted ? source.title : previous.title,
            excerpt: previous.excerpt ?? source.excerpt,
            consulted: previous.consulted || consulted,
          }
        : source,
    );
  }
  for (const operation of operations) {
    if (operation.status !== "succeeded") continue;
    const receipt = presentationRecord(savedValue(operation.receipt));
    const tool = operation.toolName.replace(/^primitive\./, "");
    if (tool === "search_web" && Array.isArray(receipt?.sources))
      for (const entry of receipt.sources) add(entry);
    if (tool === "web_fetch" && !receipt?.error && string(receipt?.text)) add(receipt, true);
  }
  for (const entry of evidence) {
    if (entry.kind !== "web") continue;
    if (/^Search index:/i.test(entry.title) || /^Index entries only;/i.test(entry.excerpt)) {
      const start = entry.excerpt.indexOf("[{");
      const values = start >= 0 ? savedValue(entry.excerpt.slice(start)) : undefined;
      if (Array.isArray(values)) for (const value of values) add(value);
      continue;
    }
    add(entry);
  }
  return [...sources.values()].sort((a, b) => Number(b.consulted) - Number(a.consulted));
}
