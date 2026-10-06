import * as Crypto from "expo-crypto";
import { useEffect, useRef, useState } from "react";
import { Clipboard, Platform, Text, View } from "react-native";
import type { ActionProposal } from "../../../packages/domain/src";
import type { GoogleMailDraft } from "../../../packages/domain/src/google-mail-draft";
import { connectorReviewLines } from "./external-action-preview";
import { useI18n } from "./i18n";
import { Button, Card, ErrorNotice, useUI } from "./ui";
import { useWorkspace } from "./workspace";

/** A click approves this exact server proposal; mounting a card never executes it. */
export function GoogleApprovalCard({
  action,
  onAnswered,
}: {
  action: ActionProposal;
  onAnswered?: () => Promise<void>;
}) {
  const { api, refresh } = useWorkspace();
  const { t } = useI18n();
  const { s, colors } = useUI();
  const [answer, setAnswer] = useState<ActionProposal>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [technical, setTechnical] = useState(false);
  const lock = useRef(false);
  const current = answer?.id === action.id ? answer : action;
  const deletion =
    current.data.requiresHumanApproval === true || current.kind === "calendar.delete";
  const pending = current.status === "awaiting_review";
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
      await onAnswered?.();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Card style={{ gap: 14, borderWidth: 1, borderColor: deletion ? colors.danger : colors.line }}>
      <Text style={s.heading}>{t(deletion ? "Confirm deletion" : "Review action")}</Text>
      <Text style={s.small}>
        {t(pending ? "Waiting for your approval" : current.status.replace(/_/g, " "))}
      </Text>
      {connectorReviewLines(current.data).map((line) => (
        <View key={line.label} style={{ gap: 4 }}>
          <Text style={s.small}>{t(line.label)}</Text>
          <Text selectable style={s.text}>
            {t(line.value)}
          </Text>
        </View>
      ))}
      {current.kind === "calendar.delete" && (
        <>
          <Text selectable style={s.text}>
            {current.account}
          </Text>
          <Text selectable style={s.text}>
            {String(current.data.title ?? current.title)}
          </Text>
        </>
      )}
      <Text style={s.small}>
        {t(
          deletion
            ? "This removes the selected item from the account shown above. Nothing is deleted until you approve."
            : "Your approval applies only to the details shown above.",
        )}
      </Text>
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
    </Card>
  );
}

/** The sender, contents and remote draft ID come from an owner-scoped server record. */
export function GoogleMailDraftCard({ id }: { id: string }) {
  const { api, refresh } = useWorkspace();
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
  const lock = useRef(false);
  const intent = useRef<
    { owner: string; id: string; operation: string; operationId: string } | undefined
  >(undefined);
  const draft =
    record?.owner === api.identityKey && record.draft.id === id ? record.draft : undefined;
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
  }, [api, api.identityKey, id, attempt]);
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  const pending =
    !!draft && ["awaiting_review", "executing", "outcome_unknown"].includes(draft.status);
  const terminal = !!draft && ["sent", "deleted"].includes(draft.status);
  return (
    <Card style={{ gap: 14 }}>
      <Text style={s.heading}>{t("Gmail draft")}</Text>
      {!draft && !error && <Text style={s.small}>{t("Loading draft…")}</Text>}
      {draft && (
        <>
          <Text style={s.small}>
            {t(
              draft.status === "saved"
                ? "Saved in Gmail"
                : draft.status === "sent"
                  ? "Sent"
                  : draft.status === "deleted"
                    ? "Deleted"
                    : draft.status.replace(/_/g, " "),
            )}
          </Text>
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
