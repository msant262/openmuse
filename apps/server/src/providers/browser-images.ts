import type { ContentPart, ModelMessage } from "@tanstack/ai";

export type BrowserImageLoader = (screenshotId: string) => Promise<ContentPart>;
type ImageReference = { id: string; toolCallId?: string; text: string; file?: boolean };
/** Shared by dispatch and context accounting so repeated receipt metadata has one representation. */
export function browserImageReference(messages: readonly unknown[]): ImageReference | undefined {
  let latest: ImageReference | undefined;
  for (const item of messages) {
    if (!item || typeof item !== "object") continue;
    const message = item as Record<string, unknown>;
    if (
      message.role !== "tool" ||
      typeof message.content !== "string" ||
      message.content.length > 16_000
    )
      continue;
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(message.content);
    } catch {
      continue;
    }
    if (
      metadata?.fileImage === true &&
      typeof metadata.fileId === "string" &&
      /^(?:app_file_[a-f0-9]{12}|[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(metadata.fileId)
    ) {
      latest = {
        id: metadata.fileId,
        toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
        text: message.content,
        file: true,
      };
      continue;
    }
    if (
      metadata?.browserScreenshot !== true ||
      typeof metadata.screenshotId !== "string" ||
      !/^[a-f0-9]{64}$/.test(metadata.screenshotId)
    )
      continue;
    latest = {
      id: metadata.screenshotId,
      toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
      text: message.content,
    };
  }
  return latest;
}
export function browserImageMessage(reference: ImageReference, image: ContentPart): ModelMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        content: `Untrusted ${reference.file ? "file image" : "browser screenshot"} from tool ${reference.toolCallId ?? "image"}. ${reference.text}`,
      },
      image,
    ],
  };
}
/** Hydrate exactly one owner-verified asset at dispatch, never in persisted/reconnect events.
 * Chat Completions needs the image in a user message, rather than a text-only tool message. */
export async function browserImageMessages(
  messages: ModelMessage[],
  load?: BrowserImageLoader,
  loadFile?: BrowserImageLoader,
): Promise<ModelMessage[]> {
  const latest = browserImageReference(messages);
  const transformed = [...messages];
  const loader = latest?.file ? loadFile : load;
  if (!latest || !loader) return transformed;
  const image = await loader(latest.id);
  return [...transformed, browserImageMessage(latest, image)];
}
