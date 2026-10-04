import { AlertCircle, FileText } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, AppState, ScrollView, Text, View } from "react-native";
import type { Artifact } from "../../../packages/domain/src";
import { fileResultPresentation } from "./file-result-presentation";
import { useI18n } from "./i18n";
import { FileThreadCard } from "./thread-artifacts";
import { Button, Card, ErrorNotice, useUI } from "./ui";
import { useWorkspace } from "./workspace";

export function mediaResult(result: unknown): Record<string, unknown> | undefined {
  if (typeof result === "string") {
    try {
      return mediaResult(JSON.parse(result));
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(result))
    return mediaResult(result.find((part) => part?.type === "text")?.content);
  return result && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
}
export function resultFileIds(value: Record<string, unknown> | undefined): string[] {
  if (!value) return [];
  const ids = [
    typeof value.fileId === "string"
      ? value.fileId
      : typeof value.id === "string" && typeof value.mimeType === "string"
        ? value.id
        : undefined,
    ...(Array.isArray(value.attachments) ? value.attachments.map((part) => part?.fileId) : []),
  ];
  return [
    ...new Set(
      ids.filter((id): id is string => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id)),
    ),
  ];
}
/** Replay resolves by owner-bound ID; expiring signed URLs are never trusted from history. */
export function FileToolCard({ result, loading }: { result: unknown; loading: boolean }) {
  const { colors, s } = useUI();

  const { t } = useI18n();
  const { api } = useWorkspace();
  const value = mediaResult(result);
  const ids = resultFileIds(value).join(",");
  const [fileState, setFileState] = useState<{ owner: string; ids: string; files: Artifact[] }>();
  const files =
    fileState?.owner === api.identityKey && fileState.ids === ids ? fileState.files : [];
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const presentation = fileResultPresentation(value, loading);
  useEffect(() => {
    let active = true;
    setFileState(undefined);
    setError("");
    const hydrate = () => {
      if (ids)
        void Promise.all(
          ids.split(",").map((id) => api.request<Artifact>(`/api/files/${encodeURIComponent(id)}`)),
        )
          .then((files) => {
            if (active) setFileState({ owner: api.identityKey, ids, files });
          })
          .catch((error) => {
            if (active) setError(error instanceof Error ? error.message : String(error));
          });
    };
    hydrate();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") hydrate();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, [api, ids, retry]);
  return (
    <View style={{ gap: 12 }}>
      {files.map((file) => (
        <FileThreadCard key={file.id} file={file} />
      ))}
      {(!files.length || presentation.failure) && (
        <Card
          style={{
            gap: 10,
            padding: 14,
            borderRadius: 18,
            borderWidth: 1,
            borderColor: colors.line,
            maxWidth: 560,
            width: "100%",
          }}
        >
          <View style={[s.row, { gap: 10 }]}>
            {loading ? (
              <ActivityIndicator size="small" color={colors.blueDark} />
            ) : presentation.failure ? (
              <AlertCircle size={18} color={colors.danger} />
            ) : (
              <FileText size={18} color={colors.muted} />
            )}
            <Text style={[s.heading, { flex: 1, fontSize: 14 }]}>{t(presentation.title)}</Text>
          </View>
          {!!presentation.message && (
            <Text selectable numberOfLines={expanded ? undefined : 3} style={s.muted}>
              {presentation.message}
            </Text>
          )}
          {!!ids && !files.length && !error && (
            <Text style={s.small}>{t("Loading your attachment…")}</Text>
          )}
          {(!!presentation.stdout ||
            !!presentation.stderr ||
            !!presentation.command ||
            presentation.exitCode !== undefined ||
            presentation.message.length > 180) && (
            <Button small expanded={expanded} onPress={() => setExpanded(!expanded)}>
              {t(expanded ? "Hide output" : "Show output")}
            </Button>
          )}
          {expanded && (
            <ScrollView
              style={{ maxHeight: 320 }}
              contentContainerStyle={{
                gap: 12,
                padding: 12,
                backgroundColor: colors.subtle,
                borderRadius: 12,
              }}
            >
              {!!presentation.command && (
                <Text selectable style={s.small}>
                  {presentation.command}
                </Text>
              )}
              {!!presentation.stdout && (
                <Text selectable style={s.text}>
                  {presentation.stdout}
                </Text>
              )}
              {!!presentation.stderr && (
                <Text
                  selectable
                  style={[s.text, presentation.failure ? { color: colors.danger } : null]}
                >
                  {presentation.stderr}
                </Text>
              )}
              {presentation.exitCode !== undefined && (
                <Text style={s.small}>
                  {t("Exit code: {code}", { code: presentation.exitCode })}
                </Text>
              )}
            </ScrollView>
          )}
        </Card>
      )}
      <ErrorNotice error={error} />
      {!!error && (
        <Button small onPress={() => setRetry((value) => value + 1)}>
          {t("Reload attachment")}
        </Button>
      )}
    </View>
  );
}
