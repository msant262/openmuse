import type { StyleProp, ViewStyle } from "react-native";
import type { AvatarDesign, AvatarMotionState } from "../../../packages/domain/src/avatar";
import type { AvatarAsset } from "../../../packages/domain/src/avatar-character";

export type AvatarRendererKind = "video" | "image" | "fallback" | "webgl";

export type AvatarRendererProps = {
  design?: AvatarDesign;
  asset?: AvatarAsset;
  state?: AvatarMotionState;
  /** False pauses animation. Use this when another large avatar preview is visible. */
  active?: boolean;
  reducedMotion?: boolean;
  interactive?: boolean;
  framing?: "full" | "portrait";
  size?: number;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  fallbackLabel?: string;
  onReady?: (renderer: AvatarRendererKind) => void;
};
