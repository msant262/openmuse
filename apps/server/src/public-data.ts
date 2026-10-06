import { WebReadError } from "./public-web.ts";
export type PublicDataQuery = {
  pointer?: string;
  entries?: boolean;
  select?: string[];
  offset?: number;
  limit?: number;
  where?: { pointer: string; equals?: string; oneOf?: string[] };
  aggregate?: {
    expand?: string;
    groupBy: { name: string; pointer: string; prefix?: number }[];
    sum: { name: string; pointer: string; numberFormat?: "number" | "pt-BR" | "en-US" }[];
    share?: { of: string; within: string[]; name: string };
  };
};
function availableFields(value: unknown) {
  if (!value || typeof value !== "object") return `This scope is ${typeof value}.`;
  const keys = Object.keys(value);
  const fields = keys.slice(0, 40).map((key) => {
    const item = (value as Record<string, unknown>)[key];
    const type = Array.isArray(item) ? "array" : item === null ? "null" : typeof item;
    return `/${key.replaceAll("~", "~0").replaceAll("/", "~1")} (${type})`;
  });
  return `Available fields at this scope: ${fields.join(", ") || "none"}.${keys.length > fields.length ? " Additional fields omitted; inspect the root structure to select them." : ""}`;
}
function pointer(value: unknown, path: string): unknown {
  if (!path) return value;
  if (!path.startsWith("/"))
    throw new WebReadError(
      "INVALID_POINTER",
      `Use a JSON pointer starting with /, or pointer="" for the root. ${Object.hasOwn(Object(value), path) ? `Use /${path.replaceAll("~", "~0").replaceAll("/", "~1")} for the requested field. ` : ""}${availableFields(value)}`,
    );
  for (const part of path
    .slice(1)
    .split("/")
    .map((x) => x.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
function shape(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.slice(0, 150);
  if (Array.isArray(value))
    return {
      type: "array",
      length: value.length,
      sample: depth < 3 ? value.slice(0, 2).map((x) => shape(x, depth + 1)) : undefined,
    };
  if (value && typeof value === "object")
    return depth < 3
      ? Object.fromEntries(
          Object.entries(value)
            .slice(0, 40)
            .map(([k, v]) => [k, shape(v, depth + 1)]),
        )
      : { type: "object", keys: Object.keys(value).slice(0, 40) };
  return value;
}
export function selectPublicData(value: unknown, query: PublicDataQuery = {}) {
  const chosen = pointer(value, query.pointer ?? "");
  if (chosen === undefined)
    throw new WebReadError(
      "POINTER_NOT_FOUND",
      `This JSON pointer does not exist. Use pointer="" for the root, then select an observed field path. ${availableFields(value)}`,
    );
  const source =
    query.entries && chosen && typeof chosen === "object" && !Array.isArray(chosen)
      ? Object.entries(chosen).map(([key, value]) => ({ key, value }))
      : Array.isArray(chosen)
        ? chosen
        : [chosen];
  const aggregated = query.aggregate ? aggregateData(source, query.aggregate) : undefined;
  const data = aggregated?.rows ?? source;
  const matches = query.where
    ? data.filter(
        (row) =>
          query.where!.oneOf?.includes(String(pointer(row, query.where!.pointer))) ??
          String(pointer(row, query.where!.pointer)) === query.where!.equals,
      )
    : data;
  const offset = Math.max(0, Math.trunc(query.offset ?? 0)),
    limit = Math.max(1, Math.trunc(query.limit ?? 30));
  const rows: unknown[] = [];
  let bytes = 0;
  for (const row of matches.slice(offset, offset + limit)) {
    const selected = query.select?.length
      ? Object.fromEntries(query.select.map((path) => [path, pointer(row, path) ?? null]))
      : row;
    const size = JSON.stringify(selected).length;
    if (bytes + size > 24000) break;
    rows.push(selected);
    bytes += size;
  }
  const nextOffset = offset + rows.length < matches.length ? offset + rows.length : null;
  return {
    rows,
    total: matches.length,
    offset,
    nextOffset,
    truncated: nextOffset !== null,
    structure: shape(chosen),
    ...(aggregated
      ? {
          aggregation: {
            inputRows: source.length,
            expandedRows: aggregated.expandedRows,
            groups: aggregated.rows.length,
            query: query.aggregate,
          },
        }
      : {}),
    ...(rows.length === 0 && matches.length > offset
      ? {
          instruction:
            "Rows exceed the output budget. Select only needed fields using select JSON pointers; no partial row was returned.",
        }
      : {}),
  };
}

function aggregateData(source: unknown[], query: NonNullable<PublicDataQuery["aggregate"]>) {
  const names = [...query.groupBy, ...query.sum].map((field) => field.name);
  if (
    new Set(names).size !== names.length ||
    names.includes("count") ||
    (query.share && names.includes(query.share.name))
  )
    throw new WebReadError(
      "INVALID_AGGREGATION",
      "Aggregation output names must be unique; count is reserved.",
    );
  const groups = new Map<string, Record<string, string | number | boolean | null>>();
  let expandedRows = 0;
  for (const parent of source) {
    const expanded = query.expand ? pointer(parent, query.expand) : [parent];
    if (!Array.isArray(expanded))
      throw new WebReadError(
        "INVALID_AGGREGATION",
        "expand must point to an array in every selected source row.",
      );
    for (const item of expanded) {
      expandedRows++;
      const input = query.expand ? { parent, item } : parent;
      const pointerHint = (path: string) => {
        if (!query.expand) return "";
        const source = pointer(parent, path);
        return source !== undefined &&
          (source === null || ["string", "number", "boolean"].includes(typeof source))
          ? ` With expand, the source row is under /parent; use /parent${path} for this field. Expanded item fields use /item/... .`
          : " With expand, grouping and sum pointers start with /parent/... for source fields or /item/... for expanded item fields.";
      };
      const fields = query.groupBy.map((field) => {
        const value = pointer(input, field.pointer);
        if (
          value === undefined ||
          (value !== null && !["string", "number", "boolean"].includes(typeof value))
        )
          throw new WebReadError(
            "INVALID_AGGREGATION",
            `Group field ${field.pointer} must exist and be a scalar.${pointerHint(field.pointer)} ${availableFields(input)}${field.pointer === "/key" && !query.expand ? " To group source object keys, set entries=true on the data read; each row then has /key and /value." : ""}`,
          );
        return field.prefix
          ? String(value).slice(0, field.prefix)
          : (value as string | number | boolean | null);
      });
      const key = JSON.stringify(fields);
      let row = groups.get(key);
      if (!row) {
        row = Object.fromEntries(query.groupBy.map((field, i) => [field.name, fields[i]]));
        row.count = 0;
        for (const field of query.sum) row[field.name] = 0;
        groups.set(key, row);
      }
      row.count = Number(row.count) + 1;
      for (const field of query.sum) {
        const raw = pointer(input, field.pointer);
        let normalized = raw;
        if (typeof raw === "string") {
          if (
            field.numberFormat === "pt-BR" &&
            /^-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$/.test(raw)
          )
            normalized = raw.replaceAll(".", "").replace(",", ".");
          else if (
            field.numberFormat === "en-US" &&
            /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(raw)
          )
            normalized = raw.replaceAll(",", "");
          else if (field.numberFormat && field.numberFormat !== "number") normalized = undefined;
        }
        if (
          normalized === undefined ||
          normalized === null ||
          (typeof normalized !== "number" &&
            (typeof normalized !== "string" ||
              !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(normalized))) ||
          !Number.isFinite(Number(normalized))
        )
          throw new WebReadError(
            "INVALID_AGGREGATION",
            `Sum field ${field.pointer} contains a missing or invalid number; no incomplete totals were returned.`,
          );
        row[field.name] = Number(row[field.name]) + Number(normalized);
        if (!Number.isFinite(row[field.name]))
          throw new WebReadError(
            "INVALID_AGGREGATION",
            "An aggregate total exceeds the numeric range.",
          );
      }
    }
  }
  const rows = [...groups.values()];
  if (query.share) {
    const share = query.share;
    if (
      !query.sum.some((field) => field.name === share.of) ||
      share.within.some((name) => !query.groupBy.some((field) => field.name === name))
    )
      throw new WebReadError(
        "INVALID_AGGREGATION",
        "share.of must name a sum and share.within must name grouping fields.",
      );
    const totals = new Map<string, number>();
    const key = (row: Record<string, unknown>) =>
      JSON.stringify(share.within.map((name) => row[name]));
    for (const row of rows)
      totals.set(key(row), (totals.get(key(row)) ?? 0) + Number(row[share.of]));
    for (const row of rows) {
      const total = totals.get(key(row)) ?? 0;
      row[share.name] = total ? (100 * Number(row[share.of])) / total : null;
    }
  }
  return { rows, expandedRows };
}
