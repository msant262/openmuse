/** Only a fixed provider usage URL is eligible for an actionable error link. */
export function modelUsageUrl(error: string): string | undefined {
  return error.includes("https://chatgpt.com/settings/usage")
    ? "https://chatgpt.com/settings/usage"
    : undefined;
}

/** Provider notices have a small public shape; arbitrary event values are never displayed. */
export function modelSelectionNotice(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.provider !== "string" ||
    !/^[a-z][a-z0-9-]{1,24}$/.test(record.provider) ||
    typeof record.model !== "string" ||
    !/^[a-zA-Z0-9_./:+-]{1,160}$/.test(record.model) ||
    typeof record.fallback !== "boolean"
  )
    return undefined;
  return `${record.provider} · ${record.model}${record.fallback ? " · provedor alternativo" : ""}`;
}
