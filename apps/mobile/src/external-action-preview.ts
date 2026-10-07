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
      append: "Add rows",
      import: "Import",
      quickAdd: "Create",
      watch: "Enable alerts",
      unwatch: "Disable alerts",
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
          : (verbs[operation.split(".").at(-1) ?? ""] ?? "Change"),
      ],
      ["Item", data.resourceName],
      ["Subject", data.subject],
      ["To", data.to],
      ["Cc", data.cc],
      ["Bcc", data.bcc],
      ["Calendar", data.calendarId],
      ["Event reference", data.eventId],
      ["File reference", data.fileId],
      ["Starts", calendarReviewTime(data.starts, data.timeZone)],
      ["Ends", calendarReviewTime(data.ends, data.timeZone)],
      ["Time zone", data.timeZone],
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

/** The offset is an instant, not a wall clock. Always name the zone being displayed. */
export function calendarReviewTime(
  value: unknown,
  zone: unknown,
  locale = "pt-BR",
): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat(locale, {
          timeZone: "UTC",
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        }).format(date)
      : value;
  }
  if (!Number.isFinite(Date.parse(value))) return value;
  const timeZone = typeof zone === "string" && zone ? zone : "UTC";
  try {
    return `${new Intl.DateTimeFormat(locale, { timeZone, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value))} · ${timeZone}`;
  } catch {
    return value;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Build links from the exact reviewed/returned resource, never a guessed document title. */
function googleResourceLink(
  service: string,
  data: Record<string, unknown>,
  parameters: Record<string, unknown>,
  result: Record<string, unknown>,
  account: string,
) {
  const reference = (key: string) => text(data[key] ?? parameters[key] ?? result[key]);
  const id =
    service === "docs"
      ? reference("documentId")
      : service === "sheets"
        ? reference("spreadsheetId")
        : service === "slides"
          ? reference("presentationId")
          : service === "drive"
            ? (reference("fileId") ?? text(result.id))
            : undefined;
  let url: URL | undefined;
  if (id && /^[\w-]+$/.test(id)) {
    const paths: Record<string, string> = {
      docs: `https://docs.google.com/document/d/${id}/edit`,
      sheets: `https://docs.google.com/spreadsheets/d/${id}/edit`,
      slides: `https://docs.google.com/presentation/d/${id}/edit`,
      drive: `https://drive.google.com/file/d/${id}/view`,
    };
    url = new URL(paths[service]);
  } else {
    const receiptLink = text(result.webViewLink ?? result.htmlLink ?? result.spreadsheetUrl);
    if (receiptLink) {
      try {
        const candidate = new URL(receiptLink);
        if (
          candidate.protocol === "https:" &&
          !candidate.username &&
          !candidate.password &&
          !candidate.port &&
          [
            "docs.google.com",
            "drive.google.com",
            "calendar.google.com",
            "mail.google.com",
            "www.google.com",
          ].includes(candidate.hostname)
        )
          url = candidate;
      } catch {
        // An invalid provider link stays in technical details; it is never opened.
      }
    }
  }
  if (!url) return undefined;
  if (account) url.searchParams.set("authuser", account);
  return url.toString();
}

export function googleOperationLabel(operation: string, preparing = false) {
  const [service] = operation.split(".");
  const method = operation.split(".").at(-1);
  if (service === "calendar") {
    if (!operation.startsWith("calendar.events.")) {
      if (operation === "calendar.freebusy.query") return "Check availability";
      if (method === "list") return "Find calendars";
      if (method === "get") return "Read calendar settings";
      if (method === "clear") return "Clear calendar";
      return "Edit calendar settings";
    }
    if (method === "delete") return preparing ? "Prepare event removal" : "Remove event";
    if (["insert", "quickAdd"].includes(method ?? "")) return "Create event";
    if (["update", "patch"].includes(method ?? "")) return "Edit event";
    if (method === "list") return "Find calendar events";
    if (method === "get") return "Read calendar event";
  }
  if (service === "gmail") {
    if (operation.includes(".drafts.") && method === "delete") return "Delete email draft";
    if (method === "send") return "Send email";
    if (operation.includes(".drafts.") && ["create", "update"].includes(method ?? ""))
      return "Save email draft";
    if (method === "trash") return "Move email to trash";
    if (["delete", "batchDelete"].includes(method ?? "")) return "Delete email";
    if (["modify", "batchModify"].includes(method ?? "")) return "Change email labels";
    if (method === "list") return "Find emails";
    if (method === "get") return "Read email";
  }
  const noun: Record<string, string> = {
    drive: "file",
    docs: "document",
    sheets: "spreadsheet",
    slides: "presentation",
  };
  if (noun[service]) {
    const verb =
      method === "create"
        ? "Create"
        : method === "delete"
          ? "Delete"
          : method === "get"
            ? "Read"
            : method === "list"
              ? "Find"
              : method === "copy"
                ? "Copy"
                : method === "append"
                  ? "Add rows to"
                  : ["clear", "batchClear"].includes(method ?? "")
                    ? "Clear"
                    : "Edit";
    return `${verb} ${noun[service]}`;
  }
  return "Update connected account";
}

/** Use the public proposal and confirmed receipt, never the private credential binding. */
export function googleActionPresentation(
  action: {
    title: string;
    kind: string;
    status: string;
    data: Record<string, unknown>;
    account?: string;
    result?: unknown;
    target?: unknown;
  },
  locale = "pt-BR",
) {
  const data = action.data;
  const request = record(data.request);
  const body = record(request.body);
  const parameters = record(request.parameters);
  const receipt = record(action.result);
  const result = record(receipt.data ?? receipt.result ?? action.result);
  const mailChange = record(receipt.mailChange);
  const properties = record(result.properties ?? body.properties);
  const operation =
    text(data.operation) ??
    (
      {
        "calendar.delete": "calendar.events.delete",
        "calendar.create": "calendar.events.insert",
        "calendar.update": "calendar.events.update",
        "email.send": "gmail.users.messages.send",
      } as Record<string, string>
    )[action.kind] ??
    "";
  const service = operation.split(".")[0];
  const services: Record<string, string> = {
    gmail: "Gmail",
    calendar: "Calendar",
    drive: "Google Drive",
    docs: "Google Docs",
    sheets: "Google Sheets",
    slides: "Google Slides",
  };
  const deletion =
    data.requiresHumanApproval === true ||
    /\.(delete|batchDelete|trash|emptyTrash|clear|batchClear|remove)$/.test(operation);
  const verb =
    service === "gmail" &&
    ((mailChange.verified === true && Number(mailChange.trashed) > 0) ||
      (Array.isArray(body.addLabelIds) && body.addLabelIds.includes("TRASH")))
      ? "Move email to trash"
      : mailChange.verified === true && Number(mailChange.archived) > 0
        ? "Archive email"
        : googleOperationLabel(operation);
  const item =
    text(data.resourceName) ??
    text(data.subject) ??
    text(result.title) ??
    text(result.name) ??
    text(result.summary) ??
    text(properties.title) ??
    text(body.title) ??
    text(body.name) ??
    text(body.summary) ??
    (action.kind.startsWith("calendar.") ? text(data.title) : undefined) ??
    (data.tool !== "google.workspace" ? text(action.title) : undefined);
  const account = text(data.account) ?? action.account ?? "";
  const target = record(action.target);
  const resourceUrl = googleResourceLink(
    service,
    data,
    parameters,
    { ...target, ...result },
    account,
  );
  const start = record(body.start ?? result.start);
  const end = record(body.end ?? result.end);
  const zone = data.timeZone ?? start.timeZone;
  const fields = [
    {
      label: "Starts",
      value: calendarReviewTime(
        data.starts ?? data.start ?? start.dateTime ?? start.date,
        zone,
        locale,
      ),
    },
    {
      label: "Ends",
      value: calendarReviewTime(data.ends ?? data.end ?? end.dateTime ?? end.date, zone, locale),
    },
    { label: "Location", value: text(data.location ?? body.location ?? result.location) },
    { label: "To", value: Array.isArray(data.to) ? data.to.join(", ") : text(data.to) },
    { label: "Cc", value: Array.isArray(data.cc) ? data.cc.join(", ") : text(data.cc) },
    { label: "Range", value: text(data.range ?? parameters.range) },
    { label: "Subject", value: service === "gmail" ? text(data.subject) : undefined },
    {
      label: "Messages",
      value: mailChange.verified === true ? String(mailChange.processed) : text(data.messageCount),
    },
    {
      label: "Labels",
      value: Array.isArray(mailChange.labelNames)
        ? mailChange.labelNames.join(", ")
        : text(data.labels),
    },
    {
      label: "Destination",
      value:
        Number(mailChange.archived) > 0
          ? locale === "pt-BR"
            ? "Arquivados · Todos os e-mails"
            : "Archived · All Mail"
          : text(data.destination),
    },
  ].flatMap((f) => (f.value ? [{ label: f.label, value: f.value }] : []));
  const requests = Array.isArray(body.requests) ? body.requests : [];
  const inserted = requests
    .flatMap((r) => {
      const v = text(record(record(r).insertText).text);
      return v ? [v] : [];
    })
    .join("\n");
  const preview =
    text(inserted) ??
    text(data.body) ??
    text(body.description) ??
    (Array.isArray(body.values)
      ? body.values
          .slice(0, 3)
          .map((row) => (Array.isArray(row) ? row.join(" · ") : ""))
          .filter(Boolean)
          .join("\n")
      : undefined);
  const changes: { label: string; value?: string }[] = [];
  if (inserted) changes.push({ label: "Text added", value: inserted });
  if (mailChange.verified === true && Array.isArray(mailChange.messages))
    for (const message of mailChange.messages.slice(0, 12)) {
      const entry = record(message);
      changes.push({
        label: "Email",
        value: [text(entry.subject) ?? text(entry.id), text(entry.from)]
          .filter(Boolean)
          .join(" · "),
      });
    }
  for (const request of requests) {
    const entry = record(request);
    const replace = record(entry.replaceAllText);
    if (text(record(replace.containsText).text) || text(replace.text ?? replace.replaceText))
      changes.push({
        label: "Text replaced",
        value: `${text(record(replace.containsText).text) ?? ""} → ${text(replace.text ?? replace.replaceText) ?? ""}`,
      });
    if (entry.deleteContentRange) changes.push({ label: "Text removed" });
    if (entry.createSlide) changes.push({ label: "Slide added" });
    if (entry.deleteObject) changes.push({ label: "Element removed" });
    if (entry.updateTextStyle || entry.updateParagraphStyle || entry.updateDocumentStyle)
      changes.push({ label: "Formatting updated" });
  }
  if (Array.isArray(body.values)) changes.push({ label: "Values written", value: preview });
  for (const entry of Array.isArray(body.data) ? body.data : []) {
    const values = record(entry);
    if (Array.isArray(values.values))
      changes.push({
        label: "Values written",
        value: [
          text(values.range),
          ...values.values.slice(0, 3).map((row) => (Array.isArray(row) ? row.join(" · ") : "")),
        ]
          .filter(Boolean)
          .join("\n"),
      });
  }
  if (text(body.name)) changes.push({ label: "File name", value: text(body.name) });
  const method = operation.split(".").at(-1);
  const confirmedOutcomes: Record<string, string> = {
    docs:
      method === "create"
        ? "Document created in Google Drive."
        : inserted
          ? "Text added to the document."
          : changes.some((change) => change.label === "Text replaced")
            ? "Text replaced in the document."
            : "Document updated in Google Docs.",
    sheets:
      method === "create"
        ? "Spreadsheet created in Google Drive."
        : "Spreadsheet values or formatting updated.",
    slides:
      method === "create"
        ? "Presentation created in Google Drive."
        : "Presentation updated in Google Slides.",
    drive: method === "create" ? "File saved in Google Drive." : "File updated in Google Drive.",
    calendar:
      method === "insert" || method === "quickAdd"
        ? "Event created in this account's calendar."
        : "Event updated in this account's calendar.",
    gmail:
      method === "send"
        ? "Email sent to the recipients shown below."
        : operation.includes(".drafts.")
          ? "Draft saved in this account's Gmail."
          : "Email updated in this account's Gmail.",
  };
  const outcomes: Record<string, string> = {
    denied: deletion
      ? "Deletion was declined. This item was not removed."
      : "You declined this action. It was not executed.",
    cancelled: "This action was cancelled.",
    expired: "This approval expired. A new review is required before making changes.",
    succeeded:
      mailChange.verified === true
        ? locale === "pt-BR"
          ? `${mailChange.processed} e-mails conferidos no Gmail.${Number(mailChange.archived) > 0 ? ` ${mailChange.archived} arquivados.` : ""}${Number(mailChange.trashed) > 0 ? ` ${mailChange.trashed} enviados à lixeira.` : ""}${Number(mailChange.deleted) > 0 ? ` ${mailChange.deleted} excluídos.` : ""}`
          : `${mailChange.processed} emails verified in Gmail; ${mailChange.archived ?? 0} archived, ${mailChange.trashed ?? 0} trashed.`
        : deletion
          ? "Removal confirmed."
          : (confirmedOutcomes[service] ?? "Change completed."),
    failed: "This action could not be completed. See the error below.",
    outcome_unknown: "The result has not been confirmed. Do not repeat this action yet.",
    executing: "The approved action is being executed.",
    awaiting_review: deletion
      ? "Review the item and account. Nothing is removed until you approve."
      : "Review the details before approving this change.",
  };
  return {
    verb,
    item,
    account,
    service: services[service] ?? "Connected account",
    fields,
    preview: preview?.slice(0, 1600),
    changes: [
      ...new Map(
        changes.map((change) => {
          const projected = { ...change, value: change.value?.slice(0, 1600) };
          return [`${projected.label}:${projected.value ?? ""}`, projected];
        }),
      ).values(),
    ].slice(0, 20),
    resourceUrl,
    openLabel:
      (
        {
          docs: "Open document",
          sheets: "Open spreadsheet",
          slides: "Open presentation",
          drive: "Open file",
          calendar: "Open event",
          gmail: "Open email",
        } as Record<string, string>
      )[service] ?? "Open item",
    storage: ["docs", "sheets", "slides", "drive"].includes(service)
      ? "Google Drive"
      : (services[service] ?? "Connected account"),
    deletion,
    outcome: outcomes[action.status] ?? "",
  };
}

/** Reuse a known resource name only for the same account and exact resource ID. */
export function withGoogleActionContext<
  A extends {
    title: string;
    kind: string;
    status: string;
    data: Record<string, unknown>;
    account?: string;
    result?: unknown;
  },
>(
  action: A,
  actions: readonly {
    title: string;
    kind: string;
    status: string;
    data: Record<string, unknown>;
    account?: string;
    result?: unknown;
  }[],
): A {
  if (googleActionPresentation(action).item) return action;
  const account = text(action.data.account) ?? action.account;
  const resourceIds = (entry: { data: Record<string, unknown>; result?: unknown }) => {
    const request = record(entry.data.request);
    const params = record(request.parameters);
    const receipt = record(entry.result);
    const result = record(receipt.data ?? receipt.result ?? entry.result);
    return ["fileId", "documentId", "spreadsheetId", "presentationId", "eventId"]
      .flatMap((key) => {
        const value = text(entry.data[key] ?? params[key] ?? result[key]);
        return value ? [value] : [];
      })
      .concat(text(result.id) ? [String(result.id)] : []);
  };
  const ids = new Set(resourceIds(action));
  if (!account || !ids.size) return action;
  for (const candidate of actions) {
    if (
      (text(candidate.data.account) ?? candidate.account) !== account ||
      !resourceIds(candidate).some((id) => ids.has(id))
    )
      continue;
    const item = googleActionPresentation(candidate).item;
    if (item) return { ...action, data: { ...action.data, resourceName: item } };
  }
  return action;
}
