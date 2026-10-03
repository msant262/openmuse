import { createContext, type ReactNode, useContext } from "react";
import type { AvatarDesign, AvatarMotionState } from "../../../packages/domain/src/avatar";

const AvatarPresentation = createContext<{
  design?: AvatarDesign;
  state: AvatarMotionState;
  active: boolean;
}>({ state: "idle", active: true });

export function AvatarPresentationProvider({
  children,
  design,
  state = "idle",
  active = true,
}: {
  children: ReactNode;
  design?: AvatarDesign;
  state?: AvatarMotionState;
  active?: boolean;
}) {
  return (
    <AvatarPresentation.Provider value={{ design, state, active }}>
      {children}
    </AvatarPresentation.Provider>
  );
}

export const useAvatarPresentation = () => useContext(AvatarPresentation);
