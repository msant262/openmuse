import type { DesktopSession } from "../../../packages/domain/src/desktop.ts";

export type {
  DesktopControl,
  DesktopFrame,
  DesktopInput,
} from "../../../packages/domain/src/desktop.ts";
export {
  desktopActionSchema,
  desktopFrameBindingSchema,
  desktopFrameSchema,
  desktopInputSchema,
  desktopSessionSchema,
} from "../../../packages/domain/src/desktop.ts";
export type NativeDesktopSession = DesktopSession & {
  executorId: string;
  hostId: string;
  osAccountId: string;
  executorEpoch: number;
};
export const desktopResourceKey = (session: Pick<NativeDesktopSession, "executorId" | "id">) =>
  `desktop:${session.executorId}:${session.id}`;
export const desktopProfileKey = (
  session: Pick<NativeDesktopSession, "executorId" | "profileId">,
) => `browser-profile:${session.executorId}:${session.profileId}`;
