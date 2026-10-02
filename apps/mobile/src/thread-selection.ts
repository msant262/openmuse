export type SavedThreadSelection = {
  mainId: string;
  selection: { id: string; existing: boolean };
  visited: { id: string; existing: boolean }[];
};
export function parseThreadSelection(raw: string | null): SavedThreadSelection | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as SavedThreadSelection;
    const valid = (item: { id: string; existing: boolean }) =>
      !!item &&
      typeof item.id === "string" &&
      /^[\w.-]{1,256}$/.test(item.id) &&
      typeof item.existing === "boolean";
    return typeof value.mainId === "string" &&
      valid(value.selection) &&
      Array.isArray(value.visited) &&
      value.visited.every(valid)
      ? value
      : null;
  } catch {
    return null;
  }
}
/** Close the menu before navigation so its dismissal cannot clear the new screen. */
export function navigateFromThreadMenu(close: () => void, navigate: () => void) {
  close();
  navigate();
}
