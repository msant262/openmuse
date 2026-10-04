import { useVideoPlayer, VideoView } from "expo-video";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, AppState, Dimensions, StyleSheet, View } from "react-native";
import { API_URL } from "./api";
import { avatarVisual } from "./avatar-media";
import { AvatarMediaStage, type AvatarVideoProps } from "./avatar-media-stage";
import type { AvatarRendererProps } from "./avatar-renderer.types";

export type { AvatarRendererProps } from "./avatar-renderer.types";

export function AvatarRenderer({
  asset,
  companion,
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
  const bounds = useRef<View | null>(null);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [visible, setVisible] = useState(false);
  // Wait for the OS setting before creating a player, avoiding a flash of motion.
  const [systemReducedMotion, setSystemReducedMotion] = useState<boolean>();
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (mounted) setSystemReducedMotion(value);
      })
      .catch(() => {
        if (mounted) setSystemReducedMotion(true);
      });
    const accessibility = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setSystemReducedMotion,
    );
    const appState = AppState.addEventListener("change", (next) =>
      setForeground(next === "active"),
    );
    return () => {
      mounted = false;
      accessibility.remove();
      appState.remove();
    };
  }, []);
  useEffect(() => {
    if (!active || !foreground) return;
    let mounted = true;
    const check = () =>
      bounds.current?.measureInWindow((x, y, width, height) => {
        if (!mounted) return;
        const window = Dimensions.get("window");
        setVisible(
          width > 0 &&
            height > 0 &&
            x < window.width &&
            y < window.height &&
            x + width > 0 &&
            y + height > 0,
        );
      });
    check();
    const timer = setInterval(check, 1000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [active, foreground]);
  const reduce = reducedMotion ?? systemReducedMotion ?? true;
  const visual = avatarVisual(asset, state, API_URL, companion);
  return (
    <View ref={bounds} collapsable={false} style={[{ width: size, height: size }, style]}>
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
        Video={NativeAvatarVideo}
      />
    </View>
  );
}

/** Only mounted when motion is allowed. Expo releases the player on unmount. */
export function NativeAvatarVideo({ source, playing, onFirstFrame, onError }: AvatarVideoProps) {
  const callbacks = useRef({ onFirstFrame, onError });
  callbacks.current = { onFirstFrame, onError };
  const opacity = useRef(new Animated.Value(0)).current;
  const firstFrame = useRef(false);
  const player = useVideoPlayer(source, (instance) => {
    instance.muted = true;
    instance.loop = true;
    instance.keepScreenOnWhilePlaying = false;
    instance.staysActiveInBackground = false;
    instance.showNowPlayingNotification = false;
    instance.allowsExternalPlayback = false;
    instance.audioMixingMode = "mixWithOthers";
  });
  useEffect(() => {
    opacity.setValue(0);
    firstFrame.current = false;
    const listener = player.addListener("statusChange", ({ status }) => {
      if (status === "error") callbacks.current.onError();
    });
    if (player.status === "error") callbacks.current.onError();
    return () => {
      listener.remove();
      opacity.stopAnimation();
      try {
        player.pause();
      } catch {
        /* The native shared object may already be released. */
      }
    };
  }, [player, opacity]);
  useEffect(() => {
    if (playing) player.play();
    else player.pause();
  }, [player, playing]);
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity }]}>
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        surfaceType="textureView"
        contentFit="contain"
        nativeControls={false}
        allowsFullscreen={false}
        allowsPictureInPicture={false}
        startsPictureInPictureAutomatically={false}
        allowsVideoFrameAnalysis={false}
        useExoShutter={false}
        onFirstFrameRender={() => {
          if (firstFrame.current) return;
          firstFrame.current = true;
          Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
          callbacks.current.onFirstFrame();
        }}
      />
    </Animated.View>
  );
}
