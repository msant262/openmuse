import * as Crypto from "expo-crypto";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { Camera, FilePlus2 } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppState, Text, View } from "react-native";
import type { Artifact } from "../../../packages/domain/src";
import { ApiError } from "./api";
import {
  cacheAttachment,
  type PickedAttachment,
  removeCachedAttachment,
  uploadCachedAttachment,
} from "./attachment-cache";
import {
  AttachmentQueue,
  type PendingAttachment,
  type TranscriptFileReference,
} from "./attachment-queue";
import { ComputerPendingError } from "./computer-requests";
import { useI18n } from "./i18n";
import { sha256 } from "./message-hash";
import { messageStorage } from "./message-storage";
import { FileThreadCard } from "./thread-artifacts";
import { Button, ErrorNotice, useUI } from "./ui";
import { VoiceInput } from "./voice-input";
import { useWorkspace } from "./workspace";

type TranscriptionResponse = {
  taskId?: string;
  pending?: boolean;
  status?: string;
  stage?: string;
  message?: string;
  error?: string;
  result?: unknown;
  attachments?: TranscriptFileReference[];
  language?: string;
  languageProbability?: number;
  duration?: number;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function transcriptionPatch(value: unknown): Partial<PendingAttachment> {
  const envelope = record(value);
  if (!envelope) return {};
  const nested = record(envelope.result);
  const payload = nested && Array.isArray(nested.attachments) ? nested : envelope;
  const status = typeof payload.status === "string" ? payload.status : envelope.status;
  if (status === "error")
    return {
      transcriptionStatus: "error",
      transcriptionError:
        typeof payload.error === "string"
          ? payload.error
          : typeof envelope.error === "string"
            ? envelope.error
            : "A transcrição falhou no computador.",
      transcriptionMessage: undefined,
    };
  if (
    envelope.pending === true ||
    payload.pending === true ||
    status === "queued" ||
    status === "running"
  )
    return {
      transcriptionTaskId:
        typeof envelope.taskId === "string"
          ? envelope.taskId
          : typeof payload.taskId === "string"
            ? payload.taskId
            : undefined,
      transcriptionStatus: status === "queued" ? "queued" : "running",
      transcriptionStage:
        typeof payload.stage === "string"
          ? payload.stage
          : typeof envelope.stage === "string"
            ? envelope.stage
            : undefined,
      transcriptionMessage:
        typeof payload.message === "string"
          ? payload.message
          : typeof envelope.message === "string"
            ? envelope.message
            : undefined,
      transcriptionError: undefined,
    };

  const attachments = Array.isArray(payload.attachments)
    ? payload.attachments.filter((file): file is TranscriptFileReference => {
        const candidate = record(file);
        return (
          typeof candidate?.fileId === "string" &&
          typeof candidate.name === "string" &&
          typeof candidate.mimeType === "string"
        );
      })
    : [];
  if (status === "succeeded") {
    if (!attachments.some((file) => file.name.toLowerCase().endsWith(".txt")))
      return {
        transcriptionStatus: "error",
        transcriptionError: "O computador terminou sem publicar o arquivo completo .txt.",
      };
    const result = record(payload.result);
    return {
      transcriptionStatus: "complete",
      transcriptionFiles: attachments,
      transcriptionLanguage: typeof result?.language === "string" ? result.language : undefined,
      transcriptionLanguageProbability:
        typeof result?.languageProbability === "number" ? result.languageProbability : undefined,
      transcriptionDuration: typeof result?.duration === "number" ? result.duration : undefined,
      transcriptionStage: undefined,
      transcriptionMessage: undefined,
      transcriptionError: undefined,
    };
  }
  if (status && status !== "succeeded")
    return {
      transcriptionStatus: "error",
      transcriptionError:
        typeof payload.stderr === "string" && payload.stderr
          ? payload.stderr
          : "A transcrição não foi concluída.",
    };
  return {};
}

function TranscriptOutput({
  reference,
  preview,
}: {
  reference: TranscriptFileReference;
  preview: boolean;
}) {
  const { s } = useUI();

  const { api } = useWorkspace();
  const [file, setFile] = useState<Artifact>();
  const [excerpt, setExcerpt] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setFile(undefined);
    setExcerpt("");
    setError("");
    void api
      .request<Artifact>(`/api/files/${encodeURIComponent(reference.fileId)}`)
      .then(async (artifact) => {
        if (active) setFile(artifact);
        if (preview && artifact.name.toLowerCase().endsWith(".txt")) {
          const response = await fetch(api.url(artifact.url));
          if (!response.ok)
            throw new Error(`Não foi possível abrir a transcrição (HTTP ${response.status}).`);
          const text = await response.text();
          if (active) setExcerpt(text.trim().slice(0, 320));
        }
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [api, preview, reference.fileId]);
  return (
    <View style={{ gap: 6 }}>
      {!!excerpt && <Text style={s.small}>{excerpt}</Text>}
      {file ? (
        <FileThreadCard file={file} />
      ) : (
        <Text style={s.small}>{reference.name} · preparando arquivo salvo</Text>
      )}
      <ErrorNotice error={error} />
    </View>
  );
}

function transcriptionLabel(item: PendingAttachment) {
  if (item.transcriptionStatus === "complete") {
    const language = item.transcriptionLanguage
      ? `Idioma detectado: ${item.transcriptionLanguage}${
          typeof item.transcriptionLanguageProbability === "number"
            ? ` (${Math.round(item.transcriptionLanguageProbability * 100)}%)`
            : ""
        }`
      : "Idioma detectado automaticamente";
    const duration =
      typeof item.transcriptionDuration === "number"
        ? ` · ${Math.round(item.transcriptionDuration)} s`
        : "";
    return `Concluída · ${language}${duration}`;
  }
  if (item.transcriptionStatus === "error") return "Falhou";
  if (item.transcriptionStage === "publishing") return "Resultado pronto · publicando arquivos";
  if (item.transcriptionStatus === "running") return "Em andamento no Lenovo";
  return "Na fila";
}

export function ChatAttachments({
  threadId,
  active: visible,
  attach,
  transcript,
  voiceRequest = 0,
}: {
  threadId: string;
  active: boolean;
  attach: (id: string) => Promise<void>;
  transcript: (text: string) => Promise<void>;
  voiceRequest?: number;
}) {
  const { s } = useUI();

  const { t } = useI18n();
  const { api, refresh } = useWorkspace();
  const key = `${api.identityKey}:chat-uploads:${threadId}`;
  const queue = useMemo(
    () => new AttachmentQueue(key, messageStorage, (item) => uploadCachedAttachment(api, item)),
    [key, api],
  );
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  async function flush() {
    if (active.current) return;
    active.current = true;
    try {
      await queue.flush();
      for (const item of await queue.list()) {
        if (
          !item.fileId ||
          !item.transcribe ||
          item.transcriptionStatus === "complete" ||
          item.transcriptionStatus === "error"
        )
          continue;
        const request = {
          fileId: item.fileId,
          language: "auto",
          includeSubtitles: item.includeSubtitles ?? false,
          threadId,
          requestId: `transcribe-${item.id}`,
        };
        try {
          const result = await api.request<TranscriptionResponse>(
            "/api/computer/transcribe-attachment",
            request,
          );
          await queue.patch(item.id, {
            transcriptionTaskId: result.taskId ?? item.transcriptionTaskId,
            ...transcriptionPatch(result),
            transcriptionMessage: undefined,
          });
        } catch (cause) {
          if (cause instanceof ComputerPendingError) {
            let status: Partial<PendingAttachment> = {
              transcriptionTaskId: cause.taskId,
              transcriptionStatus: item.transcriptionStatus ?? "running",
              transcriptionError: undefined,
            };
            try {
              const current = await api.request<TranscriptionResponse>(
                `/api/computer/requests/${encodeURIComponent(cause.taskId)}`,
              );
              status = { ...status, ...transcriptionPatch(current) };
            } catch {
              // Preserve the stable task reference and retry on the next foreground poll.
            }
            await queue.patch(item.id, status);
          } else if (
            cause instanceof ApiError &&
            cause.status >= 400 &&
            cause.status < 500 &&
            cause.status !== 409
          ) {
            await queue.patch(item.id, {
              transcriptionStatus: "error",
              transcriptionError: cause.message,
              transcriptionMessage: undefined,
            });
          } else {
            await queue.patch(item.id, {
              transcriptionStatus: item.transcriptionStatus ?? "queued",
              transcriptionMessage:
                cause instanceof ApiError && cause.status === 409
                  ? cause.message
                  : "Sem conexão com o VPS; a solicitação salva será retomada ao atualizar.",
            });
          }
        }
      }
      setItems(await queue.list());
    } catch (cause) {
      setError(String(cause));
    } finally {
      active.current = false;
    }
  }
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    let live = true;
    void queue
      .list()
      .then((values) => {
        if (live) setItems(values);
      })
      .catch((cause) => {
        if (live) setError(String(cause));
      });
    const poll = () => {
      if (AppState.currentState === "active") void flushRef.current();
    };
    poll();
    const interval = setInterval(poll, 15000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") poll();
    });
    return () => {
      live = false;
      clearInterval(interval);
      subscription.remove();
    };
  }, [queue]);
  async function save(file: PickedAttachment, transcribe = false, includeSubtitles = false) {
    setBusy(true);
    setError("");
    const id = Crypto.randomUUID(),
      cacheKey = sha256(`${key}:${id}`);
    try {
      const cached = await cacheAttachment(cacheKey, file);
      try {
        await queue.add({
          ...cached,
          id,
          transcribe,
          ...(transcribe && {
            includeSubtitles,
            transcriptionStatus: "queued",
          }),
        });
      } catch (cause) {
        await removeCachedAttachment(cacheKey);
        throw cause;
      }
      setItems(await queue.list());
      void flush();
    } catch (cause) {
      setError(String(cause));
      throw cause;
    } finally {
      setBusy(false);
    }
  }
  async function document() {
    try {
      const selected = await DocumentPicker.getDocumentAsync({
        type: "*/*",
        copyToCacheDirectory: true,
      });
      if (!selected.canceled) {
        const file = selected.assets[0];
        await save({
          uri: file.uri,
          name: file.name,
          mimeType: file.mimeType ?? "application/octet-stream",
          file: file.file,
        });
      }
    } catch (cause) {
      setError(String(cause));
    }
  }
  async function camera() {
    try {
      if (!(await ImagePicker.requestCameraPermissionsAsync()).granted)
        throw new Error("Sem acesso à câmera. Você pode escolher um arquivo.");
      const selected = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        quality: 0.8,
      });
      if (!selected.canceled) {
        const file = selected.assets[0];
        await save({
          uri: file.uri,
          name: file.fileName ?? `foto-${Date.now()}.jpg`,
          mimeType: file.mimeType ?? "image/jpeg",
          file: file.file,
        });
      }
    } catch (cause) {
      setError(String(cause));
    }
  }
  async function startTranscription(item: PendingAttachment, includeSubtitles: boolean) {
    await queue.patch(item.id, {
      transcribe: true,
      includeSubtitles,
      transcriptionStatus: "queued",
      transcriptionStage: undefined,
      transcriptionMessage: undefined,
      transcriptionError: undefined,
    });
    setItems(await queue.list());
    void flush();
  }
  async function fullTranscript(item: PendingAttachment) {
    if (item.transcript !== undefined) return item.transcript;
    const reference = item.transcriptionFiles?.find((file) =>
      file.name.toLowerCase().endsWith(".txt"),
    );
    if (!reference) return "";
    const artifact = await api.request<Artifact>(
      `/api/files/${encodeURIComponent(reference.fileId)}`,
    );
    const response = await fetch(api.url(artifact.url));
    if (!response.ok) throw new Error("Não foi possível baixar o arquivo completo da transcrição.");
    return response.text();
  }
  async function consume(item: PendingAttachment, text = false) {
    try {
      if (text) await transcript(await fullTranscript(item));
      else if (item.fileId) {
        await refresh();
        await attach(item.fileId);
      } else return;
      if (!text) {
        await queue.remove(item.id);
        await removeCachedAttachment(item.key);
        setItems(await queue.list());
      }
    } catch (cause) {
      setError(String(cause));
    }
  }
  return (
    <View style={{ gap: 8 }}>
      <View style={{ gap: 0 }}>
        <Button
          small
          icon={FilePlus2}
          busy={busy}
          style={{
            justifyContent: "flex-start",
            backgroundColor: "transparent",
            borderRadius: 12,
            minHeight: 42,
            paddingHorizontal: 10,
          }}
          onPress={() => void document()}
        >
          {t("Upload file")}
        </Button>
        <Button
          small
          icon={Camera}
          disabled={busy}
          style={{
            justifyContent: "flex-start",
            backgroundColor: "transparent",
            borderRadius: 12,
            minHeight: 42,
            paddingHorizontal: 10,
          }}
          onPress={() => void camera()}
        >
          {t("Camera")}
        </Button>
        <VoiceInput save={save} active={visible} compact startRequest={voiceRequest} />
      </View>
      {items.map((item) => (
        <View key={item.id} style={{ gap: 4 }}>
          <Text style={s.small}>
            {item.name} · {item.fileId ? "Salvo" : "Envio pendente"}
          </Text>
          {!!item.error && <Text style={s.small}>{item.error}</Text>}
          {item.transcript !== undefined && (
            <Text style={s.small}>{item.transcript.slice(0, 240)}</Text>
          )}
          {item.transcribe && (
            <View style={{ gap: 6 }}>
              <Text style={s.small}>Transcrição: {transcriptionLabel(item)}</Text>
              {!!item.transcriptionMessage && (
                <Text style={s.small}>{item.transcriptionMessage}</Text>
              )}
              {!!item.transcriptionError && <Text style={s.small}>{item.transcriptionError}</Text>}
              {item.transcriptionFiles?.map((file) => (
                <TranscriptOutput
                  key={file.fileId}
                  reference={file}
                  preview={file.name.toLowerCase().endsWith(".txt")}
                />
              ))}
            </View>
          )}
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            {item.fileId && (
              <Button small onPress={() => void consume(item)}>
                Anexar ao pedido
              </Button>
            )}
            {item.fileId &&
              /^(?:audio|video)\//.test(item.mimeType.toLowerCase()) &&
              !item.transcribe && (
                <>
                  <Button small onPress={() => void startTranscription(item, false)}>
                    Transcrever
                  </Button>
                  <Button small onPress={() => void startTranscription(item, true)}>
                    Transcrever + SRT
                  </Button>
                </>
              )}
            {(item.transcript !== undefined ||
              item.transcriptionFiles?.some((file) =>
                file.name.toLowerCase().endsWith(".txt"),
              )) && (
              <Button small onPress={() => void consume(item, true)}>
                Usar texto
              </Button>
            )}
            {item.transcribe && item.transcriptionStatus !== "complete" && (
              <Button small onPress={() => void flush()}>
                Atualizar transcrição
              </Button>
            )}
            {!item.transcribe && (
              <Button small onPress={() => void flush()}>
                Atualizar
              </Button>
            )}
            <Button
              small
              onPress={() =>
                void queue
                  .remove(item.id)
                  .then(() => removeCachedAttachment(item.key))
                  .then(() => queue.list())
                  .then(setItems)
                  .catch((cause) => setError(String(cause)))
              }
            >
              Remover
            </Button>
          </View>
        </View>
      ))}
      <ErrorNotice error={error} />
    </View>
  );
}
