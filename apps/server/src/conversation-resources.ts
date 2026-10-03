import { createHash } from "node:crypto";
import type { AgentTask } from "../../../packages/domain/src/agent.ts";
import type { Artifact, BrowserSession } from "../../../packages/domain/src/index.ts";
import type { Store } from "./db.ts";
import type { LiveDesktopFrame } from "./desktop-frames.ts";
import type { DesktopService } from "./desktop-service.ts";
import { AppError } from "./errors.ts";
import type { Files } from "./files.ts";

type InboxSource = {
  threadId: string;
  clientMessageId: string;
  text: string;
  attachmentIds: string[];
  annotations?: {
    reference: { kind: string; snapshotArtifactId?: string };
    comment: string;
  }[];
};
type ManualTranscript = {
  id: string;
  request: { method: string; args: { threadId?: string } };
  result?: { attachments?: { fileId?: string }[] };
};
type FileOrigin =
  | { kind: "conversation"; messageId: string; text: string }
  | { kind: "task"; taskId: string; title: string }
  | { kind: "frame"; messageId: string; comment: string };

export type ConversationFileResource = {
  file: Artifact;
  version: string;
  availableOffline: boolean;
  origins: FileOrigin[];
};
export type ConversationSessionResource = {
  browser: BrowserSession;
  state: "active" | "offline" | "idle" | "expired";
  taskId: string;
  taskTitle: string;
};

export async function conversationResources(
  db: Store,
  files: Files,
  owner: string,
  threadId: string,
  options: {
    reachable: () => Promise<boolean>;
    decorateBrowser: (owner: string, browser: BrowserSession) => BrowserSession;
    desktop?: DesktopService;
  },
) {
  const [messages, tasks, manualTranscripts, artifacts, reachable] = await Promise.all([
    db
      .list<InboxSource>(owner, "conversation-inbox")
      .then((values) => values.filter((item) => item.threadId === threadId)),
    db
      .list<AgentTask>(owner, "tasks")
      .then((values) => values.filter((task) => task.originThreadId === threadId)),
    db.list<ManualTranscript>(owner, "native-manual-operations"),
    files.list(owner),
    options.reachable().catch(() => false),
  ]);
  const origins = new Map<string, FileOrigin[]>();
  const addOrigin = (id: string, origin: FileOrigin) => {
    const value = origins.get(id) ?? [];
    if (
      !value.some((item) => {
        if (item.kind !== origin.kind) return false;
        if (item.kind === "conversation" && origin.kind === "conversation")
          return item.messageId === origin.messageId;
        if (item.kind === "task" && origin.kind === "task") return item.taskId === origin.taskId;
        return (
          item.kind === "frame" && origin.kind === "frame" && item.messageId === origin.messageId
        );
      })
    )
      value.push(origin);
    origins.set(id, value);
  };
  for (const message of messages)
    for (const id of message.attachmentIds ?? [])
      addOrigin(id, {
        kind: "conversation",
        messageId: message.clientMessageId,
        text: message.text,
      });
  for (const message of messages)
    for (const annotation of message.annotations ?? [])
      if (annotation.reference.snapshotArtifactId)
        addOrigin(annotation.reference.snapshotArtifactId, {
          kind: "frame",
          messageId: message.clientMessageId,
          comment: annotation.comment,
        });
  const sessionOrigins = new Map<string, { task: AgentTask }[]>();
  for (const task of tasks) {
    for (const id of task.artifactIds ?? [])
      addOrigin(id, { kind: "task", taskId: task.id, title: task.title });
    for (const id of [task.state.browserId, task.state.sessionId])
      if (typeof id === "string") {
        const value = sessionOrigins.get(id) ?? [];
        value.push({ task });
        sessionOrigins.set(id, value);
      }
  }
  for (const operation of manualTranscripts) {
    if (
      operation.request.method !== "transcribe_attachment" ||
      operation.request.args.threadId !== threadId
    )
      continue;
    const task = tasks.find((value) => value.id === operation.id);
    for (const output of operation.result?.attachments ?? [])
      if (output.fileId)
        addOrigin(output.fileId, {
          kind: "task",
          taskId: operation.id,
          title: task?.title ?? "Audio transcription",
        });
  }
  const allFiles = new Map(artifacts.map((file) => [file.id, file]));
  const fileResources: ConversationFileResource[] = [];
  for (const [id, sourceOrigins] of origins) {
    const file = allFiles.get(id);
    if (!file) continue;
    try {
      const bytes = await files.bytes(owner, id);
      fileResources.push({
        file,
        version: createHash("sha256").update(bytes).digest("hex"),
        availableOffline: true,
        origins: sourceOrigins,
      });
    } catch {
      fileResources.push({ file, version: "", availableOffline: false, origins: sourceOrigins });
    }
  }
  const browserRows = await db.list<BrowserSession>(owner, "browsers");
  const sessions: ConversationSessionResource[] = [];
  for (const browser of browserRows) {
    const source = sessionOrigins.get(browser.id)?.[0];
    if (!source) continue;
    const state =
      browser.status === "closed" || browser.status === "error"
        ? "expired"
        : browser.status === "active" && !reachable
          ? "offline"
          : browser.status;
    sessions.push({
      browser: options.decorateBrowser(owner, browser),
      state,
      taskId: source.task.id,
      taskTitle: source.task.title,
    });
  }
  let frameAvailable = false;
  if (options.desktop) {
    try {
      const session = await options.desktop.session(owner);
      frameAvailable = (await db.list<LiveDesktopFrame>(owner, "desktop-live-frames")).some(
        (frame) =>
          frame.sessionId === session.id && frame.sessionGeneration === session.sessionGeneration,
      );
    } catch {
      frameAvailable = false;
    }
  }
  return {
    files: fileResources.sort((a, b) => b.file.createdAt.localeCompare(a.file.createdAt)),
    sessions: sessions.sort((a, b) => b.browser.updatedAt.localeCompare(a.browser.updatedAt)),
    frameAvailable,
  };
}

export async function currentConversationFrame(
  db: Store,
  desktop: DesktopService | undefined,
  owner: string,
  includeImage = true,
) {
  if (!desktop) throw new AppError("A current desktop frame is not configured", 503);
  const session = await desktop.session(owner);
  const frame = (await db.list<LiveDesktopFrame>(owner, "desktop-live-frames")).find(
    (value) =>
      value.sessionId === session.id && value.sessionGeneration === session.sessionGeneration,
  );
  if (!frame?.frameId)
    throw new AppError("No current frame is available; capture the desktop first", 409);
  return {
    frameId: frame.frameId,
    sessionGeneration: frame.sessionGeneration,
    width: frame.width,
    height: frame.height,
    mimeType: frame.mimeType,
    ...(includeImage ? { image: frame.image } : {}),
  };
}
