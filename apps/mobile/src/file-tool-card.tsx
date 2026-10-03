import { useEffect, useState } from "react";
import { ActivityIndicator, AppState, Text, View } from "react-native";
import type { Artifact } from "../../../packages/domain/src";
import { useI18n } from "./i18n";
import { FileThreadCard } from "./thread-artifacts";
import { Button, Card, colors, ErrorNotice, s } from "./ui";
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
  const { t } = useI18n();
  const { api } = useWorkspace();
  const value = mediaResult(result);
  const ids = resultFileIds(value).join(",");
  const [files, setFiles] = useState<Artifact[]>([]);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setFiles([]);
    setError("");
    const hydrate = () => {
      if (ids)
        void Promise.all(
          ids.split(",").map((id) => api.request<Artifact>(`/api/files/${encodeURIComponent(id)}`)),
        )
          .then((files) => {
            if (active) setFiles(files);
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
      {!files.length && (
        <Card style={{ gap: 10 }}>
          {loading ? <ActivityIndicator color={colors.blueDark} /> : null}
          <Text style={s.heading}>
            {loading
              ? t("Working on your computer…")
              : value?.status === "running"
                ? t("Job running")
                : value?.disabled
                  ? t("Tool unavailable")
                  : value?.error
                    ? t("Needs attention")
                    : t("Computer result")}
          </Text>
          <Text selectable style={s.muted}>
            {String(
              value?.message ??
                value?.error ??
                value?.status ??
                (ids ? t("Loading your attachment…") : t("Result saved in your workspace.")),
            )}
          </Text>
          {typeof value?.stdout === "string" && !!value.stdout && (
            <Text selectable style={s.small}>
              {value.stdout.slice(0, 3000)}
            </Text>
          )}
          {typeof value?.stderr === "string" && !!value.stderr && (
            <Text selectable style={s.small}>
              {value.stderr.slice(0, 3000)}
            </Text>
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
