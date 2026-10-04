import { FileText, Image as ImageIcon, Music2, Video } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Image, Pressable, Text, useWindowDimensions, View } from "react-native";
import type { Artifact, BrowserSession } from "../../../packages/domain/src";
import type { AgentArtifact, AgentTask } from "../../../packages/domain/src/agent";
import { ArtifactCard, TaskCard } from "./agent-ui";
import { localizedAttachmentLabel } from "./attachment-ui-copy";
import { BrowserThreadCard } from "./computer";
import { useI18n } from "./i18n";
import { ResultCardFooter, ResultCardFrame } from "./result-card-frame";
import { Button, ErrorNotice, useUI } from "./ui";
import { useWorkspace } from "./workspace";

export function FileThreadCard({ file }: { file: Artifact }) {
  const { colors, s } = useUI();

  const { t } = useI18n();
  const { open, api } = useWorkspace();
  const { width } = useWindowDimensions();
  const [imageState, setImageState] = useState({ url: file.url, ratio: 1.5, failed: false });
  const state =
    imageState.url === file.url ? imageState : { url: file.url, ratio: 1.5, failed: false };
  const isImage = file.mimeType.startsWith("image/");
  const isVideo = file.mimeType.startsWith("video/");
  const isAudio = file.mimeType.startsWith("audio/");
  const fields = file.fields?.filter((field) => field.value.trim()).slice(0, 3) ?? [];
  const Icon = isImage ? ImageIcon : isVideo ? Video : isAudio ? Music2 : FileText;
  const action = t(
    isImage ? "View image" : isVideo || isAudio ? "Open attachment" : "Open document",
  );
  return (
    <ResultCardFrame>
      {isImage && !state.failed ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${action}: ${file.name}`}
          onPress={() => open({ type: "file", file })}
        >
          <Image
            accessible
            accessibilityLabel={file.name}
            source={{ uri: api.url(file.url) }}
            style={{
              width: "100%",
              height: Math.min(300, Math.max(96, Math.min(558, width - 56) / state.ratio)),
              backgroundColor: colors.subtle,
            }}
            resizeMode="contain"
            onLoad={(event) => {
              const source = event.nativeEvent.source;
              if (source?.width > 0 && source?.height > 0)
                setImageState({
                  url: file.url,
                  ratio: source.width / source.height,
                  failed: false,
                });
            }}
            onError={() => setImageState({ ...state, failed: true })}
          />
        </Pressable>
      ) : fields.length ? (
        <View style={{ padding: 22, gap: 15, backgroundColor: colors.subtle }}>
          {fields.map((field) => (
            <View key={field.name} style={{ gap: 4 }}>
              <Text style={s.small}>{field.name.replace(/_/g, " ")}</Text>
              <Text numberOfLines={2} selectable style={s.text}>
                {field.value}
              </Text>
            </View>
          ))}
          {(file.fields?.length ?? 0) > fields.length && (
            <Text style={s.small}>{t("Open the document to see all fields.")}</Text>
          )}
        </View>
      ) : null}
      {isImage && state.failed && (
        <Text style={[s.small, { padding: 16, paddingBottom: 0 }]}>
          {t("Preview unavailable. Open the attachment to view it.")}
        </Text>
      )}
      <ResultCardFooter
        title={file.name}
        subtitle={localizedAttachmentLabel(file, t)}
        action={action}
        icon={Icon}
        onPress={() => open({ type: "file", file })}
      />
    </ResultCardFrame>
  );
}
/** Hydrates task-linked artifacts by ID on replay; signed URLs are never stored in messages. */
export function TaskThreadCard({ task }: { task: AgentTask }) {
  const { t } = useI18n();
  const { api } = useWorkspace();
  const [detail, setDetail] = useState<{
    owner: string;
    taskId: string;
    artifacts: AgentArtifact[];
    files: Artifact[];
    browsers: BrowserSession[];
  }>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [showFiles, setShowFiles] = useState(false);
  useEffect(() => {
    let active = true;
    setDetail(undefined);
    setError("");
    void api
      .request<{ artifacts: AgentArtifact[]; files: Artifact[]; browsers: BrowserSession[] }>(
        `/api/agent/tasks/${task.id}`,
      )
      .then((result) => {
        if (active) {
          setDetail({ ...result, owner: api.identityKey, taskId: task.id });
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [api, task.id, task.updatedAt, attempt]);
  const visibleDetail =
    detail?.owner === api.identityKey && detail.taskId === task.id ? detail : undefined;
  const files = [...(visibleDetail?.files || [])].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  return (
    <View style={{ gap: 12 }}>
      <TaskCard task={task} compact />
      {visibleDetail?.browsers.map((browser) => (
        <BrowserThreadCard key={browser.id} browser={browser} />
      ))}
      {files.slice(0, showFiles ? undefined : 1).map((file) => (
        <FileThreadCard key={file.id} file={file} />
      ))}
      {files.length > 1 && (
        <Button small expanded={showFiles} onPress={() => setShowFiles(!showFiles)}>
          {showFiles
            ? t("Hide additional files")
            : t("View all {count} files", { count: files.length })}
        </Button>
      )}
      {visibleDetail?.artifacts.map((artifact) => (
        <ArtifactCard key={artifact.id} artifact={artifact} />
      ))}
      <ErrorNotice error={error} />
      {!!error && (
        <Button small onPress={() => setAttempt((value) => value + 1)}>
          {t("Reload task results")}
        </Button>
      )}
    </View>
  );
}
