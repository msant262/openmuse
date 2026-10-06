import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleX,
  Clock3,
  FileText,
  ShieldCheck,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { GoogleMailDraftSummary } from "../../../packages/domain/src/google-mail-draft";
import { googleActionPresentation, withGoogleActionContext } from "./external-action-preview";
import { googleActionStatus } from "./google-workspace-cards";
import { useI18n } from "./i18n";
import { Button, Card, ErrorNotice, useUI } from "./ui";
import { useWorkspace } from "./workspace";

/** Fetch only a page of summaries. Full email contents load when an item is opened. */
export function GoogleActionsScreen({ onOpen }: { onOpen?: () => void } = {}) {
  const { api, workspace, open } = useWorkspace();
  const { t, locale } = useI18n();
  const { s, colors } = useUI();
  const [page, setPage] = useState<{
    owner: string;
    entries: GoogleMailDraftSummary[];
    cursor?: string;
  }>();
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const visible = page?.owner === api.identityKey ? page : undefined;
  const actionRevision = workspace.actions
    .map((action) => `${action.id}:${action.status}`)
    .join("|");
  useEffect(() => {
    let active = true;
    const owner = api.identityKey;
    setBusy(true);
    setError("");
    void api
      .request<{ entries: GoogleMailDraftSummary[]; nextCursor?: string }>(
        "/api/google/mail-drafts",
      )
      .then((result) => {
        if (active) setPage({ owner, entries: result.entries, cursor: result.nextCursor });
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [api, api.identityKey, attempt, actionRevision]);
  async function more() {
    if (!visible?.cursor || busy) return;
    const owner = api.identityKey;
    setBusy(true);
    setError("");
    try {
      const result = await api.request<{ entries: GoogleMailDraftSummary[]; nextCursor?: string }>(
        `/api/google/mail-drafts?cursor=${encodeURIComponent(visible.cursor)}`,
      );
      if (owner === api.identityKey)
        setPage({
          owner,
          entries: [
            ...new Map(
              [...visible.entries, ...result.entries].map((draft) => [draft.id, draft]),
            ).values(),
          ],
          cursor: result.nextCursor,
        });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const linked = new Set(visible?.entries.map((draft) => draft.actionId));
  const allRows = [
    ...(visible?.entries ?? []).map((draft) => ({
      id: `draft:${draft.id}`,
      date: draft.updatedAt,
      title: draft.subject,
      verb: "Email draft",
      account: draft.account,
      status: draft.status,
      detail: draft.to.join(", "),
      show: () => open({ type: "gmailDraft", id: draft.id }),
    })),
    ...workspace.actions
      .filter((action) => !linked.has(action.id))
      .map((action) => {
        const view = googleActionPresentation(
          withGoogleActionContext(action, workspace.actions),
          locale,
        );
        return {
          id: `action:${action.id}`,
          date: action.createdAt,
          title: view.item ?? t(view.service),
          verb: view.verb,
          account: view.account,
          status: action.status,
          detail:
            view.fields.find((field) => field.label === "Starts")?.value ?? view.preview ?? "",
          show: () => open({ type: "review", action }),
        };
      }),
  ];
  const pendingCount = allRows.filter((row) => row.status === "awaiting_review").length;
  const rows = allRows
    .filter(
      (row) =>
        filter === "all" ||
        (filter === "pending"
          ? row.status === "awaiting_review"
          : !["awaiting_review", "executing"].includes(row.status)),
    )
    .sort((a, b) => b.date.localeCompare(a.date));
  return (
    <View style={{ gap: 12 }}>
      <Text style={s.heading}>{t("Actions")}</Text>
      <Text style={s.small}>
        {t("Drafts, approvals and completed actions. Open an item to see its details.")}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <Button small primary={filter === "all"} onPress={() => setFilter("all")}>
          {t("All")}
        </Button>
        <Button small primary={filter === "pending"} onPress={() => setFilter("pending")}>
          {t("Needs review")} ({pendingCount})
        </Button>
        <Button small primary={filter === "history"} onPress={() => setFilter("history")}>
          {t("History")}
        </Button>
        <Button small disabled={busy} onPress={() => setAttempt((value) => value + 1)}>
          {t("Refresh")}
        </Button>
      </View>
      <ErrorNotice error={error} />
      {busy && !visible && <Text style={s.small}>{t("Loading actions…")}</Text>}
      {rows.map((row) => {
        const pending = row.status === "awaiting_review";
        const succeeded = ["succeeded", "saved", "sent"].includes(row.status);
        const failed = ["failed", "outcome_unknown"].includes(row.status);
        const color = pending
          ? colors.warning
          : succeeded
            ? colors.success
            : failed
              ? colors.danger
              : colors.muted;
        const StatusIcon = pending
          ? ShieldCheck
          : succeeded
            ? CheckCircle2
            : failed
              ? CircleAlert
              : row.status === "executing"
                ? Clock3
                : ["denied", "cancelled"].includes(row.status)
                  ? CircleX
                  : FileText;
        return (
          <Pressable
            key={row.id}
            accessibilityRole="button"
            accessibilityLabel={`${t(row.verb)} · ${row.title}`}
            onPress={() => {
              onOpen?.();
              row.show();
            }}
          >
            <Card
              style={{
                padding: 14,
                gap: 9,
                borderRadius: 15,
                borderWidth: 1,
                borderColor: row.status === "awaiting_review" ? colors.accent : colors.line,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                <StatusIcon size={15} color={color} />
                <Text style={[s.small, { color, fontWeight: "600", flex: 1 }]}>
                  {t(googleActionStatus(row.status))}
                </Text>
                <ChevronRight size={14} color={colors.muted} />
              </View>
              <View style={{ gap: 4 }}>
                <Text style={[s.small, { fontWeight: "600" }]}>{t(row.verb)}</Text>
                <Text numberOfLines={2} style={[s.heading, { fontSize: 14, lineHeight: 20 }]}>
                  {row.title}
                </Text>
              </View>
              <Text numberOfLines={1} style={[s.small, { fontSize: 12 }]}>
                {row.account}
              </Text>
              {!!row.detail && (
                <Text numberOfLines={1} style={s.small}>
                  {row.id.startsWith("draft:") ? `${t("To")}: ` : ""}
                  {row.detail}
                </Text>
              )}
              <Text style={s.small}>
                {new Date(row.date).toLocaleString(locale, {
                  day: "2-digit",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </Text>
            </Card>
          </Pressable>
        );
      })}
      {!busy && !rows.length && <Text style={s.small}>{t("No actions here yet.")}</Text>}
      {!!visible?.cursor && (
        <Button small busy={busy} onPress={() => void more()}>
          {t("Show more actions")}
        </Button>
      )}
    </View>
  );
}
