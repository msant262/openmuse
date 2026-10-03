import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { resolveAvatarDesign } from "../../../packages/domain/src/avatar";
import type { AvatarSceneController } from "./avatar/scene";
import { mountAvatarScene } from "./avatar/scene";
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
  const host = useRef<HTMLDivElement | null>(null);
  const controller = useRef<AvatarSceneController | undefined>(undefined);
  const [fallback, setFallback] = useState(false);
  const ready = useRef(onReady);
  ready.current = onReady;
  const options = useRef({ design, state, active, reducedMotion, interactive, framing });
  options.current = { design, state, active, reducedMotion, interactive, framing };
  useEffect(() => {
    if (!host.current) return;
    let mounted = true;
    function fail() {
      if (!mounted) return;
      setFallback(true);
      ready.current?.("fallback");
    }
    try {
      controller.current = mountAvatarScene(host.current, { ...options.current, onFailure: fail });
      ready.current?.("webgl");
    } catch {
      fail();
    }
    return () => {
      mounted = false;
      controller.current?.dispose();
      controller.current = undefined;
    };
  }, []);
  useEffect(() => {
    controller.current?.update({ design, state, active, reducedMotion, interactive, framing });
  }, [JSON.stringify(design), state, active, reducedMotion, interactive, framing]);
  return (
    <View
      style={[{ width: size, height: size }, style]}
      accessibilityLabel={accessibilityLabel ?? t("Animated 3D companion")}
      accessibilityRole="image"
    >
      <div
        ref={host}
        aria-hidden="true"
        style={{ width: "100%", height: "100%", display: fallback ? "none" : "block" }}
      />
      {fallback && (
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
      )}
    </View>
  );
}
