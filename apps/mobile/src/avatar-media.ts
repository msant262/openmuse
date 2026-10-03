import type { ImageSourcePropType } from "react-native";
import type { AvatarMotionState } from "../../../packages/domain/src/avatar";
import type { AvatarAsset, AvatarMotion } from "../../../packages/domain/src/avatar-character";

export const companionPoster = require("../assets/companions/okami-poster.png");

const defaultScenes = {
  idle: {
    poster: require("../assets/companions/okami-idle-poster.png"),
    video: require("../assets/companions/okami-idle.mp4"),
  },
  working: {
    poster: require("../assets/companions/okami-working-poster.png"),
    video: require("../assets/companions/okami-working.mp4"),
  },
  responding: {
    poster: require("../assets/companions/okami-idle-poster.png"),
    video: require("../assets/companions/okami-responding.mp4"),
  },
} satisfies Record<AvatarMotion, { poster: ImageSourcePropType; video: number }>;

export type AvatarPlaybackSource = number | string | { uri: string };
export type AvatarVisual = {
  key: string;
  poster: ImageSourcePropType;
  video?: AvatarPlaybackSource;
  pending: boolean;
};

export function avatarMotion(state: AvatarMotionState): AvatarMotion {
  return state === "thinking" ? "working" : state === "talking" ? "responding" : "idle";
}

/** Media URLs are owner-authorized by the API; only persisted file references reach this view. */
export function avatarMediaUrl(value: string | undefined, origin: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function avatarVisual(
  asset: AvatarAsset | undefined,
  state: AvatarMotionState,
  origin: string,
): AvatarVisual {
  const motion = avatarMotion(state);
  if (!asset) return { key: `default:${motion}`, ...defaultScenes[motion], pending: false };
  const media = asset.motions[motion];
  const posterUrl = avatarMediaUrl(media?.posterUrl ?? asset.poster.url, origin);
  const videoUrl = avatarMediaUrl(media?.url, origin);
  return {
    key: `${asset.id}:${motion}:${media?.fileId ?? "poster"}`,
    poster: posterUrl ? { uri: posterUrl } : companionPoster,
    video: videoUrl ? { uri: videoUrl } : undefined,
    pending: asset.status === "animating" && !media,
  };
}
