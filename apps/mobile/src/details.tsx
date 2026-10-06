import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import {
  CalendarDays,
  Clock3,
  Download,
  Edit3,
  ExternalLink,
  FileText,
  Globe2,
  Mail as MailIcon,
  Reply,
  RotateCw,
  Save,
  Send,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Platform,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import {
  type ActionProposal,
  type Artifact,
  type BrowserSession,
  type CalendarEvent,
  type EmailDraft,
  type EventDraft,
  emailDraftSchema,
  eventDraftSchema,
  type Mail,
  type ProposalInput,
} from "../../../packages/domain/src";
import type { ComputerCommand } from "../../../packages/domain/src/computer";
import { AgentDocument } from "./agent-document";
import { DelegateSheet, NotificationsSheet, TaskDetail } from "./agent-ui";
import { localizedAttachmentLabel } from "./attachment-ui-copy";
import BrowserConsole from "./BrowserConsole";
import { browserAddress, browserSite } from "./browser-address";
import { ComputerSheet } from "./computer";
import DateTimeEditor from "./DateTimeEditor";
import { localDateTime, zonedInstant } from "./date-time";
import { connectorReviewLines } from "./external-action-preview";
import { FileContentPreview, hasFileContentPreview } from "./file-content-preview";
import { GoogleApprovalCard } from "./google-workspace-cards";
import { useI18n } from "./i18n";
import PdfReader from "./PdfReader";
import {
  Button,
  Card,
  CheckRow,
  dateLabel,
  Empty,
  ErrorNotice,
  Field,
  LinkRow,
  resultSummary,
  Sheet,
  timeLabel,
  useUI,
} from "./ui";
import { type Detail, useWorkspace } from "./workspace";
export function Details({ detail, embedded = false }: { detail: Detail; embedded?: boolean }) {
  const { t } = useI18n();
  const { close, navigate } = useWorkspace();
  if (detail.type === "agent-soul" || detail.type === "agent-memory")
    return <AgentDocument kind={detail.type} embedded={embedded} />;
  if (detail.type === "computer") return <ComputerSheet embedded={embedded} />;
  if (detail.type === "task") return <TaskDetail taskId={detail.taskId} />;
  if (detail.type === "delegate") return <DelegateSheet />;
  if (detail.type === "notifications") return <NotificationsSheet />;
  if (detail.type === "mail") return <MailDetail mail={detail.mail} />;
  if (detail.type === "email") return <EmailEditor draft={detail.draft} />;
  if (detail.type === "event")
    return <EventEditor event={detail.event} draft={detail.draft} neighbors={detail.neighbors} />;
  if (detail.type === "file") return <FileDetail file={detail.file} embedded={embedded} />;
  if (detail.type === "review") return <ReviewDetail initial={detail.action} />;
  if (detail.type === "browser")
    return <BrowserDetail initial={detail.browser} embedded={embedded} />;
  return (
    <Sheet
      title={t("Your workspace")}
      subtitle={t("A little room for everything.")}
      onClose={close}
    >
      {[
        { section: "mail" as const, title: t("Mail"), icon: MailIcon },
        { section: "calendar" as const, title: t("Calendar"), icon: CalendarDays },
        { section: "browser" as const, title: t("Browser"), icon: Globe2 },
        { section: "files" as const, title: t("Files"), icon: FileText },
        { section: "activity" as const, title: t("Activity"), icon: Clock3 },
        { section: "connections" as const, title: t("Connections"), icon: ShieldCheck },
      ].map((item) => (
        <LinkRow
          key={item.section}
          title={item.title}
          icon={item.icon}
          onPress={() => {
            navigate(item.section);
            close();
          }}
        />
      ))}
    </Sheet>
  );
}
function MailDetail({ mail: m }: { mail: Mail }) {
  const { colors, s } = useUI();

  const { t } = useI18n();
  const { workspace: w, api, refresh, open, close } = useWorkspace();
  const [error, setError] = useState("");
  const [importing, setImporting] = useState("");
  async function importAttachment(reference: string) {
    setError("");
    setImporting(reference);
    try {
      const file = await api.request<Artifact>("/api/mail/import-attachment", { reference });
      await refresh();
      open({ type: "file", file });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting("");
    }
  }
  const [thread, setThread] = useState<Mail[]>([m]);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void api
      .request<Mail[]>(`/api/mail/threads/${encodeURIComponent(m.threadId)}`)
      .then((items) => {
        if (active) setThread(items.sort((a, b) => a.date.localeCompare(b.date)));
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, m.threadId, retry]);
  return (
    <Sheet
      title={m.subject}
      subtitle={
        thread.length === 1
          ? t("1 message in this conversation")
          : t("{count} messages in this conversation", { count: thread.length })
      }
      onClose={close}
      footer={
        <Button
          primary
          icon={Reply}
          style={{ alignSelf: "flex-start" }}
          onPress={() =>
            open({
              type: "email",
              draft: {
                to: [m.from],
                subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
                body: "",
                cc: [],
                bcc: [],
                attachmentIds: [],
                threadId: m.threadId,
                replyToMessageId: m.id,
              },
            })
          }
        >
          {t("Write a reply")}
        </Button>
      }
    >
      {loading && (
        <View style={[s.row, { gap: 10, paddingBottom: 20 }]}>
          <ActivityIndicator color={colors.blueDark} />
          <Text style={s.muted}>{t("Loading the conversation…")}</Text>
        </View>
      )}
      {thread.map((message) => (
        <View
          key={message.id}
          style={{
            paddingBottom: 26,
            marginBottom: 24,
            borderBottomWidth: 1,
            borderBottomColor: colors.line,
          }}
        >
          <View style={[s.between, { gap: 16, alignItems: "flex-start" }]}>
            <View style={{ gap: 4, flex: 1 }}>
              <Text style={s.heading}>{message.sender}</Text>
              <Text style={s.small}>{message.from}</Text>
              <Text style={s.small}>
                {t("To: {recipients}", { recipients: message.to.join(", ") })}
              </Text>
            </View>
            <Text style={s.small}>
              {dateLabel(message.date)} · {timeLabel(message.date)}
            </Text>
          </View>
          <View style={{ height: 18 }} />
          <Text selectable style={[s.text, { lineHeight: 25 }]}>
            {message.body}
          </Text>
          {message.attachments.map((id) => {
            const file = w.files.find((f) => f.id === id);
            return file ? (
              <LinkRow
                key={id}
                title={file.name}
                detail={t("{pages} pages · PDF attachment", { pages: file.pageCount })}
                icon={FileText}
                onPress={() => open({ type: "file", file })}
              />
            ) : (
              <Button
                key={id}
                busy={importing === id}
                icon={FileText}
                onPress={() => void importAttachment(id)}
              >
                {decodeURIComponent(id.split(":").slice(2).join(":")) || t("Open attachment")}
              </Button>
            );
          })}
        </View>
      ))}
      <ErrorNotice error={error} />
      {!!error && <Button onPress={() => setRetry(retry + 1)}>{t("Reload conversation")}</Button>}
    </Sheet>
  );
}
function actionRequestKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}
function EmailEditor({ draft }: { draft?: Partial<EmailDraft> & { id?: string } }) {
  const { colors, s } = useUI();

  const { t } = useI18n();
  const { workspace: w, api, refresh, open, close, notify } = useWorkspace();
  const requestKey = useRef<string | undefined>(undefined);
  requestKey.current ??= actionRequestKey();
  const [to, setTo] = useState(draft?.to?.join(", ") || "");
  const [cc, setCc] = useState(draft?.cc?.join(", ") || "");
  const [bcc, setBcc] = useState(draft?.bcc?.join(", ") || "");
  const [subject, setSubject] = useState(draft?.subject || "");
  const [body, setBody] = useState(draft?.body || "");
  const [attachments, setAttachments] = useState(draft?.attachmentIds || []);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  function emails(value: string) {
    return value
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  async function save(review: boolean) {
    setBusy(review ? "review" : "draft");
    setError("");
    try {
      const parsed = emailDraftSchema.safeParse({
        to: emails(to),
        cc: emails(cc),
        bcc: emails(bcc),
        subject,
        body,
        attachmentIds: attachments,
        threadId: draft?.threadId,
        replyToMessageId: draft?.replyToMessageId,
      });
      if (!parsed.success)
        throw new Error(
          parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"),
        );
      if (review) {
        const action = await api.request<ActionProposal>("/api/actions", {
          kind: "email.send",
          data: parsed.data,
          idempotencyKey: requestKey.current,
        });
        await refresh();
        if (action.status === "succeeded") {
          notify(action.result || t("Action completed."));
          close();
        } else open({ type: "review", action });
      } else {
        await api.request("/api/drafts", {
          ...parsed.data,
          ...(draft?.id ? { id: draft.id } : {}),
        });
        await refresh();
        notify(t("Draft saved in OkamiBot."));
        close();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <Sheet
      title={draft?.threadId ? t("Write a reply") : t("A new message")}
      subtitle={t("From {email} · saved privately in OkamiBot", { email: w.profile.email })}
      onClose={close}
      footer={
        <View>
          <View style={[s.row, { gap: 10, flexWrap: "wrap" }]}>
            <Button
              primary
              icon={ShieldCheck}
              busy={busy === "review"}
              disabled={!!busy}
              onPress={() => void save(true)}
            >
              {w.runtime.approvalPolicy === "money" ? t("Send email") : t("Review email")}
            </Button>
            <Button
              icon={Save}
              busy={busy === "draft"}
              disabled={!!busy}
              onPress={() => void save(false)}
            >
              {t("Save draft")}
            </Button>
          </View>
          <Text style={[s.small, { marginTop: 10 }]}>
            {w.runtime.approvalPolicy === "money"
              ? t("Sending uses your connected account and is recorded in the action log.")
              : t(
                  "You’ll review the recipients, message, and attachments before anything is sent.",
                )}
          </Text>
        </View>
      }
    >
      <Field
        label={t("To")}
        value={to}
        onChangeText={setTo}
        placeholder="person@example.com"
        autoCapitalize="none"
        keyboardType="email-address"
      />
      <View style={{ flexDirection: "row", gap: 16 }}>
        <View style={{ flex: 1 }}>
          <Field
            label={t("Cc")}
            value={cc}
            onChangeText={setCc}
            placeholder={t("Optional")}
            autoCapitalize="none"
          />
        </View>
        <View style={{ flex: 1 }}>
          <Field
            label={t("Bcc")}
            value={bcc}
            onChangeText={setBcc}
            placeholder={t("Optional")}
            autoCapitalize="none"
          />
        </View>
      </View>
      <Field
        label={t("Subject")}
        value={subject}
        onChangeText={setSubject}
        placeholder={t("What’s on your mind?")}
      />
      <Field
        label={t("Message")}
        value={body}
        onChangeText={setBody}
        multiline
        placeholder={t("Start your message…")}
        style={{ minHeight: 210 }}
      />
      {w.files.length > 0 && (
        <View
          style={{
            paddingTop: 16,
            marginBottom: 6,
            borderTopWidth: 1,
            borderTopColor: colors.line,
          }}
        >
          <Text style={[s.heading, { fontSize: 13, marginBottom: 5 }]}>{t("Attachments")}</Text>
          {w.files.map((f) => (
            <CheckRow
              key={f.id}
              checked={attachments.includes(f.id)}
              label={`${f.name} · ${Math.max(1, Math.round(f.size / 1024))} KB`}
              onPress={() =>
                setAttachments(
                  attachments.includes(f.id)
                    ? attachments.filter((id) => id !== f.id)
                    : [...attachments, f.id],
                )
              }
            />
          ))}
        </View>
      )}
      <ErrorNotice error={error} />
    </Sheet>
  );
}
function EventEditor({
  event: e,
  draft,
  neighbors,
}: {
  event?: CalendarEvent;
  draft?: EventDraft;
  neighbors?: CalendarEvent[];
}) {
  const { colors, s } = useUI();

  const { t } = useI18n();
  const seed = e || draft;
  const { workspace: w, api, open, close, refresh, notify } = useWorkspace();
  const requestKey = useRef<string | undefined>(undefined);
  requestKey.current ??= actionRequestKey();
  const initialStart = new Date();
  initialStart.setMinutes(0, 0, 0);
  initialStart.setHours(initialStart.getHours() + 1);
  const [title, setTitle] = useState(seed?.title || "");
  const [start, setStart] = useState(seed?.start || initialStart.toISOString());
  const [end, setEnd] = useState(
    seed?.end || new Date(initialStart.getTime() + 3600000).toISOString(),
  );
  const [allDay, setAllDay] = useState(seed?.allDay || false);
  const [zone, setZone] = useState(
    seed?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [location, setLocation] = useState(seed?.location || "");
  const [description, setDescription] = useState(seed?.description || "");
  const [attendees, setAttendees] = useState(seed?.attendees.join(", ") || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const conflicts = (neighbors || w.events).filter(
    (item) =>
      item.id !== e?.id &&
      Date.parse(start) < Date.parse(item.end) &&
      Date.parse(end) > Date.parse(item.start),
  );
  async function propose(remove = false) {
    setBusy(true);
    setError("");
    try {
      let data: ProposalInput;
      if (remove && e) {
        data = {
          kind: "calendar.delete",
          data: { eventId: e.id, calendarId: e.calendarId, title: e.title },
        };
      } else {
        const parsed = eventDraftSchema.safeParse({
          calendarId: e?.calendarId || draft?.calendarId || "primary",
          title,
          start,
          end,
          allDay,
          timeZone: zone,
          location,
          description,
          attendees: attendees
            .split(/[,;\n]/)
            .map((a) => a.trim())
            .filter(Boolean),
        });
        if (!parsed.success)
          throw new Error(
            parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"),
          );
        data = e
          ? { kind: "calendar.update", data: { ...parsed.data, eventId: e.id } }
          : { kind: "calendar.create", data: parsed.data };
      }
      const action = await api.request<ActionProposal>("/api/actions", {
        ...data,
        idempotencyKey: requestKey.current,
      });
      await refresh();
      if (action.status === "succeeded") {
        notify(action.result || t("Calendar updated."));
        close();
      } else open({ type: "review", action });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title={e ? t("Edit event") : t("Create event")}
      subtitle={e ? t("Edit this event in your calendar.") : t("Create an event in your calendar.")}
      onClose={close}
      footer={
        <View style={[s.row, { gap: 10, flexWrap: "wrap" }]}>
          <Button primary icon={ShieldCheck} busy={busy} onPress={() => void propose()}>
            {w.runtime.approvalPolicy === "money"
              ? e
                ? t("Save changes")
                : t("Save event")
              : e
                ? t("Review changes")
                : t("Review event")}
          </Button>
          {e && (
            <Button icon={Trash2} disabled={busy} danger onPress={() => void propose(true)}>
              {w.runtime.approvalPolicy === "money" ? t("Delete event") : t("Review deletion")}
            </Button>
          )}
        </View>
      }
    >
      <Field
        label={t("Event title")}
        value={title}
        onChangeText={setTitle}
        placeholder={t("What are you making time for?")}
      />
      <CheckRow
        label={t("All-day event")}
        checked={allDay}
        onPress={() => {
          try {
            if (!allDay) {
              const local = localDateTime(start, zone);
              const endDay = new Date(`${local.date}T12:00:00Z`);
              endDay.setUTCDate(endDay.getUTCDate() + 1);
              setStart(local.date);
              setEnd(endDay.toISOString().slice(0, 10));
            } else {
              setStart(zonedInstant(start, "09:00", zone));
              setEnd(zonedInstant(start, "10:00", zone));
            }
            setAllDay(!allDay);
            setError("");
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }}
      />
      <DateTimeEditor
        label={t("Starts")}
        value={start}
        onChange={setStart}
        timeZone={zone}
        allDay={allDay}
      />
      <DateTimeEditor
        label={t("Ends")}
        value={end}
        onChange={setEnd}
        timeZone={zone}
        allDay={allDay}
      />
      {allDay && (
        <Text style={[s.small, { marginBottom: 15 }]}>
          {t("The end date is the day after the last day of your event.")}
        </Text>
      )}
      <Field
        label={t("Time zone")}
        value={zone}
        onChangeText={setZone}
        placeholder="America/Los_Angeles"
      />
      <Field
        label={t("Location or meeting link")}
        value={location}
        onChangeText={setLocation}
        placeholder={t("Optional")}
      />
      <Field
        label={t("Attendees")}
        value={attendees}
        onChangeText={setAttendees}
        placeholder={t("Email addresses, separated by commas")}
      />
      <Field
        label={t("Notes")}
        value={description}
        onChangeText={setDescription}
        multiline
        placeholder={t("Anything else to keep in mind?")}
      />
      {!!conflicts.length && (
        <Card style={{ backgroundColor: colors.orange, padding: 16, marginBottom: 16 }}>
          <Text style={s.heading}>{t("This time overlaps")}</Text>
          {conflicts.map((c) => (
            <Text key={c.id} style={s.muted}>
              {c.title} · {timeLabel(c.start, c.timeZone)}–{timeLabel(c.end, c.timeZone)}
            </Text>
          ))}
        </Card>
      )}
      <ErrorNotice error={error} />
    </Sheet>
  );
}
function ReviewDetail({ initial }: { initial: ActionProposal }) {
  const { colors, s } = useUI();

  const { t, locale } = useI18n();
  const { workspace: w, api, refresh, close, open } = useWorkspace();
  const [local, setLocal] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const action =
    local.status !== initial.status ? local : w.actions.find((a) => a.id === initial.id) || local;
  const d = action.data;
  const pending = action.status === "awaiting_review";
  async function decide(decision: "approve" | "deny") {
    setBusy(true);
    setError("");
    try {
      const result = await api.request<ActionProposal>(`/api/actions/${action.id}/decide`, {
        decision,
        hash: action.hash,
      });
      setLocal(result);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function edit() {
    setBusy(true);
    setError("");
    try {
      let next: Detail;
      if (action.kind === "email.send")
        next = { type: "email", draft: emailDraftSchema.parse(action.data) };
      else {
        const draft = eventDraftSchema.parse(action.data);
        if (action.kind === "calendar.update") {
          const eventId = action.data.eventId;
          if (typeof eventId !== "string" || !eventId)
            throw new Error(t("The event reference is missing. Open the event in Calendar again."));
          next = { type: "event", event: { ...draft, id: eventId } };
        } else next = { type: "event", draft };
      }
      await api.request(`/api/actions/${action.id}/decide`, {
        decision: "deny",
        hash: action.hash,
      });
      await refresh();
      open(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const email = action.kind === "email.send";
  const external = action.kind === "external.action";
  if (d.tool === "google.workspace" || action.kind === "calendar.delete")
    return (
      <Sheet
        title={t("Review action")}
        onClose={close}
        footer={<Button onPress={close}>{t("Done")}</Button>}
      >
        <GoogleApprovalCard action={action} />
      </Sheet>
    );
  return (
    <Sheet
      title={action.title}
      subtitle={
        w.mode === "sample"
          ? t("This action stays in your local workspace.")
          : t("Review this action before it changes your connected account.")
      }
      onClose={close}
      footer={
        pending ? (
          <>
            <Text style={[s.small, { marginBottom: 14 }]}>
              Review expires{" "}
              {new Date(action.expiresAt).toLocaleString(locale === "pt-BR" ? "pt-BR" : "en-US", {
                year: "numeric",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                timeZoneName: "short",
              })}
              {`. ${t("Your approval applies only to the details shown above.")}`}
            </Text>
            {!external && (
              <Button
                small
                icon={Edit3}
                disabled={busy}
                style={{ alignSelf: "flex-start", marginBottom: 12 }}
                onPress={() => void edit()}
              >
                {t("Edit details")}
              </Button>
            )}
            <View style={[s.row, { gap: 10 }]}>
              <Button style={{ flex: 1 }} disabled={busy} onPress={() => void decide("deny")}>
                {t("Deny")}
              </Button>
              <Button
                style={{ flex: 1 }}
                primary
                busy={busy}
                onPress={() => void decide("approve")}
              >
                {w.mode === "sample"
                  ? t("Approve locally")
                  : email
                    ? t("Approve & send")
                    : t("Approve change")}
              </Button>
            </View>
          </>
        ) : (
          <Button style={{ alignSelf: "flex-start", marginTop: 19 }} onPress={close}>
            {t("Done")}
          </Button>
        )
      }
    >
      <View style={[s.row, { gap: 9, paddingBottom: 20 }]}>
        <ShieldCheck size={17} color={pending ? colors.blueDark : colors.muted} />
        <Text style={[s.muted, { fontSize: 13 }]}>{t(action.status.replace(/_/g, " "))}</Text>
      </View>
      <View style={{ gap: 8 }}>
        {!external && <ReviewLine label={t("Account")} value={action.account || w.profile.email} />}
        {external ? (
          <>
            <ReviewLine label={t("Tool")} value={String(d.tool || "")} />
            <ReviewLine label={t("Target")} value={String(d.target || "")} />
            <ReviewLine label={t("Action")} value={String(d.summary || "")} />
            {!!d.element && (
              <ReviewLine
                label={t("Control")}
                value={`${String(d.element)} · ${String(d.label || "")}`}
              />
            )}
            {!!d.action && <ReviewLine label={t("Operation")} value={String(d.action)} />}
            {connectorReviewLines(d).map((line) => (
              <ReviewLine key={line.label} label={line.label} value={line.value} />
            ))}
            <Text style={s.small}>
              {d.tool === "mcp.call"
                ? t(
                    "Review this request, amount and recipient before approving. Approval applies only to these arguments, connector and account; changes require a fresh review.",
                  )
                : t(
                    "Inspect the page, amount and recipient before approving. Approval applies only to this prepared action; page changes or human takeover require a fresh review.",
                  )}
            </Text>
            {typeof d.sessionId === "string" && (
              <Button
                onPress={() => {
                  void api
                    .request<BrowserSession>(`/api/browsers/${d.sessionId}`)
                    .then((browser) => open({ type: "browser", browser }))
                    .catch((failure) =>
                      setError(
                        failure instanceof Error ? failure.message : t("Browser unavailable"),
                      ),
                    );
                }}
              >
                {t("Inspect browser page")}
              </Button>
            )}
          </>
        ) : email ? (
          <>
            <ReviewLine label={t("To")} value={arrayText(d.to)} />
            <ReviewLine label={t("Cc")} value={arrayText(d.cc) || t("None")} />
            <ReviewLine label={t("Bcc")} value={arrayText(d.bcc) || t("None")} />
            <ReviewLine label={t("Subject")} value={String(d.subject || "")} />
            <View style={s.divider} />
            <Text selectable style={[s.text, { lineHeight: 25 }]}>
              {String(d.body || "")}
            </Text>
            <View style={s.divider} />
            <Text style={s.label}>{t("Attachments")}</Text>
            {Array.isArray(d.attachmentIds) && d.attachmentIds.length ? (
              d.attachmentIds.map((id) => {
                const file = w.files.find((f) => f.id === id);
                return (
                  <Text key={String(id)} style={s.text}>
                    {t("{name} · version {version}", {
                      name: file?.name || String(id),
                      version: String(id).slice(-8),
                    })}
                  </Text>
                );
              })
            ) : (
              <Text style={s.muted}>{t("No attachments")}</Text>
            )}
          </>
        ) : (
          <>
            <ReviewLine label={t("Event")} value={String(d.title || "")} />
            {!external && (
              <>
                <ReviewLine
                  label={t("Starts")}
                  value={
                    d.allDay
                      ? String(d.start || "")
                      : `${dateLabel(String(d.start || ""), { year: "numeric", month: "short", day: "numeric", timeZone: String(d.timeZone || "UTC") })} · ${timeLabel(String(d.start || ""), String(d.timeZone || "UTC"))}`
                  }
                />
                <ReviewLine
                  label={t("Ends")}
                  value={
                    d.allDay
                      ? `${String(d.end || "")} (${t("exclusive")})`
                      : `${dateLabel(String(d.end || ""), { year: "numeric", month: "short", day: "numeric", timeZone: String(d.timeZone || "UTC") })} · ${timeLabel(String(d.end || ""), String(d.timeZone || "UTC"))}`
                  }
                />
                <ReviewLine label={t("Time zone")} value={String(d.timeZone || "")} />
                <ReviewLine label={t("All day")} value={d.allDay ? t("Yes") : t("No")} />
                <ReviewLine label={t("Location")} value={String(d.location || t("None"))} />
                <ReviewLine
                  label={t("Attendees")}
                  value={arrayText(d.attendees) || t("Just you")}
                />
                <ReviewLine label={t("Notes")} value={String(d.description || t("None"))} />
              </>
            )}
            <ReviewLine label={t("Calendar")} value={String(d.calendarId || "primary")} />
            <Text style={s.small}>
              {t("Attendees may receive an invitation or update from your connected calendar.")}
            </Text>
          </>
        )}
      </View>
      <ErrorNotice error={error || action.error} />
      {!!action.result && (
        <Card style={{ marginTop: 16, backgroundColor: colors.green, padding: 18 }}>
          <Text selectable style={s.text}>
            {resultSummary(action.result)}
          </Text>
        </Card>
      )}
    </Sheet>
  );
}
function arrayText(value: unknown) {
  return Array.isArray(value) ? value.map(String).join(", ") : "";
}
function ReviewLine({ label, value }: { label: string; value: string }) {
  const { colors, s } = useUI();

  return (
    <View
      style={{
        flexDirection: "row",
        gap: 18,
        paddingVertical: 11,
        borderBottomWidth: 1,
        borderBottomColor: colors.line,
      }}
    >
      <Text style={{ width: 100, fontSize: 13, lineHeight: 21, color: colors.muted }}>{label}</Text>
      <Text selectable style={[s.text, { flex: 1, fontSize: 14, lineHeight: 21 }]}>
        {value}
      </Text>
    </View>
  );
}
function FileDetail({ file: initial, embedded = false }: { file: Artifact; embedded?: boolean }) {
  const { colors, s } = useUI();

  const { t } = useI18n();
  const { api, refresh, open, close } = useWorkspace();
  const [f, setFile] = useState(initial);
  const [preview, setPreview] = useState<Artifact>();
  useEffect(() => {
    let active = true;
    void api
      .request<Artifact>(`/api/files/${initial.id}`)
      .then((file) => {
        if (active) setFile(file);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [api, initial.id]);
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      (f.fields || [])
        .filter((field) => field.type !== "unsupported")
        .map((field) => [
          field.name,
          field.type === "checkbox" ? field.value === "true" || field.value === "Yes" : field.value,
        ]),
    ),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  useEffect(() => {
    if (!/\.(pptx|docx)$/i.test(f.name)) return;
    let active = true;
    setPreview(undefined);
    setPreviewLoading(true);
    void api
      .request<Artifact>(`/api/files/${f.id}/preview`, {})
      .then((file) => {
        if (active) setPreview(file);
      })
      .catch(() => {
        // Imported Office files retain the existing native conversion option.
      })
      .finally(() => {
        if (active) setPreviewLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, f.id, f.name]);
  const url = api.url(f.url || `/api/files/${f.id}/content`);
  async function fill() {
    setBusy(true);
    setError("");
    try {
      const file = await api.request<Artifact>(`/api/files/${f.id}/fill`, { fields: values });
      await refresh();
      open({ type: "file", file });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function share() {
    setError("");
    try {
      const current = await api.request<Artifact>(`/api/files/${f.id}`);
      setFile(current);
      const currentUrl = api.url(current.url);
      if (Platform.OS === "web") {
        await Linking.openURL(currentUrl);
        return;
      }
      const extension =
        f.name
          .split(".")
          .at(-1)
          ?.replace(/[^a-zA-Z0-9]/g, "") || "bin";
      const target = `${FileSystem.cacheDirectory}${f.id}.${extension}`;
      await FileSystem.downloadAsync(currentUrl, target, {
        headers: { Authorization: await api.authorization() },
      });
      if (await Sharing.isAvailableAsync())
        await Sharing.shareAsync(target, {
          mimeType: f.mimeType,
          ...(f.mimeType === "application/pdf" && { UTI: "com.adobe.pdf" }),
        });
      else throw new Error(t("Sharing is not available on this device."));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function createPreview() {
    setBusy(true);
    setError("");
    try {
      await api.request("/api/computer/start", {});
      const path = `/workspace/preview-${f.id}.${f.name.split(".").at(-1)}`;
      await api.request("/api/computer/files/import", { fileId: f.id, path });
      const receipt = await api.request<ComputerCommand>("/api/computer/preview", {
        path,
        background: false,
        timeoutMs: 120000,
      });
      if (receipt.status !== "succeeded" || !receipt.result?.previewPath)
        throw new Error(
          receipt.stderr ||
            t("Office preview did not complete. Check the computer's installed tools."),
        );
      const file = await api.request<Artifact>("/api/computer/files/export", {
        path: receipt.result.previewPath,
      });
      setPreview(file);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const { width, height } = useWindowDimensions();
  const split = width >= 900 && Boolean(f.fields?.length);
  const previewHeight = embedded
    ? Math.max(320, height - 218)
    : Math.max(260, Math.min(494, height * 0.9 - 260));
  const form =
    f.fields && f.fields.length > 0 ? (
      <View style={{ padding: 22, gap: 8 }}>
        <Text style={[s.heading, { fontSize: 15 }]}>{t("Fill this form")}</Text>
        <Text style={[s.small, { marginBottom: 12 }]}>
          {t("Add your details below. Saving creates a new copy and keeps the original intact.")}
        </Text>
        {f.fields.map((field) =>
          field.type === "unsupported" ? (
            <Text key={field.name} style={s.muted}>
              {t("{field} · this field type is not supported", { field: field.name })}
            </Text>
          ) : field.type === "checkbox" ? (
            <CheckRow
              key={field.name}
              checked={!!values[field.name]}
              label={field.name.replace(/_/g, " ").replace(/^./, (s) => s.toUpperCase())}
              onPress={() => setValues({ ...values, [field.name]: !values[field.name] })}
            />
          ) : (
            <Field
              key={field.name}
              label={field.name.replace(/_/g, " ").replace(/^./, (s) => s.toUpperCase())}
              value={String(values[field.name] || "")}
              onChangeText={(value) => setValues({ ...values, [field.name]: value })}
            />
          ),
        )}
        <Button primary icon={Save} busy={busy} onPress={() => void fill()}>
          {t("Save filled copy")}
        </Button>
      </View>
    ) : null;
  return (
    <Sheet
      title={f.name}
      embedded={embedded}
      subtitle={t("{fileType} · {source}", {
        fileType: localizedAttachmentLabel(f, t),
        source: t(f.source),
      })}
      onClose={close}
      wide
      scroll={false}
      contentStyle={{ padding: 0 }}
      footer={
        <View style={[s.between, { gap: 12, flexWrap: "wrap" }]}>
          <Text style={s.small}>
            {t("Added {date}", { date: dateLabel(f.createdAt) })}
            {f.parentId ? ` · ${t("filled copy")}` : ""}
          </Text>
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            <Button
              small
              icon={Send}
              onPress={() => open({ type: "email", draft: { attachmentIds: [f.id] } })}
            >
              {t("Attach to email")}
            </Button>
            <Button small primary icon={Download} onPress={() => void share()}>
              {Platform.OS === "web" ? t("Open / download") : t("Save or share")}
            </Button>
          </View>
        </View>
      }
    >
      <View style={{ flex: 1, minHeight: 0, flexDirection: split ? "row" : "column" }}>
        <ScrollView
          style={{ flex: 1, minWidth: 0, backgroundColor: colors.subtle }}
          contentContainerStyle={{ flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ padding: 16, flex: 1, justifyContent: "center" }}>
            {f.mimeType === "application/pdf" ? (
              <PdfReader
                url={url}
                token={api.token}
                pageCount={f.pageCount}
                height={previewHeight}
              />
            ) : f.mimeType.startsWith("image/") ? (
              <Image
                source={{ uri: url }}
                style={{ width: "100%", height: previewHeight + 46 }}
                resizeMode="contain"
              />
            ) : hasFileContentPreview(f) ? (
              <FileContentPreview file={f} url={url} height={previewHeight + 46} />
            ) : previewLoading ? (
              <View
                style={{
                  minHeight: previewHeight,
                  justifyContent: "center",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <ActivityIndicator color={colors.blueDark} />
                <Text style={s.muted}>{t("Preparing document preview…")}</Text>
              </View>
            ) : preview ? (
              <PdfReader
                url={api.url(preview.url)}
                token={api.token}
                pageCount={preview.pageCount}
                height={previewHeight}
              />
            ) : (
              <View
                style={{
                  minHeight: previewHeight,
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 28,
                  gap: 18,
                }}
              >
                <FileText size={44} color={colors.muted} strokeWidth={1.3} />
                <Text style={[s.muted, { textAlign: "center", maxWidth: 290 }]}>
                  {t("Save or share this file to open it in another app.")}
                </Text>
                {/\.(pptx|docx|xlsx|odt|odp|ods)$/i.test(f.name) && (
                  <Button busy={busy} onPress={() => void createPreview()}>
                    {t("Create PDF preview")}
                  </Button>
                )}
              </View>
            )}
            <ErrorNotice error={error} />
          </View>
          {!split && form && <View style={{ backgroundColor: colors.card }}>{form}</View>}
        </ScrollView>
        {split && (
          <ScrollView
            style={{ width: 300, flexGrow: 0, borderLeftWidth: 1, borderLeftColor: colors.line }}
            keyboardShouldPersistTaps="handled"
          >
            {form}
          </ScrollView>
        )}
      </View>
    </Sheet>
  );
}

function BrowserDetail({
  initial,
  embedded = false,
}: {
  initial: BrowserSession;
  embedded?: boolean;
}) {
  const { colors, s } = useUI();

  const { t } = useI18n();
  const { height } = useWindowDimensions();
  const previewHeight = embedded
    ? Math.max(320, height - 240)
    : Math.max(260, Math.min(494, height * 0.9 - 275));
  const { workspace: w, api, refresh, close, notify } = useWorkspace();
  const [local, setLocal] = useState(initial);
  const [url, setUrl] = useState(initial.url);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const latest = w.browsers.find((b) => b.id === initial.id);
  const browser = {
    ...(latest && latest.updatedAt > local.updatedAt ? latest : local),
    consoleUrl: local.consoleUrl,
    previewUrl: local.previewUrl,
  };
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void api
      .request<BrowserSession>(`/api/browsers/${initial.id}`)
      .then((session) => {
        if (active) {
          setLocal(session);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [api, initial.id, retry]);
  async function importDownloads() {
    setBusy(true);
    setError("");
    try {
      const result = await api.request<{
        files: Artifact[];
        failures: { name: string; message: string }[];
      }>(`/api/browsers/${browser.id}/import-downloads`, {});
      await refresh();
      if (result.failures.length)
        setError(
          result.failures.map((failure) => `${failure.name}: ${failure.message}`).join("\n"),
        );
      const files = result.files;
      notify(
        files.length
          ? t("{count} downloads added to Files.", { count: files.length })
          : t("No new downloads in this session."),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function mutate(end = false) {
    if (busy || loading) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.request<BrowserSession>(
        `/api/browsers/${browser.id}/${end ? "close" : browser.status === "closed" ? "reopen" : "navigate"}`,
        end ? {} : { url: browserAddress(url) },
      );
      setLocal(result);
      setUrl(result.url);
      await refresh();
      if (end) close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title={browserSite(browser.url)}
      embedded={embedded}
      subtitle={t("{control} · {status} · updated {date}", {
        control: browser.control === "human" ? t("You are in control") : t("Watching agent"),
        status: t(browser.status),
        date: timeLabel(browser.updatedAt),
      })}
      onClose={close}
      wide
      scroll={false}
      contentStyle={{ padding: 0 }}
      footer={
        <View style={[s.row, { gap: 10, flexWrap: "wrap" }]}>
          {!loading && browser.status === "active" && browser.consoleUrl && (
            <Button
              small
              icon={ExternalLink}
              onPress={() => void Linking.openURL(api.url(browser.consoleUrl || ""))}
            >
              {t("Open browser in a window")}
            </Button>
          )}
          {!loading && (
            <Button icon={RotateCw} disabled={busy} onPress={() => setRetry(retry + 1)}>
              {t("Refresh connection")}
            </Button>
          )}
          {!loading && browser.status !== "closed" && (
            <Button icon={Download} busy={busy} onPress={() => void importDownloads()}>
              {t("Import downloads")}
            </Button>
          )}
          {!loading && browser.status !== "closed" && (
            <Button icon={X} danger busy={busy} onPress={() => void mutate(true)}>
              {t("Close session")}
            </Button>
          )}
        </View>
      }
    >
      <ScrollView
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ padding: 18 }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[s.row, { gap: 10, marginBottom: 16 }]}>
          <View style={{ flex: 1 }}>
            <Field
              label={t("Website address")}
              value={url}
              onChangeText={setUrl}
              autoCapitalize="none"
              keyboardType="url"
              onSubmitEditing={() => void mutate()}
            />
          </View>
          <Button
            primary
            busy={busy}
            disabled={loading || !url.trim()}
            onPress={() => void mutate()}
          >
            {browser.status === "closed"
              ? t("Reopen")
              : browser.status === "error"
                ? t("Reconnect")
                : t("Go")}
          </Button>
        </View>
        <ErrorNotice error={error} />
        {loading ? (
          <View style={[s.row, { gap: 10, paddingVertical: 24 }]}>
            {error ? (
              <Button onPress={() => setRetry(retry + 1)}>{t("Retry connection")}</Button>
            ) : (
              <>
                <ActivityIndicator color={colors.blueDark} />
                <Text style={s.muted}>{t("Connecting to your browser…")}</Text>
              </>
            )}
          </View>
        ) : browser.status === "active" && browser.consoleUrl ? (
          <BrowserConsole url={api.url(browser.consoleUrl)} height={previewHeight} />
        ) : browser.status === "active" && browser.previewUrl ? (
          <Image
            source={{ uri: api.url(browser.previewUrl) }}
            style={{ width: "100%", height: previewHeight, backgroundColor: colors.canvas }}
            resizeMode="contain"
          />
        ) : (
          <Empty
            icon={Globe2}
            title={
              browser.status === "closed"
                ? t("This session is closed")
                : t("Preview is not available")
            }
            detail={
              browser.status === "closed"
                ? t("Your profile and downloads are saved. Reopen to continue where you left off.")
                : t("Reconnect to continue with your saved browser profile.")
            }
          />
        )}
      </ScrollView>
    </Sheet>
  );
}
