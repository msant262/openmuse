import type { AvatarMotionState } from "../../../packages/domain/src/avatar";

export type ConversationActivity = { key: string; state: AvatarMotionState };

export function companionMotion(
  selectedKey: string | undefined,
  activity: ConversationActivity | undefined,
  backgroundState: AvatarMotionState,
): AvatarMotionState {
  return selectedKey && activity?.key === selectedKey && activity.state !== "idle"
    ? activity.state
    : backgroundState;
}
