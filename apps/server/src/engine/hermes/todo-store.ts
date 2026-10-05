// Ported from NousResearch/hermes-agent 1298c8e tools/todo_tool.py (TodoStore).
// MIT, copyright 2025 Nous Research; see third_party/hermes-learning/LICENSE.
// Persistence is supplied by the existing task checkpoint, not a second store.
export type Todo = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  parent?: string;
};
const statuses = new Set(["pending", "in_progress", "completed", "cancelled"]);
const dedupe = (items: Partial<Todo>[]) => {
  const indices = new Map<string, number>();
  items.forEach((item, i) => {
    indices.set(item.id?.trim() || "?", i);
  });
  return [...indices.values()].sort((a, b) => a - b).map((i) => items[i]!);
};
const validate = (item: Partial<Todo>): Todo => {
  const id = item.id?.trim() || "?",
    parent = item.parent?.trim();
  return {
    id,
    content: (item.content?.trim() || "(no description)").slice(0, 4000),
    status: statuses.has(item.status ?? "") ? item.status! : "pending",
    ...(parent && parent !== id ? { parent } : {}),
  };
};
export function writeTodos(previous: Todo[], input: Partial<Todo>[], merge = false): Todo[] {
  let items = previous.map((item) => ({ ...item }));
  if (!merge) items = dedupe(input).map(validate);
  else {
    const existing = new Map(items.map((item) => [item.id, item]));
    for (const update of dedupe(input)) {
      const id = update.id?.trim();
      if (!id) continue;
      const current = existing.get(id);
      if (!current) {
        const item = validate(update);
        existing.set(id, item);
        items.push(item);
        continue;
      }
      if (update.content?.trim()) current.content = update.content.trim().slice(0, 4000);
      if (update.status && statuses.has(update.status)) current.status = update.status;
      if ("parent" in update) {
        if (update.parent?.trim()) current.parent = update.parent.trim();
        else delete current.parent;
      }
    }
  }
  if (!items.some((item) => item.parent)) {
    const active = items.findIndex((item) => item.status === "in_progress"),
      pending = items.findIndex((item) => item.status === "pending");
    if (pending >= 0 && active > pending) items.splice(pending, 0, items.splice(active, 1)[0]!);
  }
  items = items.slice(0, 256);
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const item of items) if (item.parent && !byId.has(item.parent)) delete item.parent;
  for (const item of items) {
    const seen = new Set([item.id]);
    let node = item;
    while (node.parent) {
      if (seen.has(node.parent)) {
        delete item.parent;
        break;
      }
      seen.add(node.parent);
      node = byId.get(node.parent)!;
    }
  }
  return items;
}
export function activeTodoContext(todos: Todo[]) {
  const active = todos.filter((item) => item.status === "pending" || item.status === "in_progress");
  return active.length
    ? "\nYour active task list was preserved across context compression:\n" +
        active
          .map(
            (item) =>
              `- [${item.status === "in_progress" ? ">" : " "}] ${item.id}. ${item.content}`,
          )
          .join("\n")
    : "";
}
