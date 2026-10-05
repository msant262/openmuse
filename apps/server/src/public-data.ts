import { WebReadError } from "./public-web.ts";
export type PublicDataQuery = {
  pointer?: string;
  entries?: boolean;
  select?: string[];
  offset?: number;
  limit?: number;
  where?: { pointer: string; equals: string };
};
function pointer(value: unknown, path: string): unknown {
  if (!path) return value;
  if (!path.startsWith("/"))
    throw new WebReadError(
      "INVALID_POINTER",
      "Use a JSON pointer starting with /, or an empty pointer for the root.",
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
      "This JSON pointer does not exist. Inspect the returned root structure before selecting fields.",
    );
  const source =
    query.entries && chosen && typeof chosen === "object" && !Array.isArray(chosen)
      ? Object.entries(chosen).map(([key, value]) => ({ key, value }))
      : Array.isArray(chosen)
        ? chosen
        : [chosen];
  const matches = query.where
    ? source.filter((row) => String(pointer(row, query.where!.pointer)) === query.where!.equals)
    : source;
  const offset = Math.max(0, Math.trunc(query.offset ?? 0)),
    limit = Math.min(100, Math.max(1, Math.trunc(query.limit ?? 30)));
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
    ...(rows.length === 0 && matches.length > offset
      ? {
          instruction:
            "Rows exceed the output budget. Select only needed fields using select JSON pointers; no partial row was returned.",
        }
      : {}),
  };
}
