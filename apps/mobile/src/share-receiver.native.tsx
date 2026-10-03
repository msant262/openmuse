import { useShareIntent } from "expo-share-intent";
import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { cacheAttachment, cacheTextAttachment, uploadCachedAttachment } from "./attachment-cache";
import { AttachmentQueue } from "./attachment-queue";
import { messageStorage } from "./message-storage";
import { stageSharedInput } from "./share-intake";
import { useMuseThread } from "./threads";
import { Button, Card, ErrorNotice } from "./ui";
import { useWorkspace } from "./workspace";

export function ShareReceiver() {
  const incoming = useShareIntent({
    disabled: Platform.OS !== "android",
    resetOnBackground: false,
    debug: false,
  });
  const { api, notify } = useWorkspace();
  const { mainId, loading, enabled, select } = useMuseThread();
  const [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  const busy = useRef(false);
  useEffect(() => {
    if (loading || !incoming.hasShareIntent || busy.current) return;
    busy.current = true;
    const threadId = enabled ? mainId : "local-main";
    const queue = new AttachmentQueue(
      `${api.identityKey}:chat-uploads:${threadId}`,
      messageStorage,
      (item) => uploadCachedAttachment(api, item),
    );
    void stageSharedInput(
      incoming.shareIntent,
      queue,
      (key, file) =>
        cacheAttachment(key, { uri: file.path, name: file.fileName, mimeType: file.mimeType }),
      cacheTextAttachment,
    )
      .then((count) => {
        incoming.resetShareIntent();
        setError("");
        select({ id: mainId, existing: true });
        notify(`${count} anexo(s) guardado(s). Abra Anexos no chat para incluir no pedido.`);
      })
      .catch((cause) => setError(String(cause)))
      .finally(() => {
        busy.current = false;
      });
  }, [incoming.hasShareIntent, incoming.shareIntent, loading, api, mainId, enabled, attempt]);
  if (!error && !incoming.error) return null;
  return (
    <Card>
      <ErrorNotice error={error || incoming.error || ""} />
      <Button onPress={() => retry((value) => value + 1)}>Tentar guardar compartilhamento</Button>
    </Card>
  );
}
