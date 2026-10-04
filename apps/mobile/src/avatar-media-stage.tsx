import { type ComponentType, useEffect, useRef, useState } from "react";
import { Image, type ImageSourcePropType, StyleSheet, Text, View } from "react-native";
import { type AvatarPlaybackSource, type AvatarVisual, companionPoster } from "./avatar-media";
import type { AvatarRendererKind } from "./avatar-renderer.types";
import { useI18n } from "./i18n";
import { useUI } from "./ui";

export type AvatarVideoProps = {
  source: AvatarPlaybackSource;
  playing: boolean;
  onFirstFrame: () => void;
  onError: () => void;
};

const sourceKey = (source: AvatarPlaybackSource | ImageSourcePropType | undefined) =>
  JSON.stringify(source);

/** The parent keys this stage by identity + motion + file, never by a signed URL. */
export function AvatarMediaStage({
  visual,
  playing,
  reducedMotion,
  size,
  framing,
  accessibilityLabel,
  fallbackLabel,
  onReady,
  Video,
}: {
  visual: AvatarVisual;
  playing: boolean;
  reducedMotion: boolean;
  size: number;
  framing: "full" | "portrait";
  accessibilityLabel?: string;
  fallbackLabel?: string;
  onReady?: (kind: AvatarRendererKind) => void;
  Video: ComponentType<AvatarVideoProps>;
}) {
  const { colors } = useUI();

  const { t } = useI18n();
  // Polling may renew URL signatures. Keep already loaded media until it actually fails.
  const [poster, setPoster] = useState(visual.poster);
  const [source, setSource] = useState(visual.video);
  const [posterLoaded, setPosterLoaded] = useState(false);
  const [posterFallback, setPosterFallback] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [frameReady, setFrameReady] = useState(false);
  const latest = useRef({ visual, onReady });
  latest.current = { visual, onReady };
  const lastReady = useRef<AvatarRendererKind | undefined>(undefined);
  function report(kind: AvatarRendererKind) {
    if (lastReady.current === kind) return;
    lastReady.current = kind;
    latest.current.onReady?.(kind);
  }
  const nextVideoKey = sourceKey(visual.video);
  useEffect(() => {
    if (videoFailed && visual.video && nextVideoKey !== sourceKey(source)) {
      setSource(visual.video);
      setVideoFailed(false);
      setFrameReady(false);
    }
  }, [videoFailed, nextVideoKey]);
  useEffect(() => {
    if (reducedMotion) setFrameReady(false);
    if (posterLoaded && !posterFallback && !videoFailed && (reducedMotion || !source))
      report("image");
  }, [reducedMotion, posterLoaded, posterFallback, videoFailed, source]);
  function posterError() {
    const fresh = latest.current.visual.poster;
    if (!posterFallback && sourceKey(fresh) !== sourceKey(poster)) {
      setPoster(fresh);
      return;
    }
    setPoster(companionPoster);
    setPosterFallback(true);
    report("fallback");
  }
  const fallback = posterFallback && !frameReady;
  const staticFailure = videoFailed && !reducedMotion;
  const caption = fallback
    ? t("Companion preview unavailable")
    : staticFailure
      ? (fallbackLabel ?? t("Static preview · video unavailable"))
      : undefined;
  const scale = framing === "portrait" ? 1.4 : 1;
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={caption ?? accessibilityLabel ?? t("Your companion")}
      accessibilityState={{ busy: !posterLoaded && !frameReady && !posterFallback }}
      aria-busy={!posterLoaded && !frameReady && !posterFallback}
      style={{
        width: size,
        height: size,
        overflow: "hidden",
        borderRadius: framing === "portrait" ? size / 2 : 0,
      }}
    >
      <View
        style={{
          position: "absolute",
          width: size * scale,
          height: size * scale,
          left: -(size * (scale - 1)) / 2,
          top: framing === "portrait" ? -size * 0.05 : 0,
        }}
      >
        <Image
          source={poster}
          accessible={false}
          resizeMode="contain"
          style={[StyleSheet.absoluteFill, { width: "100%", height: "100%" }]}
          onLoad={() => {
            setPosterLoaded(true);
            if (posterFallback || videoFailed) report("fallback");
            else if (reducedMotion || !source) report("image");
          }}
          onError={posterError}
        />
        {!!source && !reducedMotion && !videoFailed && (
          <Video
            source={source}
            playing={playing}
            onFirstFrame={() => {
              setFrameReady(true);
              report("video");
            }}
            onError={() => {
              setVideoFailed(true);
              setFrameReady(false);
              report("fallback");
            }}
          />
        )}
      </View>
      {!!caption && size > 100 && (
        <Text
          style={{
            position: "absolute",
            bottom: 3,
            left: 5,
            right: 5,
            color: colors.muted,
            fontSize: 10,
            textAlign: "center",
            backgroundColor: "rgba(255,255,255,0.9)",
            borderRadius: 8,
          }}
        >
          {caption}
        </Text>
      )}
    </View>
  );
}
