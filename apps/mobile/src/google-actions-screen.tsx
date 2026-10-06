import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { GoogleMailDraftSummary } from "../../../packages/domain/src/google-mail-draft";
import { connectorReviewLines } from "./external-action-preview";
import { googleActionStatus } from "./google-workspace-cards";
import { useI18n } from "./i18n";
import { Button, Card, ErrorNotice, useUI } from "./ui";
import { useWorkspace } from "./workspace";

/** Fetch only a page of summaries. Full email contents load when an item is opened. */
export function GoogleActionsScreen({ onOpen }: { onOpen?: () => void } = {}) {
  const { api, workspace, open } = useWorkspace();
  const { t } = useI18n();
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
  const rows = [
    ...(visible?.entries ?? []).map((draft) => ({
      id: `draft:${draft.id}`,
      date: draft.updatedAt,
      title: draft.subject,
      account: draft.account,
      status: draft.status,
      detail: draft.to.join(", "),
      show: () => open({ type: "gmailDraft", id: draft.id }),
    })),
    ...workspace.actions
      .filter((action) => !linked.has(action.id))
      .map((action) => {
        const lines = connectorReviewLines(action.data);
        const target = lines.find((line) => ["Subject", "Item"].includes(line.label))?.value;
        const verb = lines.find((line) => line.label === "Action")?.value;
        const service = lines.find((line) => line.label === "Service")?.value;
        return {
          id: `action:${action.id}`,
          date: action.createdAt,
          title: target
            ? `${t(verb ?? "Review action")} · ${target}`
            : service
              ? `${t(service)} · ${t(verb ?? "Review action")}`
              : action.title,
          account: String(action.data.account ?? action.account ?? ""),
          status: action.status,
          detail: "",
          show: () => open({ type: "review", action }),
        };
      }),
  ]
    .filter((row) => filter === "all" || row.status === "awaiting_review")
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
          {t("Needs review")}
        </Button>
        <Button small disabled={busy} onPress={() => setAttempt((value) => value + 1)}>
          {t("Refresh")}
        </Button>
      </View>
      <ErrorNotice error={error} />
      {busy && !visible && <Text style={s.small}>{t("Loading actions…")}</Text>}
      {rows.map((row) => (
        <Pressable
          key={row.id}
          accessibilityRole="button"
          accessibilityLabel={row.title}
          onPress={() => {
            onOpen?.();
            row.show();
          }}
        >
          <Card
            style={{
              padding: 12,
              gap: 5,
              borderWidth: 1,
              borderColor: row.status === "awaiting_review" ? colors.accent : colors.line,
            }}
          >
            <Text numberOfLines={2} style={s.heading}>
              {row.title}
            </Text>
            <Text numberOfLines={1} style={s.small}>
              {row.account}
            </Text>
            {!!row.detail && (
              <Text numberOfLines={1} style={s.small}>
                {t("To")}: {row.detail}
              </Text>
            )}
            <Text style={s.small}>{t(googleActionStatus(row.status))}</Text>
          </Card>
        </Pressable>
      ))}
      {!busy && !rows.length && <Text style={s.small}>{t("No actions here yet.")}</Text>}
      {!!visible?.cursor && (
        <Button small busy={busy} onPress={() => void more()}>
          {t("Show more actions")}
        </Button>
      )}
    </View>
  );
}
