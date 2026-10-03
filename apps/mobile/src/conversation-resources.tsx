import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { Artifact, BrowserSession } from "../../../packages/domain/src";
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
        <Text style={[s.heading, { flex: 1 }]}>Arquivos e sessões</Text>
        <Button small disabled={loading} onPress={() => void reload()}>
          Atualizar
        </Button>
      </View>
      <ErrorNotice error={error} />
      {library?.files.map((resource) => (
        <View key={resource.file.id} style={{ gap: 7 }}>
          <FileThreadCard file={resource.file} />
          <Text style={s.small}>
            {resource.availableOffline
              ? "Publicado no VPS · disponível offline"
              : "Conteúdo indisponível"}
            {resource.version ? ` · versão ${resource.version.slice(0, 12)}` : ""}
          </Text>
          {resource.origins.map((origin) => (
            <Text
              key={`${origin.kind}:${origin.kind === "task" ? origin.taskId : origin.messageId}`}
              style={s.muted}
            >
              {origin.kind === "conversation"
                ? `Anexado na conversa · ${origin.text.slice(0, 100)}`
                : origin.kind === "task"
                  ? `Resultado da tarefa · ${origin.title}`
                  : `Captura marcada na mensagem · ${origin.comment}`}
            </Text>
          ))}
          <Button
            small
            disabled={!resource.availableOffline || !resource.version}
            onPress={() => onAnnotateFile(resource)}
          >
            {resource.file.mimeType.startsWith("image/")
              ? "Marcar região da imagem"
              : "Citar arquivo"}
          </Button>
        </View>
      ))}
      {library && !library.files.length && (
        <Text style={s.muted}>Nenhum arquivo ligado a esta conversa ainda.</Text>
      )}
      {library?.sessions.map(({ browser, state, taskTitle, taskId }) => (
        <View key={`${taskId}:${browser.id}`} style={{ gap: 4, paddingVertical: 7 }}>
          <Text style={s.heading}>{browser.title || browser.url}</Text>
          <Text numberOfLines={1} style={s.muted}>
            {browser.url}
          </Text>
          <Text style={s.small}>
            {state === "expired"
              ? "Sessão expirada · abra uma nova sessão para continuar"
              : state === "offline"
                ? "Lenovo offline · arquivos publicados no VPS continuam disponíveis"
                : state === "active"
                  ? "Sessão ativa"
                  : "Sessão em pausa"}
            {` · ${taskTitle}`}
          </Text>
        </View>
      ))}
      {library?.frameAvailable && (
        <Button small disabled={loading} onPress={() => void markDesktopFrame()}>
          Marcar região da tela atual
        </Button>
      )}
      {library && !library.sessions.length && !library.frameAvailable && (
        <Text style={s.muted}>Nenhuma sessão de navegador ativa ou desktop conectado.</Text>
      )}
      {loading && <Text style={s.muted}>Atualizando arquivos e sessões…</Text>}
    </Card>
  );
}
