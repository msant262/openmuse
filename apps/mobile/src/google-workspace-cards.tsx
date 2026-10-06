import * as Crypto from "expo-crypto";
import { CheckCircle2, CircleX, Clock3, ShieldCheck } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Clipboard, Linking, Platform, Text, View } from "react-native";
import type { ActionDetails, ActionProposal } from "../../../packages/domain/src";
import type { GoogleMailDraft } from "../../../packages/domain/src/google-mail-draft";
import { googleActionPresentation, withGoogleActionContext } from "./external-action-preview";
import { useI18n } from "./i18n";
import { Button, Card, ErrorNotice, useUI } from "./ui";
import { useWorkspace } from "./workspace";

export function googleActionStatus(status: string) {
  return (
    (
      {
        saved: "Saved in Gmail",
        sent: "Sent",
        deleted: "Deleted",
        succeeded: "Completed",
        denied: "Declined",
        cancelled: "Cancelled",
        expired: "Expired",
        failed: "Failed",
        awaiting_review: "Waiting for your approval",
        executing: "In progress",
        outcome_unknown: "Result uncertain",
      } as Record<string, string>
    )[status] ?? status.replace(/_/g, " ")
  );
}

/** A click approves this exact server proposal; mounting a card never executes it. */
export function GoogleApprovalCard({
  action,
  onAnswered,
  presentation = "inline",
}: {
  action: ActionProposal;
  onAnswered?: () => Promise<void>;
  presentation?: "inline" | "detail";
}) {
  const { api, refresh, open, workspace } = useWorkspace();
  const { t, locale } = useI18n();
  const { s, colors } = useUI();
  const [answer, setAnswer] = useState<ActionProposal>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [technical, setTechnical] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState<{ owner: string; id: string; value: ActionDetails }>();
  const [contextError, setContextError] = useState("");
  const [contextAttempt, setContextAttempt] = useState(0);
  const lock = useRef(false);
  const observed = workspace?.actions.find((item) => item.id === action.id);
  const current =
    observed && observed.status !== "awaiting_review"
      ? observed
      : answer?.id === action.id
        ? answer
        : action;
  const showDetails = presentation === "detail" || expanded || current.status === "awaiting_review";
  const loaded =
    details?.owner === api.identityKey && details.id === current.id ? details.value : undefined;
  const origin = loaded?.origin;
  useEffect(() => {
    if (!showDetails) return;
    let active = true;
    const owner = api.identityKey;
    const id = current.id;
    setContextError("");
    void api
      .request<ActionDetails>(`/api/actions/${encodeURIComponent(id)}/details`)
      .then((value) => {
        if (active) setDetails({ owner, id, value });
      })
      .catch(() => {
        if (active) setContextError("Could not load the original request.");
      });
    return () => {
      active = false;
    };
  }, [api, api.identityKey, current.id, current.status, showDetails, contextAttempt]);
  const view = googleActionPresentation(
    withGoogleActionContext(current, workspace?.actions ?? []),
    locale,
  );
  const deletion = view.deletion;
  const pending = current.status === "awaiting_review";
  const color = pending
    ? colors.warning
    : current.status === "succeeded"
      ? colors.success
      : current.status === "failed"
        ? colors.danger
        : colors.muted;
  const StatusIcon = pending
    ? ShieldCheck
    : current.status === "succeeded"
      ? CheckCircle2
      : ["executing", "outcome_unknown"].includes(current.status)
        ? Clock3
        : CircleX;
  async function decide(decision: "approve" | "deny") {
    if (lock.current || !pending) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api.request<ActionProposal>(`/api/actions/${current.id}/decide`, {
        hash: current.hash,
        decision,
      });
      setAnswer(result);
      setExpanded(false);
      setTechnical(false);
      await onAnswered?.();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  if (presentation === "inline" && !pending && !expanded && !error)
    return (
      <Card style={{ gap: 6, paddingVertical: 12 }}>
        <Text numberOfLines={1} style={s.heading}>
          {view.item ?? t(view.verb)}
        </Text>
        <Text style={s.small}>
          {t(view.verb)} · {t(googleActionStatus(current.status))}
        </Text>
        <ErrorNotice error={current.error} />
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <Button small onPress={() => setExpanded(true)}>
            {t("View details")}
          </Button>
          <Button small onPress={() => open({ type: "actions" })}>
            {t("Actions")}
          </Button>
        </View>
      </Card>
    );
  return (
    <Card
      style={{
        gap: 20,
        padding: presentation === "detail" ? 0 : 20,
        borderWidth: presentation === "detail" ? 0 : 1,
        borderColor: pending && deletion ? colors.danger : colors.line,
      }}
    >
      <View style={{ gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <StatusIcon size={18} color={color} />
          <Text style={[s.text, { color, fontWeight: "600" }]}>
            {t(googleActionStatus(current.status))}
          </Text>
        </View>
        {presentation === "inline" && <Text style={s.heading}>{t(view.verb)}</Text>}
        <Text selectable style={[s.title, { fontSize: 22 }]}>
          {view.item ?? t(view.service)}
        </Text>
        <View style={{ gap: 3 }}>
          <Text style={s.small}>{t("Where")}</Text>
          <Text style={s.text}>
            {t(view.storage)}
            {view.storage !== view.service ? ` · ${t(view.service)}` : ""}
          </Text>
          <Text selectable style={s.text}>
            {view.account || t("Account not specified")}
          </Text>
          <Text style={s.small}>
            {t("Recorded at")} {new Date(current.createdAt).toLocaleString(locale)}
          </Text>
        </View>
        {!!view.resourceUrl && !(view.deletion && current.status === "succeeded") && (
          <Button
            primary
            onPress={() => {
              if (!view.resourceUrl) return;
              void Linking.openURL(view.resourceUrl).catch(() =>
                setError(t("Could not open this item. Try again.")),
              );
            }}
          >
            {t(view.openLabel)}
          </Button>
        )}
      </View>
      {!!view.outcome && (
        <View
          style={{
            backgroundColor: pending
              ? colors.orange
              : current.status === "succeeded"
                ? colors.green
                : colors.subtle,
            padding: 14,
            borderRadius: 12,
          }}
        >
          <Text style={s.text}>{t(view.outcome)}</Text>
        </View>
      )}
      {!!view.fields.length && (
        <View
          style={{
            gap: 14,
            paddingVertical: 14,
            borderTopWidth: 1,
            borderBottomWidth: 1,
            borderColor: colors.line,
          }}
        >
          {view.fields.map((line) => (
            <View key={line.label} style={{ gap: 4 }}>
              <Text style={s.small}>{t(line.label)}</Text>
              <Text selectable style={s.text}>
                {line.value}
              </Text>
            </View>
          ))}
        </View>
      )}
      {!!view.changes.length && (
        <View style={{ gap: 12 }}>
          <Text style={s.heading}>
            {t(current.status === "succeeded" ? "Recorded changes" : "Proposed changes")}
          </Text>
          {view.changes.map((change) => (
            <View key={`${change.label}:${change.value ?? ""}`} style={{ gap: 5 }}>
              <Text style={s.small}>{t(change.label)}</Text>
              {!!change.value && (
                <Text selectable style={s.text}>
                  {change.value}
                </Text>
              )}
            </View>
          ))}
        </View>
      )}
      {!!view.preview && !view.changes.some((change) => change.value === view.preview) && (
        <View style={{ gap: 7 }}>
          <Text style={s.small}>{t("Content")}</Text>
          <Text selectable style={s.text}>
            {view.preview}
          </Text>
        </View>
      )}
      {showDetails && (
        <View style={{ gap: 9, paddingTop: 16, borderTopWidth: 1, borderColor: colors.line }}>
          <Text style={s.heading}>{t("Why this action was prepared")}</Text>
          {origin ? (
            <>
              <Text style={s.small}>{t("Your request")}</Text>
              <Text selectable style={s.text}>
                {origin.request}
              </Text>
              {loaded.taskAvailable && (
                <Button small onPress={() => open({ type: "task", taskId: origin.taskId })}>
                  {t("View original task")}
                </Button>
              )}
            </>
          ) : loaded ? (
            <Text style={s.muted}>
              {t("The original request was not recorded for this action.")}
            </Text>
          ) : contextError ? (
            <>
              <Text style={s.muted}>{t(contextError)}</Text>
              <Button small onPress={() => setContextAttempt((value) => value + 1)}>
                {t("Try again")}
              </Button>
            </>
          ) : (
            <Text style={s.muted}>{t("Loading original request…")}</Text>
          )}
        </View>
      )}
      {pending && (
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <Button small disabled={busy} onPress={() => void decide("deny")}>
            {t("Deny")}
          </Button>
          <Button
            small
            danger={deletion}
            primary={!deletion}
            busy={busy}
            onPress={() => void decide("approve")}
          >
            {t(deletion ? "Approve deletion" : "Approve change")}
          </Button>
        </View>
      )}
      <Button small expanded={technical} onPress={() => setTechnical(!technical)}>
        {t(technical ? "Hide technical details" : "Show technical details")}
      </Button>
      {technical && (
        <Text selectable style={s.small}>
          {JSON.stringify(current.data, null, 2)}
        </Text>
      )}
      <ErrorNotice error={error || current.error} />
      {presentation === "inline" && !pending && (
        <Button
          small
          onPress={() => {
            setExpanded(false);
            setTechnical(false);
          }}
        >
          {t("Collapse")}
        </Button>
      )}
    </Card>
  );
}

/** The sender, contents and remote draft ID come from an owner-scoped server record. */
export function GoogleMailDraftCard({
  id,
  initialExpanded = false,
}: {
  id: string;
  initialExpanded?: boolean;
}) {
  const { api, refresh, open, workspace } = useWorkspace();
  const { t } = useI18n();
  const { s } = useUI();
  const [record, setRecord] = useState<{
    owner: string;
    draft: GoogleMailDraft;
    action?: ActionProposal;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [presentation, setPresentation] = useState<{ key: string; expanded: boolean }>();
  const lock = useRef(false);
  const intent = useRef<
    { owner: string; id: string; operation: string; operationId: string } | undefined
  >(undefined);
  const draft =
    record?.owner === api.identityKey && record.draft.id === id ? record.draft : undefined;
  const key = `${api.identityKey}:${id}`;
  const expanded =
    presentation?.key === key ? presentation.expanded : initialExpanded || !draft?.collapsed;
  const observedStatus = draft?.actionId
    ? workspace?.actions.find((item) => item.id === draft.actionId)?.status
    : undefined;
  async function load() {
    const owner = api.identityKey;
    const next = await api.request<GoogleMailDraft>(`/api/google/mail-drafts/${id}`);
    const action =
      next.actionId && next.status === "awaiting_review"
        ? await api.request<ActionProposal>(`/api/actions/${next.actionId}`)
        : undefined;
    if (owner === api.identityKey) setRecord({ owner, draft: next, action });
  }
  useEffect(() => {
    let active = true;
    const owner = api.identityKey;
    setError("");
    void api
      .request<GoogleMailDraft>(`/api/google/mail-drafts/${id}`)
      .then(async (next) => {
        const action =
          next.actionId && next.status === "awaiting_review"
            ? await api.request<ActionProposal>(`/api/actions/${next.actionId}`)
            : undefined;
        if (active) setRecord({ owner, draft: next, action });
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [api, api.identityKey, id, attempt, observedStatus]);
  async function operate(operation: "save" | "send" | "delete") {
    if (lock.current || !draft) return;
    lock.current = true;
    setBusy(true);
    setError("");
    if (
      intent.current?.owner !== api.identityKey ||
      intent.current.id !== id ||
      intent.current.operation !== operation
    )
      intent.current = { owner: api.identityKey, id, operation, operationId: Crypto.randomUUID() };
    try {
      await api.request(`/api/google/mail-drafts/${id}`, {
        operation,
        operationId: intent.current.operationId,
      });
      await load();
      setPresentation({ key, expanded: false });
      intent.current = undefined;
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function copy() {
    if (!draft) return;
    setError("");
    const text = `${t("From")}: ${draft.account}\n${t("To")}: ${draft.draft.to.join(", ")}\n${draft.draft.cc.length ? `Cc: ${draft.draft.cc.join(", ")}\n` : ""}${draft.draft.bcc.length ? `Bcc: ${draft.draft.bcc.join(", ")}\n` : ""}${t("Subject")}: ${draft.draft.subject}\n\n${draft.draft.body}`;
    try {
      if (Platform.OS !== "web") Clipboard.setString(text);
      else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const field = document.createElement("textarea");
        field.value = text;
        field.style.position = "fixed";
        field.style.opacity = "0";
        document.body.append(field);
        field.select();
        const copied = document.execCommand("copy");
        field.remove();
        if (!copied) throw new Error(t("Clipboard unavailable"));
      }
      setCopied(true);
      setPresentation({ key, expanded: false });
      await api.request(`/api/google/mail-drafts/${id}/collapse`, {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  const pending =
    !!draft && ["awaiting_review", "executing", "outcome_unknown"].includes(draft.status);
  const terminal = !!draft && ["sent", "deleted"].includes(draft.status);
  return (
    <Card style={{ gap: expanded ? 14 : 6, paddingVertical: expanded ? 20 : 12 }}>
      <Text numberOfLines={expanded ? undefined : 1} style={s.heading}>
        {expanded || !draft ? t("Gmail draft") : draft.draft.subject}
      </Text>
      {!draft && !error && <Text style={s.small}>{t("Loading draft…")}</Text>}
      {draft && (
        <>
          <Text style={s.small}>
            {t(copied && draft.status === "saved" ? "Copied" : googleActionStatus(draft.status))}
          </Text>
          {!expanded && (
            <>
              <Text numberOfLines={1} style={s.small}>
                {draft.account} → {draft.draft.to.join(", ")}
              </Text>
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                <Button small onPress={() => setPresentation({ key, expanded: true })}>
                  {t("View draft")}
                </Button>
                <Button small onPress={() => open({ type: "actions" })}>
                  {t("Actions")}
                </Button>
              </View>
            </>
          )}
          {expanded && (
            <>
              <View style={{ gap: 8 }}>
                {[
                  ["From", draft.account],
                  ["To", draft.draft.to.join(", ")],
                  ["Cc", draft.draft.cc.join(", ")],
                  ["Bcc", draft.draft.bcc.join(", ")],
                  ["Subject", draft.draft.subject],
                ]
                  .filter(([, value]) => !!value)
                  .map(([label, value]) => (
                    <View key={label} style={{ gap: 3 }}>
                      <Text style={s.small}>{t(label)}</Text>
                      <Text selectable style={s.text}>
                        {value}
                      </Text>
                    </View>
                  ))}
              </View>
              <View style={s.divider} />
              <Text selectable style={[s.text, { lineHeight: 24 }]}>
                {draft.draft.body}
              </Text>
              {!!draft.draft.attachmentIds.length && (
                <Text style={s.small}>
                  {t("Attachments")}: {draft.draft.attachmentIds.length}
                </Text>
              )}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                <Button
                  small
                  primary
                  disabled={busy || pending || terminal}
                  onPress={() => void operate("send")}
                >
                  {t("Send")}
                </Button>
                <Button small disabled={busy} onPress={() => void copy()}>
                  {t(copied ? "Copied" : "Copy")}
                </Button>
                <Button
                  small
                  disabled={busy || pending || terminal}
                  onPress={() => void operate("save")}
                >
                  {t("Save draft")}
                </Button>
                <Button
                  small
                  danger
                  disabled={busy || pending || terminal}
                  onPress={() => void operate("delete")}
                >
                  {t("Delete")}
                </Button>
              </View>
              <Button
                small
                onPress={() => {
                  setPresentation({ key, expanded: false });
                  void api
                    .request(`/api/google/mail-drafts/${id}/collapse`, {})
                    .catch((e) => setError(e instanceof Error ? e.message : String(e)));
                }}
              >
                {t("Collapse")}
              </Button>
            </>
          )}
          {draft.status === "outcome_unknown" && (
            <Text style={s.small}>
              {t("The result is uncertain. Check Gmail before attempting another change.")}
            </Text>
          )}
          {record?.action && <GoogleApprovalCard action={record.action} onAnswered={load} />}
        </>
      )}
      <ErrorNotice error={error} />
      {!!error && (
        <Button small disabled={busy} onPress={() => setAttempt((value) => value + 1)}>
          {t("Reload draft")}
        </Button>
      )}
    </Card>
  );
}
