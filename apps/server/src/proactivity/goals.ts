import type { Goal } from "../../../../packages/domain/src/agent.ts";

const normalize = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/[.!]$/, "")
    .replace(/[“”"']/g, "")
    .replace(/\s+/g, " ");
/** Human provenance requires a current, explicit declaration naming the saved item. */
export function goalDeclarationMatches(
  text: string,
  goal: Goal,
  change: {
    status?: Goal["status"];
    milestone?: { id: string; done?: boolean; title?: string };
  },
) {
  if (Boolean(change.status) === Boolean(change.milestone)) return false;
  const milestone = change.milestone
    ? goal.milestones.find((m) => m.id === change.milestone!.id)
    : undefined;
  if (change.milestone && !milestone) return false;
  const item = milestone ?? goal;
  const names = new Set([normalize(item.id), normalize(item.title)]);
  const value = normalize(text);
  if (change.milestone?.title) {
    if (change.milestone.done !== undefined) return false;
    const rename = value.match(
      /^(?:rename|renomeie|benenne)\s+(?:step|milestone|etapa|schritt)\s+(.+?)\s+(?:to|para|in)\s+(.+)$/,
    );
    return Boolean(
      rename && names.has(rename[1]) && rename[2] === normalize(change.milestone.title),
    );
  }
  const command = value.match(
    /^(?:mark(?: the| my)?|marque(?: a| o)?|markiere(?: den| das)?)\s+(?:goal|step|milestone|meta|objetivo|etapa|ziel|schritt)\s+(.+?)\s+(?:as|como|als)\s+(done|completed|pending|active|paused|conclu[ií]d[ao]|feit[ao]|pendente|ativ[ao]|pausad[ao]|erledigt|offen|aktiv|pausiert)$/,
  );
  const completion =
    value.match(/^(?:i (?:finished|completed)|(?:eu )?(?:terminei|conclu[ií]|fiz))\s+(.+)$/) ??
    value.match(/^ich habe\s+(.+?)\s+(?:erledigt|abgeschlossen)$/);
  const name = command?.[1] ?? completion?.[1];
  if (!name || !names.has(name)) return false;
  const state = command?.[2] ?? "completed";
  const completed = /^(?:done|completed|conclu[ií]d[ao]|feit[ao]|erledigt)$/.test(state);
  if (change.milestone?.done !== undefined)
    return change.milestone.done ? completed : /^(?:pending|pendente|offen)$/.test(state);
  return change.status === "completed"
    ? completed
    : change.status === "paused"
      ? /^(?:paused|pausad[ao]|pausiert)$/.test(state)
      : /^(?:active|ativ[ao]|aktiv)$/.test(state);
}
