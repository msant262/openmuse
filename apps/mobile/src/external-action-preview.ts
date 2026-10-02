/** Additional connector review lines; the private server binding remains authoritative. */
export function connectorReviewLines(
  data: Record<string, unknown>,
): { label: string; value: string }[] {
  if (data.tool !== "mcp.call") return [];
  return [
    ["Connector", data.connector],
    ["Account", data.account],
    ["Operation", data.operation],
    ["Request", data.request],
  ].flatMap(([label, value]) =>
    typeof value === "string" ? [{ label: String(label), value }] : [],
  );
}
