import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type {
  DirectiveReceipt,
  TaskMailbox as Mail,
} from "../../../../packages/domain/src/runtime.ts";
import { type ConversationInbox, messageContentHash } from "../conversation-inbox.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { LostLeaseError } from "./worker.ts";

/** M2's accepted inbox is the sole producer. This class consumes those records. */
export class TaskMailbox {
  constructor(
    private readonly db: Store,
    private readonly inbox: ConversationInbox,
  ) {}
  async enqueue(
    owner: string,
    taskId: string,
    input: {
      clientMessageId: string;
      text: string;
      expectedRevision?: number;
      threadId?: string;
      attachmentIds?: string[];
    },
  ): Promise<DirectiveReceipt> {
    const task = await this.db.get<AgentTask>(owner, "tasks", taskId);
    if (!task) throw new AppError("Task not found", 404);
    const message = {
      threadId: input.threadId ?? task.originThreadId ?? `task-${taskId}`,
      clientMessageId: input.clientMessageId,
      text: input.text,
      attachmentIds: input.attachmentIds ?? [],
      targetTaskId: taskId,
    };
    await this.inbox.acceptMessage(
      owner,
      { ...message, contentHash: messageContentHash(message) },
      0,
      input.expectedRevision,
    );
    const receipt = await this.db.get<Mail>(
      owner,
      "task-mailbox",
      `directive:${message.threadId}:${input.clientMessageId}`,
    );
    if (!receipt) throw new Error("Accepted direction has no durable mailbox receipt");
    return receipt;
  }
  async apply(owner: string, taskId: string, runToken: string): Promise<AgentTask> {
    const task = await this.db.applyTaskMailbox<AgentTask>(owner, taskId, runToken);
    if (!task) throw new LostLeaseError();
    return task;
  }
  async list(owner: string, taskId: string) {
    return (await this.db.list<Mail>(owner, "task-mailbox"))
      .filter((mail) => mail.taskId === taskId)
      .sort((a, b) => a.seq - b.seq);
  }
}
