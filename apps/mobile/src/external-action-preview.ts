/** Additional connector review lines; the private server binding remains authoritative. */
export function connectorReviewLines(
  data: Record<string, unknown>,
): { label: string; value: string }[] {
  if (data.tool === "google.workspace") {
    const operation = String(data.operation ?? "");
    const service = operation.split(".")[0];
    const verbs: Record<string, string> = {
      delete: "Delete",
      batchDelete: "Delete",
      trash: "Move to trash",
      emptyTrash: "Empty trash",
      clear: "Clear contents",
      batchClear: "Clear contents",
      remove: "Remove",
      send: "Send",
      create: "Create",
      insert: "Create",
      update: "Update",
      patch: "Update",
      batchUpdate: "Update",
      modify: "Change labels",
      batchModify: "Change labels",
      copy: "Copy",
    };
    return [
      ["Account", data.account],
      [
        "Service",
        {
          gmail: "Gmail",
          calendar: "Calendar",
          drive: "Google Drive",
          docs: "Google Docs",
          sheets: "Google Sheets",
          slides: "Google Slides",
        }[service],
      ],
      [
        "Action",
        data.requiresHumanApproval
          ? "Delete or remove contents"
          : (verbs[operation.split(".").at(-1) ?? ""] ?? operation),
      ],
      ["Item", data.resourceName],
      ["Subject", data.subject],
      ["To", data.to],
      ["Cc", data.cc],
      ["Bcc", data.bcc],
      ["Calendar", data.calendarId],
      ["Event reference", data.eventId],
      ["File reference", data.fileId],
      ["Starts", data.starts],
      ["Document reference", data.documentId],
      ["Spreadsheet reference", data.spreadsheetId],
      ["Presentation reference", data.presentationId],
      ["Range", data.range],
      ["Item reference", data.id],
    ].flatMap(([label, value]) =>
      typeof value === "string" && value ? [{ label: String(label), value }] : [],
    );
  }
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
