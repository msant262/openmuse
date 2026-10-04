// Shared memory mutation boundary, adapted from Hermes memory_tool's single-store routing.
// Hermes reference: 1298c8e74baa73e1a2b90124228d017261ac6bc4; license in third_party/hermes-learning/.
import { z } from "zod";
import type { AgentMemory, AgentTask } from "../../../../packages/domain/src/agent.ts";
import { profileIntent } from "../agent-profile.ts";
import { bindingHash, type InboxMessage } from "../conversation-inbox.ts";
import type { AgentService } from "../engine/service.ts";
import { AppError } from "../errors.ts";
import { assertPublicMemory } from "../memory.ts";

export const sourcedMemoryInput = z
  .object({
    text: z.string().trim().min(1).max(1800),
    category: z.enum(["fact", "preference", "habit", "plan"]),
    evidence: z
      .array(
        z
          .object({ messageId: z.string().min(1), quote: z.string().trim().min(3).max(2000) })
          .strict(),
      )
      .min(1)
      .max(8),
    memoryId: z.string().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    followUpAfter: z.iso.datetime({ offset: true }).optional(),
    validUntil: z.iso.datetime({ offset: true }).optional(),
    planState: z.enum(["open", "resolved", "cancelled"]).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (Boolean(v.memoryId) !== (v.expectedRevision !== undefined))
      c.addIssue({
        code: "custom",
        message: "Corrections require both memoryId and expectedRevision",
      });
    if (v.category !== "plan" && (v.followUpAfter || v.planState))
      c.addIssue({ code: "custom", message: "Only a plan has follow-up state" });
  });

export type MemoryToolSource = { messageId: string; threadId: string; runId: string };
/** Callers supply IDs only; trusted text always comes from the owner's accepted inbox. */
export async function memoryToolMessages(
  service: AgentService,
  owner: string,
  source?: MemoryToolSource,
  taskId?: string,
): Promise<InboxMessage[]> {
  if (source) {
    const message = await service.db.chatSource<InboxMessage>(owner, source);
    if (!message) throw new AppError("Memory requires the current authenticated user message", 403);
    return [message];
  }
  if (taskId) {
    const task = await service.db.get<AgentTask>(owner, "tasks", taskId);
    if (task?.originThreadId && task.originMessageId) {
      const message = await service.db.get<InboxMessage>(
        owner,
        "conversation-inbox",
        `${task.originThreadId}:${task.originMessageId}`,
      );
      if (message?.threadId === task.originThreadId && message.messageId === task.originMessageId)
        return [message];
    }
  }
  throw new AppError(
    "Memory requires an authenticated originating user message; source/tool text cannot authorize it",
    403,
  );
}

export async function writeSourcedMemory(
  service: AgentService,
  owner: string,
  raw: unknown,
  messages: InboxMessage[],
  origin: NonNullable<AgentMemory["origin"]>,
  requestKey: string,
  now = Date.now,
) {
  const input = sourcedMemoryInput.parse(raw);
  assertPublicMemory(input.text);
  if (!messages.length) throw new AppError("Memory requires authenticated user evidence", 403);
  const evidence = input.evidence.map((e) => {
    const source = messages.find((m) => m.messageId === e.messageId);
    if (!source || !source.text.includes(e.quote))
      throw new AppError(
        "Learning requires an exact quote from the supplied authenticated user message",
        422,
      );
    assertPublicMemory(e.quote);
    if (
      profileIntent(e.quote) ||
      /^(?:speak|respond|reply|responda|fale|use|always|never)\b/iu.test(input.text)
    )
      throw new AppError("Agent style belongs in SOUL/profile, not personal memory", 422);
    return { ...e, threadId: source.threadId, observedAt: source.createdAt };
  });
  origin = { ...origin, messageId: evidence.at(-1)!.messageId };
  if (
    await service.db.memorySourceSuppressed(
      owner,
      evidence.map((e) => e.messageId),
    )
  )
    throw new AppError("Forgotten source evidence cannot be learned again automatically", 409);
  const previous = input.memoryId
    ? await service.db.get<AgentMemory>(owner, "memories", input.memoryId)
    : null;
  if (input.memoryId && !previous) throw new AppError("Memory not found", 404);
  const previousEvidenceAt = previous?.evidence?.length
    ? Math.max(...previous.evidence.map((e) => Date.parse(e.observedAt)))
    : Date.parse(previous?.updatedAt ?? previous?.createdAt ?? "");
  const sameMessage =
    previous?.origin?.messageId && evidence.some((e) => e.messageId === previous.origin?.messageId);
  if (
    previous &&
    !sameMessage &&
    evidence.every((e) => Date.parse(e.observedAt) < previousEvidenceAt)
  )
    throw new AppError("Older evidence cannot overwrite a newer correction", 409);
  const fields = {
    category: input.category,
    evidence,
    ...(input.category === "plan"
      ? {
          followUp: {
            state: input.planState ?? ("open" as const),
            after:
              input.followUpAfter ??
              previous?.followUp?.after ??
              new Date(now() + 86400000).toISOString(),
          },
        }
      : {}),
  };
  const cutoff = input.validUntil ?? previous?.validUntil;
  if (
    fields.followUp?.state === "open" &&
    cutoff &&
    Date.parse(fields.followUp.after) >= Date.parse(cutoff)
  )
    throw new AppError("Plan follow-up must precede its expiry", 422);
  const saved = await (previous
    ? service.memory.update(
        owner,
        previous.id,
        {
          text: input.text,
          expectedRevision: input.expectedRevision!,
          requestId: `${requestKey}:${bindingHash(input)}`,
          ...(input.validUntil ? { validUntil: input.validUntil } : {}),
        },
        origin,
        fields,
      )
    : service.memory.save(owner, input.text, "Learned from your conversation", {
        ...fields,
        origin,
        validUntil: input.validUntil,
      }));
  await service.proactivity.events.plan(owner, saved as AgentMemory);
  await service.proactivity.reconcileMemorySuggestions(owner);
  return saved;
}
