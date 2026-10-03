import { createTaskSchema } from "../../../../packages/domain/src/agent.ts";

/** `document` is the legacy selected-mail PDF form workflow, not a creation format. */
export function taskInput(raw: unknown) {
  const input = createTaskSchema.parse(raw);
  if (
    input.kind === "document" &&
    !(typeof input.input.messageId === "string" && input.input.messageId.trim())
  )
    return { ...input, kind: "agent" as const };
  return input;
}
