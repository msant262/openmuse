import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Text, View } from "react-native";
import type { Artifact } from "../../../packages/domain/src";
import { AssistantResponse } from "./assistant-response";
import { useI18n } from "./i18n";
import { colors, ErrorNotice, s } from "./ui";

function fileKind(file: Artifact) {
  if (file.mimeType === "text/html" || /\.html?$/i.test(file.name)) return "html";
  if (file.mimeType.startsWith("video/")) return "video";
  if (file.mimeType.startsWith("audio/")) return "audio";
  if (/\.(md|markdown|txt|csv|json|log)$/i.test(file.name) || file.mimeType.startsWith("text/"))
    return "text";
  return undefined;
}

export function hasFileContentPreview(file: Artifact) {
  const kind = fileKind(file);
  return kind === "text" || (Platform.OS === "web" && !!kind);
}

/** Isolate generated HTML from the application; documents never inherit workspace access. */
export function FileContentPreview({
  file,
  url,
  height,
  passive = false,
}: {
  file: Artifact;
  url: string;
  height: number;
  passive?: boolean;
}) {
  const { t } = useI18n();
  const [text, setText] = useState<string>();
  const [error, setError] = useState("");
  const kind = fileKind(file);
  useEffect(() => {
    if (kind !== "text" && kind !== "html") return;
    let current = true;
    const controller = new AbortController();
    setText(undefined);
    setError("");
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load this preview.");
        return (await response.text()).slice(0, 250_000);
      })
      .then((value) => {
        if (current) setText(value);
      })
      .catch(() => {
        if (current) setError(t("Could not load this preview."));
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [url, kind, t]);
  if (Platform.OS === "web" && kind === "html" && text !== undefined)
    return (
      <iframe
        title={file.name}
        srcDoc={text}
        sandbox={passive ? "" : "allow-scripts"}
        referrerPolicy="no-referrer"
        tabIndex={passive ? -1 : undefined}
        aria-hidden={passive || undefined}
        style={{
          width: "100%",
          height,
          border: 0,
          background: "white",
          pointerEvents: passive ? "none" : "auto",
        }}
      />
    );
  if (Platform.OS === "web" && kind === "video")
    return (
      // biome-ignore lint/a11y/useMediaCaption: User-uploaded files do not necessarily include a caption track.
      <video
        aria-label={file.name}
        src={url}
        controls
        playsInline
        preload="metadata"
        style={{
          width: "100%",
          height,
          objectFit: "contain",
          background: "#151517",
          borderRadius: 12,
        }}
      />
    );
  if (Platform.OS === "web" && kind === "audio")
    return (
      <View
        style={{ minHeight: height, alignItems: "center", justifyContent: "center", padding: 36 }}
      >
        {/* biome-ignore lint/a11y/useMediaCaption: User-uploaded recordings do not necessarily include a caption track. */}
        <audio
          aria-label={file.name}
          src={url}
          controls
          preload="metadata"
          style={{ width: "100%", maxWidth: 560 }}
        />
      </View>
    );
  return (
    <View
      style={{
        width: "100%",
        maxWidth: 840,
        alignSelf: "center",
        backgroundColor: "#FFFFFF",
        padding: 36,
        minHeight: height,
      }}
    >
      <ErrorNotice error={error} />
      {text === undefined && !error ? (
        <ActivityIndicator accessibilityLabel={t("Loading preview…")} color={colors.muted} />
      ) : /\.(md|markdown)$/i.test(file.name) ? (
        <AssistantResponse content={text ?? ""} />
      ) : (
        <Text selectable style={s.text}>
          {text}
        </Text>
      )}
    </View>
  );
}
