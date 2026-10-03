import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { Artifact, BrowserSession } from "../../../packages/domain/src";
import { useI18n } from "./i18n";
import { FileThreadCard } from "./thread-artifacts";
import { Button, Card, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

export type ConversationFileResource = {
  file: Artifact;
  version: string;
  availableOffline: boolean;
  origins: (
    | { kind: "conversation"; messageId: string; text: string }
    | { kind: "task"; taskId: string; title: string }
    | { kind: "frame"; messageId: string; comment: string }
  )[];
};
export type ConversationFrame = {
  frameId: string;
  sessionGeneration: string;
  width: number;
  height: number;
  mimeType: "image/png" | "image/jpeg";
  image: string;
};
type Library = {
  files: ConversationFileResource[];
  sessions: {
    browser: BrowserSession;
    state: "active" | "offline" | "idle" | "expired";
    taskId: string;
    taskTitle: string;
  }[];
  frameAvailable: boolean;
};

export function ConversationResourceLibrary({
  threadId,
  onAnnotateFile,
  onAnnotateFrame,
}: {
  threadId: string;
  onAnnotateFile: (resource: ConversationFileResource) => void;
  onAnnotateFrame: (frame: ConversationFrame) => void;
}) {
  const { t } = useI18n();
  const { api } = useWorkspace();
  const [library, setLibrary] = useState<Library>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function reload() {
    setLoading(true);
    try {
      const value = await api.request<Library>(`/api/conversations/${threadId}/resources`);
      setLibrary(value);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
  }, [api, threadId]);
  async function markDesktopFrame() {
    setLoading(true);
    try {
      const frame = await api.request<ConversationFrame>(`/api/conversations/${threadId}/frame`);
      onAnnotateFrame(frame);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }
  return (
    <Card style={{ gap: 12, padding: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={[s.heading, { flex: 1 }]}>{t("Files and sessions")}</Text>
        <Button small disabled={loading} onPress={() => void reload()}>
          {t("Refresh")}
        </Button>
      </View>
      <ErrorNotice error={error} />
      {library?.files.map((resource) => (
        <View key={resource.file.id} style={{ gap: 7 }}>
          <FileThreadCard file={resource.file} />
          <Text style={s.small}>
            {resource.availableOffline
              ? t("Published on VPS · available offline")
              : t("Content unavailable")}
            {resource.version ? ` · versão ${resource.version.slice(0, 12)}` : ""}
          </Text>
          {resource.origins.map((origin) => (
            <Text
              key={`${origin.kind}:${origin.kind === "task" ? origin.taskId : origin.messageId}`}
              style={s.muted}
            >
              {origin.kind === "conversation"
                ? t("Attached in conversation · {text}", { text: origin.text.slice(0, 100) })
                : origin.kind === "task"
                  ? t("Task result · {title}", { title: origin.title })
                  : t("Capture marked in message · {comment}", { comment: origin.comment })}
            </Text>
          ))}
          <Button
            small
            disabled={!resource.availableOffline || !resource.version}
            onPress={() => onAnnotateFile(resource)}
          >
            {resource.file.mimeType.startsWith("image/")
              ? t("Mark an image region")
              : t("Quote file")}
          </Button>
        </View>
      ))}
      {library && !library.files.length && (
        <Text style={s.muted}>{t("No files are linked to this conversation yet.")}</Text>
      )}
      {library?.sessions.map(({ browser, state, taskTitle, taskId }) => (
        <View key={`${taskId}:${browser.id}`} style={{ gap: 4, paddingVertical: 7 }}>
          <Text style={s.heading}>{browser.title || browser.url}</Text>
          <Text numberOfLines={1} style={s.muted}>
            {browser.url}
          </Text>
          <Text style={s.small}>
            {state === "expired"
              ? t("Session expired · open a new session to continue")
              : state === "offline"
                ? t("Lenovo offline · files published on the VPS remain available")
                : state === "active"
                  ? t("Active session")
                  : t("Session paused")}
            {` · ${taskTitle}`}
          </Text>
        </View>
      ))}
      {library?.frameAvailable && (
        <Button small disabled={loading} onPress={() => void markDesktopFrame()}>
          {t("Mark a region of the current screen")}
        </Button>
      )}
      {library && !library.sessions.length && !library.frameAvailable && (
        <Text style={s.muted}>{t("No active browser session or connected desktop.")}</Text>
      )}
      {loading && <Text style={s.muted}>{t("Refreshing files and sessions…")}</Text>}
    </Card>
  );
}
