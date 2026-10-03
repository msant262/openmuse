import type { DesktopFrame, DesktopSession } from "../../../packages/domain/src/desktop";

export type RenderedDesktop = { frame: DesktopFrame; uri: string };
/** Store only the newest rendered pixels. A reconnect or geometry change must
 * discard the old coordinate binding even if its image looks unchanged. */
export function renderDesktopFrame(
  session: DesktopSession,
  previous: RenderedDesktop | undefined,
  frame: DesktopFrame,
): RenderedDesktop | undefined {
  if (
    frame.sessionGeneration !== session.sessionGeneration ||
    frame.width !== session.width ||
    frame.height !== session.height
  )
    return undefined;
  if (
    previous &&
    previous.frame.sessionGeneration === frame.sessionGeneration &&
    previous.frame.sequence >= frame.sequence
  )
    return frame.paused && frame.frameId === previous.frame.frameId
      ? { frame, uri: previous.uri }
      : previous;
  if (frame.imageUnchanged) {
    if (
      !previous ||
      previous.frame.sessionGeneration !== frame.sessionGeneration ||
      previous.frame.imageHash !== frame.imageHash
    )
      return undefined;
    return { frame, uri: previous.uri };
  }
  if (frame.mimeType !== "image/png" || !frame.image || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.image))
    return undefined;
  return { frame, uri: `data:image/png;base64,${frame.image}` };
}

export function desktopPoint(
  frame: DesktopFrame,
  x: number,
  y: number,
  rendered: { width: number; height: number },
) {
  if (
    frame.paused ||
    ![x, y, rendered.width, rendered.height].every(Number.isFinite) ||
    rendered.width <= 0 ||
    rendered.height <= 0 ||
    x < 0 ||
    y < 0 ||
    x >= rendered.width ||
    y >= rendered.height
  )
    return undefined;
  return {
    x: Math.min(frame.width - 1, Math.floor((x * frame.width) / rendered.width)),
    y: Math.min(frame.height - 1, Math.floor((y * frame.height) / rendered.height)),
  };
}
