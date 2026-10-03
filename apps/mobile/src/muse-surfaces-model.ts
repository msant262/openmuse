import type {
  AgentArtifact,
  AgentNotification,
  AgentTask,
  Idea,
  RunEvent,
} from "../../../packages/domain/src/agent";
import { credentialStatusSummary } from "./credential-prompts-state";

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
  status?: AgentTask["status"];
};

/** Internal desktop receipts and background scans remain in the activity log. */
export function isProductTask(task: AgentTask) {
  return !(
    task.input.internalActivity === true ||
    typeof task.input.proactivityCycleId === "string" ||
    task.prompt === "Authenticated desktop observation and control lifecycle" ||
    /^Perform the requested computer [a-z_]+ operation and retain its receipt$/.test(task.prompt)
  );
}

/** Also recognizes legacy orphan notices, without filtering arbitrary user task titles. */
export function isInternalNotice(notice: AgentNotification) {
  return (
    (notice.title === "Desktop viewer" && /^Desktop viewer (closed|expired)/.test(notice.body)) ||
    (/^Computer: [a-z_]+$/.test(notice.title) && notice.body === "Work completed") ||
    (notice.title === "Review pending personal work" && /^Personal review /.test(notice.body))
  );
}

/** A feed is a view of saved work. Coalesce a task and its latest notification. */
export function buildFeed(
  tasks: AgentTask[],
  notifications: AgentNotification[],
  artifacts: AgentArtifact[],
): FeedEntry[] {
  const entries: FeedEntry[] = tasks.filter(isProductTask).map((task) => {
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
      title: task.title,
      body:
        task.status === "failed"
          ? taskPreview(task)
          : useNotice && !/^(Saved the latest update\.|Work completed$)/.test(notice.body)
            ? notice.body
            : taskPreview(task),
      status: task.status,
      date: useNotice ? notice.createdAt : task.updatedAt,
      kind: task.kind,
      artifact,
    };
  });
  const taskIds = new Set(tasks.map((task) => task.id));
  for (const notice of notifications) {
    if (!isInternalNotice(notice) && (!notice.taskId || !taskIds.has(notice.taskId)))
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

/** Legacy operational summaries have no useful result; show the real task state. */
export function taskPreview(task: AgentTask) {
  if (task.status === "failed" && !task.result)
    return "Could not finish this task. Open it to review or try again.";
  const text =
    task.question ||
    task.result ||
    task.error ||
    task.plan.find((step) => step.status === "running" || step.status === "waiting")?.title ||
    "";
  const credential = credentialStatusSummary(text);
  if (credential) return credential;
  if (
    text &&
    !/^(Saved the latest update\.|Work completed$|Choose a current email with a PDF attachment)/.test(
      text,
    )
  )
    return text;
  if (task.status === "failed")
    return "Could not finish this task. Open it to review or try again.";
  if (task.status === "succeeded") return "Completed";
  if (task.status === "cancelled") return "Cancelled";
  if (task.status === "paused") return "Paused";
  if (task.status === "waiting_input") return "Your input is needed";
  if (task.status === "waiting_approval") return "Waiting for approval";
  if (task.status === "queued" || task.status === "scheduled") return "Scheduled";
  return "In progress";
}

export function productNotifications(tasks: AgentTask[], notifications: AgentNotification[]) {
  const internal = new Set(tasks.filter((task) => !isProductTask(task)).map((task) => task.id));
  return notifications.filter(
    (notice) => !isInternalNotice(notice) && (!notice.taskId || !internal.has(notice.taskId)),
  );
}
