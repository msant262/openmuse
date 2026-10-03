import type {
  AgentArtifact,
  AgentNotification,
  AgentTask,
  Idea,
  RunEvent,
} from "../../../packages/domain/src/agent";

export function subjectIllustration(text: string, kind?: string) {
  if (/travel|trip|flight|hotel|via(gem|jar)|voo|viagem|férias/i.test(text)) return "🌍";
  if (/family|child|school|college|família|filho|escola/i.test(text)) return "🏡";
  if (/health|sleep|training|fitness|saúde|sono|treino/i.test(text)) return "🌙";
  if (/dinner|restaurant|food|table|jantar|restaurante|comida/i.test(text)) return "🍽️";
  if (kind === "finance" || /money|spend|saving|budget|financ|dinheiro|gasto/i.test(text))
    return "💰";
  if (kind === "document" || /document|permission|form|pdf|relatório/i.test(text)) return "📋";
  if (/code|app|project|site|código|projeto/i.test(text)) return "💻";
  if (/mail|message|inbox|email|mensage/i.test(text)) return "✉️";
  if (kind === "monitor") return "🔎";
  if (kind === "plan") return "🗓️";
  return "✨";
}

export function ideaCategory(idea: Idea) {
  const text = `${idea.title} ${idea.reason}`;
  if (/family|child|school|college|família|filho|escola/i.test(text)) return "Family";
  if (/travel|trip|flight|hotel|via(gem|jar)|voo|férias/i.test(text)) return "Travel";
  if (/health|sleep|training|fitness|saúde|sono|treino/i.test(text)) return "Health";
  if (idea.kind === "finance" || /money|spend|saving|budget|financ|dinheiro|gasto/i.test(text))
    return "Finances";
  return "For you";
}

export type FeedEntry = {
  id: string;
  taskId?: string;
  title: string;
  body: string;
  date: string;
  kind?: string;
  artifact?: AgentArtifact;
};

/** A feed is a view of saved work. Coalesce a task and its latest notification. */
export function buildFeed(
  tasks: AgentTask[],
  notifications: AgentNotification[],
  artifacts: AgentArtifact[],
): FeedEntry[] {
  const entries: FeedEntry[] = tasks.map((task) => {
    const notice = notifications
      .filter((item) => item.taskId === task.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const artifact = artifacts
      .filter((item) => item.taskId === task.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const useNotice = notice && notice.createdAt >= task.updatedAt;
    return {
      id: `task:${task.id}`,
      taskId: task.id,
      title: useNotice ? notice.title : task.title,
      body: useNotice
        ? notice.body
        : task.question ||
          task.result ||
          task.error ||
          artifact?.summary ||
          task.plan.find((step) => step.status === "running" || step.status === "waiting")?.title ||
          task.prompt,
      date: useNotice ? notice.createdAt : task.updatedAt,
      kind: task.kind,
      artifact,
    };
  });
  const taskIds = new Set(tasks.map((task) => task.id));
  for (const notice of notifications) {
    if (!notice.taskId || !taskIds.has(notice.taskId))
      entries.push({
        id: `notice:${notice.id}`,
        taskId: notice.taskId,
        title: notice.title,
        body: notice.body,
        date: notice.createdAt,
      });
  }
  for (const artifact of artifacts) {
    if (!taskIds.has(artifact.taskId))
      entries.push({
        id: `artifact:${artifact.id}`,
        taskId: artifact.taskId,
        title: artifact.title,
        body: artifact.summary,
        date: artifact.createdAt,
        kind: artifact.kind,
        artifact,
      });
  }
  return entries.sort((a, b) => b.date.localeCompare(a.date));
}

export function orderedTaskEvents(events: RunEvent[]) {
  return [...events].sort((a, b) => a.date.localeCompare(b.date));
}

/** Keep form field identifiers in task details, outside the editorial excerpt. */
export function feedExcerpt(body: string) {
  const fields = body.indexOf("Supported fields:");
  return fields > 0 ? body.slice(0, fields).trim() : body;
}
