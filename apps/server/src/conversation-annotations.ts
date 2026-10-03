import { createHash } from "node:crypto";
import type { AcceptedMessageInput } from "../../../packages/domain/src/runtime.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

type Annotation = NonNullable<AcceptedMessageInput["annotations"]>[number];
type ChatMessage = { id: string; content?: unknown };

/** Rechecks every source at durable admission, before inbox or task-mailbox writes. */
export function createConversationAnnotationValidator(dependencies: {
  db: Store;
  attachment: (owner: string, id: string) => Promise<{ bytes: Uint8Array; mimeType: string }>;
  history: (owner: string, threadId: string) => Promise<ChatMessage[]>;
  desktopSession?: (owner: string) => Promise<{ id: string; sessionGeneration: string }>;
  snapshotFrame?: (
    owner: string,
    threadId: string,
    clientMessageId: string,
    frame: { frameId: string; mimeType: string; image: string },
  ) => Promise<{ artifactId: string; version: string }>;
}) {
  return async (
    owner: string,
    threadId: string,
    clientMessageId: string,
    attachmentIds: string[],
    annotations: Annotation[],
  ) => {
    if (!annotations.length) return annotations;
    const savedFrames = new Map<string, { artifactId: string; version: string }>();
    const validated: Annotation[] = [];
    let messages: ChatMessage[] | undefined;
    for (const annotation of annotations) {
      const reference = annotation.reference;
      if (reference.kind === "message") {
        messages ??= await dependencies.history(owner, threadId);
        const source = messages.find((message) => message.id === reference.messageId);
        if (!source || typeof source.content !== "string")
          throw new AppError("The cited message is no longer in this conversation", 409);
        if (reference.quote && !source.content.includes(reference.quote))
          throw new AppError(
            "The cited text changed; refresh the conversation before sending",
            409,
          );
        validated.push(annotation);
      } else if (reference.kind === "attachment") {
        if (!attachmentIds.includes(reference.attachmentId))
          throw new AppError("Attach the cited file to this message before sending", 422);
        let current: { bytes: Uint8Array; mimeType: string };
        try {
          current = await dependencies.attachment(owner, reference.attachmentId);
        } catch {
          throw new AppError(
            "The cited file was removed or is no longer available to this account",
            409,
          );
        }
        if (reference.region && !current.mimeType.startsWith("image/"))
          throw new AppError("Image regions can only refer to image attachments", 422);
        const version = createHash("sha256").update(current.bytes).digest("hex");
        if (version !== reference.version)
          throw new AppError("The cited file changed; refresh it before sending", 409);
        validated.push(annotation);
      } else {
        if (!dependencies.desktopSession || !dependencies.snapshotFrame)
          throw new AppError("Desktop frame citations are unavailable on this conversation", 409);
        let session: { id: string; sessionGeneration: string };
        try {
          session = await dependencies.desktopSession(owner);
        } catch {
          throw new AppError(
            "The desktop frame expired; capture a fresh frame before sending",
            409,
          );
        }
        const frame = (
          await dependencies.db.list<{
            sessionId: string;
            sessionGeneration: string;
            frameId?: string;
            mimeType: "image/png" | "image/jpeg";
            image: string;
          }>(owner, "desktop-live-frames")
        ).find((value) => value.frameId === reference.frameId);
        if (
          !frame ||
          frame.sessionId !== session.id ||
          frame.sessionGeneration !== session.sessionGeneration ||
          reference.sessionGeneration !== session.sessionGeneration
        )
          throw new AppError(
            "The desktop frame was replaced; mark a fresh frame before sending",
            409,
          );
        const frameId = reference.frameId;
        let saved = savedFrames.get(frameId);
        if (!saved) {
          try {
            saved = await dependencies.snapshotFrame(owner, threadId, clientMessageId, {
              frameId: reference.frameId,
              mimeType: frame.mimeType,
              image: frame.image,
            });
          } catch {
            throw new AppError(
              "The masked frame snapshot could not be saved; no message was accepted",
              503,
            );
          }
          savedFrames.set(frameId, saved);
        }
        validated.push({
          ...annotation,
          reference: {
            ...reference,
            snapshotArtifactId: saved.artifactId,
            snapshotVersion: saved.version,
          },
        });
      }
    }
    return validated;
  };
}
