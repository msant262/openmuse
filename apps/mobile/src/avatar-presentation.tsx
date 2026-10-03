import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";
import type { AvatarDesign, AvatarMotionState } from "../../../packages/domain/src/avatar";
import type { AvatarAsset } from "../../../packages/domain/src/avatar-character";

import { type ConversationActivity, companionMotion } from "./avatar-motion";

const AvatarPresentation = createContext<{
  design?: AvatarDesign;
  asset?: AvatarAsset;
  state: AvatarMotionState;
  active: boolean;
  reportActivity: (activity: ConversationActivity) => void;
}>({ state: "idle", active: true, reportActivity: () => {} });

export function AvatarPresentationProvider({
  children,
  design,
  asset,
  state = "idle",
  active = true,
  conversationKey,
}: {
  children: ReactNode;
  design?: AvatarDesign;
  asset?: AvatarAsset;
  state?: AvatarMotionState;
  active?: boolean;
  conversationKey?: string;
}) {
  const [activity, setActivity] = useState<ConversationActivity>();
  const selectedKey = useRef(conversationKey);
  selectedKey.current = conversationKey;
  const reportActivity = useCallback((next: ConversationActivity) => {
    if (next.key !== selectedKey.current) return;
    setActivity((previous) =>
      previous?.key === next.key && previous.state === next.state ? previous : next,
    );
  }, []);
  return (
    <AvatarPresentation.Provider
      value={{
        design,
        asset,
        state: companionMotion(conversationKey, activity, state),
        active,
        reportActivity,
      }}
    >
      {children}
    </AvatarPresentation.Provider>
  );
}

export const useAvatarPresentation = () => useContext(AvatarPresentation);
