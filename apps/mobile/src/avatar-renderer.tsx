import { Asset } from "expo-asset";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { API_URL } from "./api";
import { avatarVisual } from "./avatar-media";
import { AvatarMediaStage, type AvatarVideoProps } from "./avatar-media-stage";
import type { AvatarRendererProps } from "./avatar-renderer.types";

export type { AvatarRendererProps } from "./avatar-renderer.types";

export function AvatarRenderer({
  asset,
  state = "idle",
  active = true,
  reducedMotion,
  framing = "full",
  size = 180,
  style,
  accessibilityLabel,
  fallbackLabel,
  onReady,
}: AvatarRendererProps) {
  const bounds = useRef<HTMLDivElement | null>(null);
  const [foreground, setForeground] = useState(
    () => typeof document === "undefined" || !document.hidden,
  );
  const [visible, setVisible] = useState(false);
  const [systemReducedMotion, setSystemReducedMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const visibility = () => setForeground(!document.hidden);
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const motion = () => setSystemReducedMotion(!!media?.matches);
    document.addEventListener("visibilitychange", visibility);
    media?.addEventListener("change", motion);
    const observer =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver((entries) =>
            setVisible(
              entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0),
            ),
          );
    if (bounds.current) {
      if (observer) observer.observe(bounds.current);
      else setVisible(true);
    }
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      media?.removeEventListener("change", motion);
      observer?.disconnect();
    };
  }, []);
  const reduce = reducedMotion ?? systemReducedMotion;
  const visual = avatarVisual(asset, state, API_URL);
  return (
    <View style={[{ width: size, height: size }, style]}>
      <div ref={bounds} style={{ position: "absolute", inset: 0 }}>
        <AvatarMediaStage
          key={visual.key}
          visual={visual}
          playing={active && foreground && visible && !reduce}
          reducedMotion={reduce}
          size={size}
          framing={framing}
          accessibilityLabel={accessibilityLabel}
          fallbackLabel={fallbackLabel}
          onReady={onReady}
          Video={WebAvatarVideo}
        />
      </div>
    </View>
  );
}

export function WebAvatarVideo({ source, playing, onFirstFrame, onError }: AvatarVideoProps) {
  const video = useRef<HTMLVideoElement | null>(null);
  const callbacks = useRef({ onFirstFrame, onError });
  callbacks.current = { onFirstFrame, onError };
  const [ready, setReady] = useState(false);
  const src =
    typeof source === "string"
      ? source
      : typeof source === "number"
        ? Asset.fromModule(source).uri
        : source.uri;
  useEffect(() => {
    setReady(false);
  }, [src]);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let current = true;
    if (playing)
      void element.play().catch(() => {
        if (current) callbacks.current.onError();
      });
    else element.pause();
    return () => {
      current = false;
      element.pause();
    };
  }, [src, playing]);
  return (
    <video
      ref={video}
      src={src}
      muted
      loop
      playsInline
      controls={false}
      disablePictureInPicture
      disableRemotePlayback
      preload="auto"
      aria-hidden="true"
      tabIndex={-1}
      onLoadedData={() => {
        setReady(true);
        callbacks.current.onFirstFrame();
      }}
      onError={() => callbacks.current.onError()}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "contain",
        opacity: ready ? 1 : 0,
        transition: "opacity 180ms ease",
        pointerEvents: "none",
      }}
    />
  );
}
