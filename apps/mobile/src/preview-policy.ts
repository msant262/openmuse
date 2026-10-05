/** The visible viewer keeps renewing its 30s human permit even when idle. */
export function desktopPollDelay(visible: boolean, unchanged: number, human = false) {
  return visible ? (human ? 750 : unchanged >= 3 ? 6000 : 1500) : undefined;
}
export function inlinePreviewVisible(
  appActive: boolean,
  sectionVisible: boolean,
  viewerActive: boolean,
) {
  return appActive && sectionVisible && !viewerActive;
}
