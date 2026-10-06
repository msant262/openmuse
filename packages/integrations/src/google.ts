import { randomUUID } from "node:crypto";
import { type DefaultTreeAdapterMap, parseFragment } from "parse5";
import { z } from "zod";
import {
  type CalendarEvent,
  type EmailDraft,
  type EventDraft,
  emailDraftSchema,
  eventDraftSchema,
  type Mail,
} from "../../domain/src/index.ts";
import {
  addCalendarCivilDays,
  assertCalendarRange,
  CALENDAR_DAY_MS,
  calendarCivilDayStart,
  calendarDefaultWindow,
  calendarQueryBound,
  isCalendarCivilDate,
  isCalendarTimeZone,
  calendarTimeZone as normalizedCalendarTimeZone,
  parseCalendarInstant,
} from "./google-calendar-dates.ts";
import {
  decodeMailSnippet,
  decodeMimeHeader,
  decodeMimeText,
  parseAddressList,
  unfoldHeaderValue,
} from "./google-parser.ts";
import type { PreparedGoogleRequest } from "./google-workspace-catalog.ts";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR = "https://www.googleapis.com/calendar/v3";
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_JSON_BYTES = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 1024 * 1024;

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export class OutcomeUnknownError extends Error {
  readonly code = "outcome_unknown";
  constructor(
    message = "Google may have completed this action. Check Google before trying again.",
  ) {
    super(message);
    this.name = "OutcomeUnknownError";
  }
}

export class GoogleApiError extends Error {
  readonly code: string;
  constructor(
    readonly status: number,
    detail: string,
    code?: string,
  ) {
    super(`Google API (${status}): ${detail}`);
    this.name = "GoogleApiError";
    this.code =
      code ??
      (status === 401
        ? "GOOGLE_RECONNECT_REQUIRED"
        : status === 403
          ? "GOOGLE_PERMISSION_DENIED"
          : status === 429
            ? "GOOGLE_RATE_LIMITED"
            : "GOOGLE_UNAVAILABLE");
  }
}

export class RecurringEventError extends Error {
  readonly status = 422;
  constructor() {
    super(
      "Recurring events cannot be changed here yet. Open Google Calendar to choose one occurrence or the whole series.",
    );
    this.name = "RecurringEventError";
  }
}

export class CalendarTimeZoneUnknownError extends Error {
  readonly code = "GOOGLE_TIMEZONE_UNKNOWN";
  constructor() {
    super("Google did not provide a valid time zone for this all-day event");
    this.name = "CalendarTimeZoneUnknownError";
  }
}

