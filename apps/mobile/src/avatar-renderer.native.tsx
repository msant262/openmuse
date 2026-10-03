import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  AppState,
  Dimensions,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { WebView } from "react-native-webview";
import { resolveAvatarDesign } from "../../../packages/domain/src/avatar";
import { avatarNativeDocument, avatarUpdateScript } from "./avatar/native-document";
import type { AvatarRendererProps } from "./avatar-renderer.types";
import { AvatarThumbnail } from "./avatar-thumbnail";
import { useI18n } from "./i18n";

export type { AvatarRendererProps } from "./avatar-renderer.types";

export function AvatarRenderer({
  design: suppliedDesign,
  state = "idle",
  active = true,
  reducedMotion,
  interactive = false,
  framing = "full",
  size = 180,
  style,
  accessibilityLabel,
  fallbackLabel,
  onReady,
}: AvatarRendererProps) {
  const { t } = useI18n();
  const design = resolveAvatarDesign(suppliedDesign);
  const webview = useRef<WebView | null>(null);
  const bounds = useRef<View | null>(null);
  const [fallback, setFallback] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [visible, setVisible] = useState(true);
  const [systemReducedMotion, setSystemReducedMotion] = useState(false);
  const [ready, setReady] = useState(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const settings = {
    design,
    state,
    active: active && foreground && visible,
    reducedMotion: reducedMotion ?? systemReducedMotion,
    interactive,
    framing,
  };
  const latest = useRef(settings);
  latest.current = settings;
  // Keep the document stable. Parameters change through a bounded local bridge, not WebView reloads.
  const document = useRef<{ html: string } | undefined>(undefined);
  if (!document.current) document.current = { html: avatarNativeDocument(settings) };
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (mounted) setSystemReducedMotion(value);
      })
      .catch(() => {});
    const accessibility = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setSystemReducedMotion,
    );
    const appState = AppState.addEventListener("change", (next) =>
      setForeground(next === "active"),
    );
    return () => {
      mounted = false;
      webview.current?.injectJavaScript("window.__OKAMI_AVATAR__?.dispose(); true;");
      accessibility.remove();
      appState.remove();
    };
  }, []);
  useEffect(() => {
    if (!active || !foreground) return;
    let mounted = true;
    const check = () =>
      bounds.current?.measureInWindow((x, y, width, height) => {
        if (!mounted || !width || !height) return;
        const window = Dimensions.get("window");
        setVisible(x < window.width && y < window.height && x + width > 0 && y + height > 0);
      });
    check();
    const timer = setInterval(check, 1000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [active, foreground]);
  useEffect(() => {
    if (ready) webview.current?.injectJavaScript(avatarUpdateScript(settings));
  }, [
    ready,
    JSON.stringify(design),
    state,
    active,
    foreground,
    visible,
    reducedMotion,
    systemReducedMotion,
    interactive,
    framing,
  ]);
  function fail() {
    setFallback(true);
    onReadyRef.current?.("fallback");
  }
  return (
    <View
      ref={bounds}
      collapsable={false}
      style={[{ width: size, height: size }, style]}
      accessibilityRole="image"
      accessibilityLabel={
        !ready && !fallback
          ? t("Loading your companion…")
          : (accessibilityLabel ?? t("Animated 3D companion"))
      }
      accessibilityState={{ busy: !ready && !fallback }}
      aria-busy={!ready && !fallback}
    >
      {fallback ? (
        <View style={StyleSheet.absoluteFill}>
          <AvatarThumbnail species={design.species} size={size} />
          <Text
            style={{
              color: "#655F71",
              fontSize: 10,
              textAlign: "center",
              position: "absolute",
              bottom: 4,
              width: "100%",
            }}
          >
            {fallbackLabel ?? t("Static preview · 3D unavailable on this device")}
          </Text>
        </View>
      ) : (
        <WebView
          ref={webview}
          source={document.current}
          style={{ flex: 1, backgroundColor: "transparent" }}
          containerStyle={{ backgroundColor: "transparent" }}
          originWhitelist={["about:blank"]}
          onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
          javaScriptEnabled
          domStorageEnabled={false}
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          javaScriptCanOpenWindowsAutomatically={false}
          setSupportMultipleWindows={false}
          mixedContentMode="never"
          scrollEnabled={false}
          bounces={false}
          onError={fail}
          onContentProcessDidTerminate={fail}
          onRenderProcessGone={fail}
          onMessage={(event) => {
            try {
              const message = JSON.parse(event.nativeEvent.data);
              if (message.type !== "avatar-ready") return;
              if (message.renderer === "fallback") fail();
              else if (message.renderer === "webgl") {
                webview.current?.injectJavaScript(avatarUpdateScript(latest.current));
                setReady(true);
                onReadyRef.current?.("webgl");
              }
            } catch {}
          }}
        />
      )}
      {!ready && !fallback && (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <AvatarThumbnail species={design.species} size={size} />
          <ActivityIndicator
            size="small"
            color="#8C8296"
            style={{ position: "absolute", bottom: size > 120 ? 8 : 0, alignSelf: "center" }}
          />
        </View>
      )}
    </View>
  );
}
