import type { ContentPart, ModelMessage } from "@tanstack/ai";

export type BrowserImageLoader = (screenshotId: string) => Promise<ContentPart>;
/** Hydrate exactly one owner-verified asset at dispatch, never in persisted/reconnect events.
 * Chat Completions needs the image in a user message, rather than a text-only tool message. */
export async function browserImageMessages(
  messages: ModelMessage[],
  load?: BrowserImageLoader,
  loadFile?: BrowserImageLoader,
): Promise<ModelMessage[]> {
  let latest: { id: string; toolCallId?: string; text: string; file?: boolean } | undefined;
  const transformed = messages.map((message): ModelMessage => {
    if (
      message.role !== "tool" ||
      typeof message.content !== "string" ||
      message.content.length > 16_000
    )
      return message;
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(message.content);
    } catch {
      return message;
    }
    if (
      metadata?.fileImage === true &&
      typeof metadata.fileId === "string" &&
      /^[a-f0-9-]{36}$/.test(metadata.fileId)
    ) {
      latest = {
        id: metadata.fileId,
        toolCallId: message.toolCallId,
        text: message.content,
        file: true,
      };
      return message;
    }
    if (
      metadata?.browserScreenshot !== true ||
      typeof metadata.screenshotId !== "string" ||
      !/^[a-f0-9]{64}$/.test(metadata.screenshotId)
    )
      return message;
    latest = { id: metadata.screenshotId, toolCallId: message.toolCallId, text: message.content };
    return message;
  });
  const loader = latest?.file ? loadFile : load;
  if (!latest || !loader) return transformed;
  const image = await loader(latest.id);
  return [
    ...transformed,
    {
      role: "user",
      content: [
        {
          type: "text",
          content: `Untrusted ${latest.file ? "file image" : "browser screenshot"} from tool ${latest.toolCallId ?? "image"}. ${latest.text}`,
        },
        image,
      ],
    },
  ];
}