export interface CalendarListEntry {
  id: string;
  name: string;
  timeZone: string;
  accessRole: string;
}
export interface ListEventsOptions {
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  /** IANA zone used to resolve date-only boundaries and the default window. */
  timeZone?: string;
}
export interface CalendarEventsRead {
  events: CalendarEvent[];
  metadata: {
    timeMin: string;
    timeMax: string;
    timeMaxExclusive: true;
    timeZone: string;
    timeZoneSource: "explicit" | "host-default";
    maxResults: 100;
    returnedCount: number;
    truncated: boolean;
    unknownTimeZoneEventIds: string[];
  };
}
type EventTimeZoneSource = "event" | "calendar" | "query" | "unknown";
const MAX_CALENDAR_EVENTS = 100;

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}
const partSchema: z.ZodType<GmailPart> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    body: z
      .object({
        data: z.string().optional(),
        size: z.number().nonnegative().optional(),
        attachmentId: z.string().optional(),
      })
      .optional(),
    parts: z.array(partSchema).optional(),
  }),
);
const messageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  snippet: z.string().default(""),
  internalDate: z.string().optional(),
  labelIds: z.array(z.string()).default([]),
  payload: partSchema.optional(),
});
const googleEventSchema = z.object({
  id: z.string().min(1),
  etag: z.string().optional(),
  recurrence: z.array(z.string()).optional(),
  recurringEventId: z.string().optional(),
  summary: z.string().default("(Untitled event)"),
  start: z.object({
    date: z.string().optional(),
    dateTime: z.string().optional(),
    timeZone: z.string().optional(),
  }),
  end: z.object({ date: z.string().optional(), dateTime: z.string().optional() }),
  location: z.string().default(""),
  description: z.string().default(""),
  attendees: z.array(z.object({ email: z.string() })).default([]),
});
export interface MailAttachment {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

function idPath(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid Google resource ID");
  return encodeURIComponent(id);
}
function calendarPath(calendarId: string): string {
  if (
    !calendarId ||
    calendarId.length > 1024 ||
    Array.from(calendarId).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) ||
    calendarId === "." ||
    calendarId === ".."
  )
    throw new Error("Invalid Google calendar ID");
  return `${CALENDAR}/calendars/${encodeURIComponent(calendarId)}/events`;
}
function singleLine(value: string, field: string): string {
  if (Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    throw new Error(`Invalid ${field}: header control characters are not allowed`);
  return value;
}
function decodeBase64url(encoded: string, limit = MAX_ATTACHMENT_BYTES): Buffer {
  if (encoded.length > Math.ceil((limit * 4) / 3) + 4)
    throw new Error("Attachment or message body exceeds the size limit");
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(encoded))
    throw new Error("Invalid base64url attachment or message body");
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length > limit) throw new Error("Attachment or message body is too large");
  if (bytes.toString("base64url") !== encoded.replace(/=+$/, ""))
    throw new Error("Invalid base64url attachment or message body");
  return bytes;
}
function headers(part?: GmailPart): Map<string, string> {
  return new Map(
    (part?.headers ?? []).map(({ name, value }) => [name.toLowerCase(), unfoldHeaderValue(value)]),
  );
}
/** Extract text from a parsed HTML tree. Nothing is rendered or fetched. */
function htmlToPlainText(html: string): string {
  const root = parseFragment(html);
  const excluded = new Set([
    "script",
    "style",
    "head",
    "template",
    "noscript",
    "iframe",
    "object",
    "svg",
    "math",
  ]);
  const blocks = new Set([
    "address",
    "article",
    "aside",
    "blockquote",
    "div",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "li",
    "main",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "tr",
    "ul",
  ]);
  const stack: (DefaultTreeAdapterMap["node"] | string)[] = [root];
  const text: string[] = [];
  while (stack.length) {
    const node = stack.pop();
    if (node === undefined) break;
    if (typeof node === "string") {
      text.push(node);
      continue;
    }
    if ("value" in node) {
      text.push(node.value);
      continue;
    }
    if ("tagName" in node) {
      if (excluded.has(node.tagName)) continue;
      if (node.tagName === "br") {
        text.push("\n");
        continue;
      }
      if (blocks.has(node.tagName)) {
        text.push("\n");
        stack.push("\n");
      }
      if (node.tagName === "td" || node.tagName === "th") stack.push("\t");
    }
    if ("childNodes" in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index--)
        stack.push(node.childNodes[index]);
    }
  }
  return text
    .join("")
    .replace(/[\t \u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function mapMessage(message: z.infer<typeof messageSchema>): Mail {
  const metadata = headers(message.payload);
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: string[] = [];
  const visit = (part: GmailPart, depth: number) => {
    if (depth > 30) throw new Error("Gmail message MIME nesting exceeds the limit");
    if (part.mimeType?.toLowerCase() === "message/rfc822") {
      if (part.body?.attachmentId) {
        attachments.push(
          `${message.id}:${part.body.attachmentId}:${encodeURIComponent(part.filename || "Attached message.eml")}`,
        );
      }
      return;
    }
    if (part.filename && part.body?.attachmentId)
      attachments.push(
        `${message.id}:${part.body.attachmentId}:${encodeURIComponent(part.filename)}`,
      );
    if (
      !part.filename &&
      (part.mimeType === "text/plain" || part.mimeType === "text/html") &&
      part.body?.data
    ) {
      const charset =
        headers(part)
          .get("content-type")
          ?.match(/charset=["']?([^;"'\s]+)/i)?.[1] ?? "utf-8";
      const text = decodeMimeText(decodeBase64url(part.body.data, 1024 * 1024), charset);
      if (part.mimeType === "text/plain") plain.push(text);
      else html.push(htmlToPlainText(text));
    }
    for (const child of part.parts ?? []) visit(child, depth + 1);
  };
  if (message.payload) visit(message.payload, 0);
  const from = parseAddressList(metadata.get("from") ?? "")[0];
  const address = from?.email ?? metadata.get("from") ?? "";
  const sender = from?.name ?? address;
  const time = message.internalDate
    ? Number(message.internalDate)
    : Date.parse(metadata.get("date") ?? "");
  const body = plain.length
    ? plain.join("\n\n")
    : html.length
      ? html.join("\n\n")
      : decodeMailSnippet(message.snippet);
  if (body.length > 1024 * 1024) throw new Error("Gmail message text exceeds the 1 MiB limit");
  return {
    id: message.id,
    threadId: message.threadId,
    from: address,
    sender,
    to: parseAddressList(metadata.get("to") ?? "").map(({ email }) => email),
    subject: decodeMimeHeader(metadata.get("subject") ?? "(No subject)"),
    body,
    date: Number.isFinite(time) ? new Date(time).toISOString() : "",
    unread: message.labelIds.includes("UNREAD"),
    label: message.labelIds.includes("INBOX")
      ? "Inbox"
      : message.labelIds.includes("SENT")
        ? "Sent"
        : "Mail",
    attachments,
  };
}
function mapEventWithMetadata(
  value: unknown,
  calendarId: string,
  providerTimeZone?: string,
  queryTimeZone?: string,
): { event: CalendarEvent; timeZoneSource: EventTimeZoneSource } {
  const event = googleEventSchema.parse(value);
  const hasDate = Boolean(event.start.date || event.end.date);
  const allDay = hasDate;
  if (
    (allDay &&
      (!event.start.date || !event.end.date || event.start.dateTime || event.end.dateTime)) ||
    (!allDay &&
      (!event.start.dateTime || !event.end.dateTime || event.start.date || event.end.date))
  )
    throw new Error("Google event must have matching date-only or date-time boundaries");
  const start = allDay ? event.start.date : event.start.dateTime;
  const end = allDay ? event.end.date : event.end.dateTime;
  if (!start || !end) throw new Error("Invalid Google event time range");
  assertCalendarRange(start, end, allDay);
  const eventTimeZone = isCalendarTimeZone(event.start.timeZone) ? event.start.timeZone : undefined;
  const calendarTimeZone = isCalendarTimeZone(providerTimeZone) ? providerTimeZone : undefined;
  const requestedTimeZone = isCalendarTimeZone(queryTimeZone) ? queryTimeZone : undefined;
  const timeZone = eventTimeZone ?? calendarTimeZone ?? requestedTimeZone;
  if (allDay && !timeZone) throw new CalendarTimeZoneUnknownError();
  return {
    event: {
      id: event.id,
      calendarId,
      title: event.summary,
      start,
      end,
      allDay,
      timeZone: timeZone ?? normalizedCalendarTimeZone(),
      location: event.location,
      description: event.description,
      attendees: event.attendees.map((attendee) => attendee.email),
    },
    timeZoneSource: eventTimeZone
      ? "event"
      : calendarTimeZone
        ? "calendar"
        : requestedTimeZone
          ? "query"
          : "unknown",
  };
}
function mapEvent(
  value: unknown,
  calendarId: string,
  providerTimeZone?: string,
  queryTimeZone?: string,
): CalendarEvent {
  return mapEventWithMetadata(value, calendarId, providerTimeZone, queryTimeZone).event;
}
function eventBody(draft: EventDraft, patch = false) {
  return {
    summary: draft.title,
    start: draft.allDay
      ? { date: draft.start, ...(patch ? { dateTime: null } : {}) }
      : { dateTime: draft.start, timeZone: draft.timeZone, ...(patch ? { date: null } : {}) },
    end: draft.allDay
      ? { date: draft.end, ...(patch ? { dateTime: null } : {}) }
      : { dateTime: draft.end, timeZone: draft.timeZone, ...(patch ? { date: null } : {}) },
    location: draft.location,
    description: draft.description,
    attendees: draft.attendees.map((email) => ({ email })),
  };
}
function encodedSubject(subject: string): string {
  const chunks: string[] = [];
  let chunk = "";
  for (const char of subject) {
    if (Buffer.byteLength(chunk + char) > 42) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((part) => `=?UTF-8?B?${Buffer.from(part).toString("base64")}?=`).join("\r\n ");
}
function wrapBase64(bytes: Uint8Array): string {
  return (
    Buffer.from(bytes)
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join("\r\n") ?? ""
  );
}
function validateAttachments(attachments: MailAttachment[]): void {
  if (attachments.length > 10) throw new Error("Attachment count exceeds the limit of 10");
  let total = 0;
  for (const attachment of attachments) {
    singleLine(attachment.name, "attachment name");
    if (!attachment.name || Buffer.byteLength(attachment.name) > 180)
      throw new Error("Invalid attachment name length");
    if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(attachment.mimeType))
      throw new Error("Invalid attachment MIME type");
    if (attachment.bytes.length > MAX_ATTACHMENT_BYTES)
      throw new Error("Attachment is too large (10 MiB limit)");
    total += attachment.bytes.length;
  }
  if (total > MAX_TOTAL_ATTACHMENT_BYTES)
    throw new Error("Total attachment size exceeds the 20 MiB limit");
}

async function readJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_JSON_BYTES) {
    await response.body?.cancel();
    throw new Error("Google response exceeds the size limit");
  }
  if (!response.body) throw new Error("Google returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new Error("Google response exceeds the size limit");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
}

export class GoogleClient {
  private readonly fetcher: typeof fetch;
  private readonly getAccessToken: () => Promise<string>;
  private readDeadline?: number;
  constructor(
    private readonly options: {
      getAccessToken: () => Promise<string>;
      fetch?: typeof fetch;
      signal?: AbortSignal;
      beforeWrite?: () => Promise<void>;
      retry?: {
        budgetMs?: number;
        maxAttempts?: number;
        now?: () => number;
        random?: () => number;
        sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
      };
    },
  ) {
    this.fetcher = options.fetch ?? fetch;
    this.getAccessToken = options.getAccessToken;
  }

  private async mapMessage(message: z.infer<typeof messageSchema>): Promise<Mail> {
    const hydrate = async (part: GmailPart, depth: number): Promise<void> => {
      if (depth > 30) throw new Error("Gmail message MIME nesting exceeds the limit");
      if (
        !part.filename &&
        part.mimeType?.toLowerCase() !== "message/rfc822" &&
        (part.mimeType === "text/plain" || part.mimeType === "text/html") &&
        part.body?.data === undefined &&
        part.body?.attachmentId
      ) {
        if ((part.body.size ?? 0) > 1024 * 1024)
          throw new Error("Gmail message text exceeds the 1 MiB limit");
        const bytes = await this.getAttachment(message.id, part.body.attachmentId);
        if (bytes.length > 1024 * 1024)
          throw new Error("Gmail message text exceeds the 1 MiB limit");
        part.body.data = Buffer.from(bytes).toString("base64url");
      }
      if (part.mimeType?.toLowerCase() !== "message/rfc822")
        for (const child of part.parts ?? []) await hydrate(child, depth + 1);
    };
    if (message.payload) await hydrate(message.payload, 0);
    return mapMessage(message);
  }

  async getThread(threadId: string): Promise<Mail[]> {
    const thread = z
      .object({ id: z.string(), messages: z.array(messageSchema).default([]) })
      .parse(await this.request(`${GMAIL}/threads/${idPath(threadId)}?format=full`));
    if (thread.id !== threadId || thread.messages.some((message) => message.threadId !== threadId))
      throw new Error("Google returned messages from a different thread");
    return Promise.all(thread.messages.map((message) => this.mapMessage(message)));
  }

  async getThreadWithMetadata(threadId: string) {
    const thread = z
      .object({ id: z.string(), messages: z.array(messageSchema).default([]) })
      .parse(await this.request(`${GMAIL}/threads/${idPath(threadId)}?format=full`));
    if (thread.id !== threadId || thread.messages.some((message) => message.threadId !== threadId))
      throw new Error("Google returned messages from a different thread");
    // An oversized thread is explicitly partial; it cannot prove an unanswered request.
    return {
      messages: await Promise.all(
        thread.messages.slice(-100).map(async (message) => ({
          ...(await this.mapMessage(message)),
          systemLabels: message.labelIds,
        })),
      ),
      complete: thread.messages.length <= 100,
    };
  }

  async listCalendars(): Promise<CalendarListEntry[]> {
    const entries: CalendarListEntry[] = [];
    const tokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ maxResults: "250" });
      if (pageToken) params.set("pageToken", pageToken);
      const result = z
        .object({
          items: z
            .array(
              z.object({
                id: z.string().min(1),
                summary: z.string().default("(Untitled calendar)"),
                summaryOverride: z.string().optional(),
                timeZone: z.string(),
                accessRole: z.string(),
              }),
            )
            .default([]),
          nextPageToken: z.string().min(1).optional(),
        })
        .parse(await this.request(`${CALENDAR}/users/me/calendarList?${params}`));
      entries.push(
        ...result.items.map((calendar) => ({
          id: calendar.id,
          name: calendar.summaryOverride ?? calendar.summary,
          timeZone: calendar.timeZone,
          accessRole: calendar.accessRole,
        })),
      );
      pageToken = result.nextPageToken;
      if (pageToken) {
        if (tokens.has(pageToken) || tokens.size >= 10)
          throw new Error("Google calendar list exceeded the pagination limit");
        tokens.add(pageToken);
      }
    } while (pageToken);
    return entries;
  }

  private async readSingleEvent(
    calendarId: string,
    eventId: string,
  ): Promise<z.infer<typeof googleEventSchema>> {
    const event = googleEventSchema.parse(
      await this.request(`${calendarPath(calendarId)}/${idPath(eventId)}`),
    );
    if (event.id !== eventId) throw new Error("Google returned a different event");
    if (event.recurrence !== undefined || event.recurringEventId !== undefined)
      throw new RecurringEventError();
    return event;
  }

  async validateSingleEvent(calendarId: string, eventId: string): Promise<void> {
    await this.readSingleEvent(calendarId, eventId);
  }

  async reviewEvent(
    calendarId: string,
    eventId: string,
  ): Promise<{ event: CalendarEvent; version: string }> {
    const current = await this.readSingleEvent(calendarId, eventId);
    const version = this.eventVersion(current);
    const timeZone =
      (isCalendarTimeZone(current.start.timeZone) ? current.start.timeZone : undefined) ??
      z
        .object({ timeZone: z.string().min(1) })
        .parse(
          await this.request(`${CALENDAR}/users/me/calendarList/${encodeURIComponent(calendarId)}`),
        ).timeZone;
    return { event: mapEvent(current, calendarId, timeZone), version };
  }

  private eventVersion(event: z.infer<typeof googleEventSchema>, expectedVersion?: string): string {
    if (!event.etag?.trim()) throw new Error("Google event has no ETag; prepare a fresh review");
    const version = singleLine(event.etag, "event ETag");
    if (expectedVersion !== undefined && version !== expectedVersion)
      throw new GoogleApiError(409, "This event changed since review. Prepare a new action.");
    return version;
  }

  private async request(
    url: string,
    method = "GET",
    body?: unknown,
    conditionalHeaders: Record<string, string> = {},
    transport?: {
      rawBody?: Uint8Array;
      contentType?: string;
      download?: boolean;
      readOnly?: boolean;
    },
  ): Promise<unknown> {
    const write = method !== "GET" && !transport?.readOnly;
    const now = this.options.retry?.now ?? Date.now;
    const budgetMs = Math.min(60_000, Math.max(1, this.options.retry?.budgetMs ?? 10_000));
    if (!write && this.readDeadline === undefined) this.readDeadline = now() + budgetMs;
    const deadline = write ? now() + 30_000 : (this.readDeadline ?? now() + budgetMs);
    const signal = AbortSignal.any([
      AbortSignal.timeout(Math.max(1, Math.ceil(deadline - now()))),
      ...(this.options.signal ? [this.options.signal] : []),
    ]);
    signal.throwIfAborted();
    // Credential failures happen before dispatch, so their outcome is definite.
    const token = await abortable(this.getAccessToken(), signal);
    if (!token || /[\r\n]/.test(token))
      throw new Error("Google access token is missing or invalid; reconnect Google");
    const attempts = write ? 1 : Math.min(5, Math.max(1, this.options.retry?.maxAttempts ?? 3));
    for (let attempt = 0; attempt < attempts; attempt++) {
      signal.throwIfAborted();
      if (now() >= deadline) throw new Error("Google read retry budget exhausted");
      let response: Response;
      // Refresh/review reads may await network I/O. Authorize the concrete
      // mutable request only after those waits and outside unknown-outcome
      // handling, so a denied barrier remains definitely not dispatched.
      if (write) await this.options.beforeWrite?.();
      try {
        response = await abortable(
          this.fetcher(url, {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
              ...(transport?.contentType
                ? { "Content-Type": transport.contentType }
                : body === undefined
                  ? {}
                  : { "Content-Type": "application/json" }),
              ...conditionalHeaders,
            },
            body: transport?.rawBody
              ? Buffer.from(transport.rawBody)
              : body === undefined
                ? undefined
                : JSON.stringify(body),
            signal,
            redirect: "error",
          }),
          signal,
        );
      } catch {
        if (write) throw new OutcomeUnknownError();
        signal.throwIfAborted();
        if (attempt + 1 >= attempts)
          throw new Error("Could not reach Google; check the connection and try again");
        await this.backoff(attempt, undefined, deadline, signal);
        continue;
      }
      if (write && (response.status >= 500 || response.status === 408)) {
        try {
          await response.body?.cancel();
        } catch {
          throw new OutcomeUnknownError();
        }
        throw new OutcomeUnknownError();
      }
      if (!response.ok) {
        let detail = response.statusText || "Request failed";
        let rateLimited = response.status === 429;
        try {
          const result = z
            .object({
              error: z.object({
                message: z.string(),
                errors: z.array(z.object({ reason: z.string().optional() })).optional(),
              }),
            })
            .safeParse(await abortable(readJson(response), signal));
          if (result.success) {
            detail = result.data.error.message.slice(0, 500);
            rateLimited ||=
              response.status === 403 &&
              (result.data.error.errors ?? []).some(({ reason }) =>
                ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"].includes(
                  reason ?? "",
                ),
              );
          }
        } catch {
          /* Preserve the definite HTTP rejection even if its body is not JSON. */
        }
        signal.throwIfAborted();
        if (
          !write &&
          attempt + 1 < attempts &&
          (rateLimited || response.status >= 500 || response.status === 408)
        ) {
          await this.backoff(
            attempt,
            response.headers.get("Retry-After") ?? undefined,
            deadline,
            signal,
          );
          continue;
        }
        throw new GoogleApiError(
          response.status,
          detail,
          rateLimited ? "GOOGLE_RATE_LIMITED" : undefined,
        );
      }
      if (response.status === 204) return { confirmed: true };
      try {
        if (transport?.download) {
          const reader = response.body?.getReader();
          if (!reader) throw new Error("Google returned an empty download");
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (true) {
              const item = await abortable(reader.read(), signal);
              if (item.done) break;
              size += item.value.byteLength;
              if (size > 16 * 1024 * 1024) throw new Error("Google download exceeds 16 MiB");
              chunks.push(item.value);
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
          return {
            bytes: Buffer.concat(chunks),
            mimeType:
              response.headers.get("Content-Type")?.split(";")[0] ?? "application/octet-stream",
          };
        }
        return await abortable(readJson(response), signal);
      } catch {
        if (write) throw new OutcomeUnknownError();
        signal.throwIfAborted();
        throw new Error("Google returned an invalid or oversized response");
      }
    }
    throw new Error("Google read retry budget exhausted");
  }

  /** Only the pinned Workspace catalog builds this request; tokens remain inside this client. */
  async workspaceRequest(request: PreparedGoogleRequest): Promise<unknown> {
    const url = new URL(request.url);
    if (
      !new Set([
        "www.googleapis.com",
        "gmail.googleapis.com",
        "docs.googleapis.com",
        "sheets.googleapis.com",
        "slides.googleapis.com",
      ]).has(url.hostname) ||
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password
    )
      throw new Error("Invalid Google API destination");
    const result = await this.request(request.url, request.method, request.body, {}, request);
    if (
      !request.readOnly &&
      request.receiptField &&
      (!result ||
        typeof result !== "object" ||
        typeof (result as Record<string, unknown>)[request.receiptField] !== "string" ||
        !(result as Record<string, unknown>)[request.receiptField])
    )
      throw new OutcomeUnknownError(
        "Google returned no resource identifier; check the action before repeating it.",
      );
    return result;
  }

  private async backoff(
    attempt: number,
    retryAfter: string | undefined,
    deadline: number,
    signal: AbortSignal,
  ) {
    const now = this.options.retry?.now ?? Date.now;
    const jitter = 250 * 2 ** attempt * (0.5 + (this.options.retry?.random ?? Math.random)());
    const requested =
      retryAfter === undefined
        ? 0
        : /^\d+(?:\.\d+)?$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Math.max(0, Date.parse(retryAfter) - now());
    const delay = Math.max(jitter, Number.isFinite(requested) ? requested : 0);
    if (delay >= deadline - now()) throw new Error("Google read retry budget exhausted");
    await (this.options.retry?.sleep ?? waitForRetry)(delay, signal);
    signal.throwIfAborted();
  }

  /** The latest 30 matching messages. Permission/read failures propagate visibly. */
  async listMail(query = "in:inbox"): Promise<Mail[]> {
    return (await this.listMailWithMetadata(query)).messages;
  }

  /** Cheap mailbox change token: no message bodies are downloaded by the heartbeat poll. */
  async mailHistoryId() {
    return z.object({ historyId: z.string().min(1) }).parse(await this.request(`${GMAIL}/profile`))
      .historyId;
  }
  async listMailWithMetadata(query = "in:inbox") {
    const params = new URLSearchParams({ maxResults: "30", q: query });
    const list = z
      .object({
        messages: z.array(z.object({ id: z.string() })).default([]),
        nextPageToken: z.string().optional(),
      })
      .parse(await this.request(`${GMAIL}/messages?${params}`));
    const messages = await Promise.all(
      list.messages
        .slice(0, 30)
        .map(async ({ id }) =>
          this.mapMessage(
            messageSchema.parse(await this.request(`${GMAIL}/messages/${idPath(id)}?format=full`)),
          ),
        ),
    );
    return { messages, complete: !list.nextPageToken && list.messages.length <= 30 };
  }

  /** At most 100 occurrences in a bounded window, beginning at the local civil day by default. */
  async listEvents(options: ListEventsOptions = {}): Promise<CalendarEvent[]> {
    return (await this.listEventsWithMetadata(options)).events;
  }

  /** One bounded page plus coverage and timezone provenance for model-facing tools. */
  async listEventsWithMetadata(options: ListEventsOptions = {}): Promise<CalendarEventsRead> {
    const calendarId = options.calendarId ?? "primary";
    const path = calendarPath(calendarId);
    const hasCivilBoundary =
      (options.timeMin !== undefined && isCalendarCivilDate(options.timeMin)) ||
      (options.timeMax !== undefined && isCalendarCivilDate(options.timeMax));
    if (hasCivilBoundary && !options.timeZone)
      throw new Error("Calendar civil-date bounds require an explicit IANA timeZone");
    const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const timeZone = options.timeZone ?? localZone;
    if (!isCalendarTimeZone(timeZone)) throw new Error("Invalid calendar time zone");
    const [defaultMin, defaultMax] = calendarDefaultWindow(timeZone);
    const timeMin =
      options.timeMin !== undefined
        ? calendarQueryBound(options.timeMin, timeZone, "calendar timeMin")
        : defaultMin;
    const timeMax =
      options.timeMax !== undefined
        ? calendarQueryBound(options.timeMax, timeZone, "calendar timeMax")
        : options.timeMin !== undefined && isCalendarCivilDate(options.timeMin)
          ? calendarCivilDayStart(addCalendarCivilDays(options.timeMin, 31), timeZone)
          : options.timeMin !== undefined
            ? new Date(parseCalendarInstant(timeMin) + 31 * CALENDAR_DAY_MS).toISOString()
            : defaultMax;
    const duration = parseCalendarInstant(timeMax) - parseCalendarInstant(timeMin);
    if (duration <= 0 || duration > 366 * 24 * 60 * 60 * 1000)
      throw new Error("Calendar range must end after it starts and span at most 366 days");
    const params = new URLSearchParams({
      maxResults: String(MAX_CALENDAR_EVENTS),
      singleEvents: "true",
      orderBy: "startTime",
      timeMin,
      timeMax,
    });
    const result = z
      .object({
        items: z.array(z.unknown()).default([]),
        timeZone: z.string().optional(),
        nextPageToken: z.string().min(1).optional(),
      })
      .parse(await this.request(`${path}?${params}`));
    const mapped = result.items
      .slice(0, MAX_CALENDAR_EVENTS)
      .map((item) => mapEventWithMetadata(item, calendarId, result.timeZone, options.timeZone));
    const events = mapped.map(({ event }) => event);
    return {
      events,
      metadata: {
        timeMin,
        timeMax,
        timeMaxExclusive: true,
        timeZone,
        timeZoneSource: options.timeZone ? "explicit" : "host-default",
        maxResults: MAX_CALENDAR_EVENTS,
        returnedCount: events.length,
        truncated: result.items.length > MAX_CALENDAR_EVENTS || result.nextPageToken !== undefined,
        unknownTimeZoneEventIds: mapped
          .filter(({ timeZoneSource }) => timeZoneSource === "unknown")
          .map(({ event }) => event.id),
      },
    };
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<Uint8Array> {
    const data = z
      .object({ data: z.string(), size: z.number().int().nonnegative().optional() })
      .parse(
        await this.request(
          `${GMAIL}/messages/${idPath(messageId)}/attachments/${idPath(attachmentId)}`,
        ),
      );
    if (data.size !== undefined && data.size > MAX_ATTACHMENT_BYTES)
      throw new Error("Attachment is too large (10 MiB limit)");
    const bytes = decodeBase64url(data.data);
    if (data.size !== undefined && data.size !== bytes.length)
      throw new Error("Google attachment size does not match its actual byte length");
    return new Uint8Array(bytes);
  }

  async prepareEmailMessage(
    input: EmailDraft,
    attachments: MailAttachment[],
  ): Promise<{ raw: string; threadId?: string }> {
    const draft = emailDraftSchema.parse(input);
    singleLine(draft.subject, "subject");
    for (const address of [...draft.to, ...draft.cc, ...draft.bcc])
      singleLine(address, "recipient");
    validateAttachments(attachments);
    if (draft.threadId && !draft.replyToMessageId)
      throw new Error("Replies require replyToMessageId to resolve the source message headers");
    let threadId: string | undefined;
    const replyHeaders: string[] = [];
    if (draft.replyToMessageId) {
      const params = new URLSearchParams({ format: "metadata" });
      for (const name of ["Message-ID", "References", "Subject"])
        params.append("metadataHeaders", name);
      const source = messageSchema.parse(
        await this.request(`${GMAIL}/messages/${idPath(draft.replyToMessageId)}?${params}`),
      );
      if (draft.threadId && source.threadId !== draft.threadId)
        throw new Error("Reply thread does not match the source message");
      threadId = source.threadId;
      const metadata = headers(source.payload);
      const messageId = singleLine(metadata.get("message-id") ?? "", "Message-ID");
      if (!/^<[^<>\s]+@[^<>\s]+>$/.test(messageId))
        throw new Error("Source message has no valid Message-ID for reply threading");
      const normalizedSubject = (subject: string) =>
        decodeMimeHeader(subject)
          .replace(/^(?:\s*re:\s*)+/i, "")
          .trim();
      if (normalizedSubject(draft.subject) !== normalizedSubject(metadata.get("subject") ?? ""))
        throw new Error("Reply subject must match the source message subject");
      const references = singleLine(metadata.get("references") ?? "", "References").trim();
      if (references && !/^(?:<[^<>\s]+@[^<>\s]+>\s*)+$/.test(references))
        throw new Error("Source message has invalid References headers");
      const chain = [...new Set([...(references.match(/<[^<>\s]+>/g) ?? []), messageId])];
      if (chain.join(" ").length > 950)
        throw new Error("Reply References header exceeds the supported length");
      replyHeaders.push(`In-Reply-To: ${messageId}`, `References: ${chain.join(" ")}`);
    }
    const profile = z
      .object({ emailAddress: z.email() })
      .parse(await this.request(`${GMAIL}/profile`));
    const mimeHeaders = [
      `From: ${singleLine(profile.emailAddress, "sender")}`,
      `To: ${draft.to.join(",\r\n ")}`,
      ...(draft.cc.length ? [`Cc: ${draft.cc.join(",\r\n ")}`] : []),
      ...(draft.bcc.length ? [`Bcc: ${draft.bcc.join(",\r\n ")}`] : []),
      `Subject: ${encodedSubject(draft.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${randomUUID()}@openmuse.invalid>`,
      ...replyHeaders,
      "MIME-Version: 1.0",
    ];
    const textPart = [
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(Buffer.from(draft.body.replace(/\r\n|\r|\n/g, "\r\n"))),
    ].join("\r\n");
    let mime: string;
    if (!attachments.length) mime = [...mimeHeaders, textPart].join("\r\n");
    else {
      const boundary = `openmuse_${randomUUID()}`;
      const parts = [
        textPart,
        ...attachments.map((attachment) => {
          const name = encodeURIComponent(attachment.name).replace(
            /['()*]/g,
            (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
          );
          return [
            `Content-Type: ${attachment.mimeType}`,
            `Content-Disposition: attachment; filename*=UTF-8''${name}`,
            "Content-Transfer-Encoding: base64",
            "",
            wrapBase64(attachment.bytes),
          ].join("\r\n");
        }),
      ];
      mime = [
        ...mimeHeaders,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        ...parts.map((part) => `--${boundary}\r\n${part}`),
        `--${boundary}--`,
        "",
      ].join("\r\n");
    }
    return {
      raw: Buffer.from(mime).toString("base64url"),
      ...(threadId ? { threadId } : {}),
    };
  }

  async sendEmail(
    input: EmailDraft,
    attachments: MailAttachment[],
  ): Promise<{ id: string; threadId?: string }> {
    const result = await this.request(
      `${GMAIL}/messages/send`,
      "POST",
      await this.prepareEmailMessage(input, attachments),
    );
    const parsed = z
      .object({ id: z.string().min(1), threadId: z.string().optional() })
      .safeParse(result);
    if (!parsed.success) throw new OutcomeUnknownError();
    return parsed.data;
  }

  async createEvent(input: EventDraft): Promise<CalendarEvent> {
    const draft = eventDraftSchema.parse(input);
    const result = await this.request(
      `${calendarPath(draft.calendarId)}?sendUpdates=all`,
      "POST",
      eventBody(draft),
    );
    try {
      return mapEvent(result, draft.calendarId, draft.timeZone);
    } catch {
      throw new OutcomeUnknownError();
    }
  }

  async updateEvent(
    eventId: string,
    input: EventDraft,
    expectedVersion?: string,
  ): Promise<CalendarEvent> {
    const draft = eventDraftSchema.parse(input);
    const current = await this.readSingleEvent(draft.calendarId, eventId);
    const result = await this.request(
      `${calendarPath(draft.calendarId)}/${idPath(eventId)}?sendUpdates=all`,
      "PATCH",
      eventBody(draft, true),
      { "If-Match": this.eventVersion(current, expectedVersion) },
    );
    try {
      return mapEvent(result, draft.calendarId, draft.timeZone);
    } catch {
      throw new OutcomeUnknownError();
    }
  }

  async deleteEvent(calendarId: string, eventId: string, expectedVersion?: string): Promise<void> {
    const current = await this.readSingleEvent(calendarId, eventId);
    await this.request(
      `${calendarPath(calendarId)}/${idPath(eventId)}?sendUpdates=all`,
      "DELETE",
      undefined,
      { "If-Match": this.eventVersion(current, expectedVersion) },
    );
  }
}
