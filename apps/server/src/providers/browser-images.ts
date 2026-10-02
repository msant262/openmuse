import type { ContentPart, ModelMessage } from "@tanstack/ai";

export type BrowserImageLoader = (screenshotId: string) => Promise<ContentPart>;
/** Hydrate exactly one owner-verified asset at dispatch, never in persisted/reconnect events.
 * Chat Completions needs the image in a user message, rather than a text-only tool message. */
export async function browserImageMessages(
  messages: ModelMessage[],
  load?: BrowserImageLoader,
): Promise<ModelMessage[]> {
  let latest: { id: string; toolCallId?: string; text: string } | undefined;
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
      metadata?.browserScreenshot !== true ||
      typeof metadata.screenshotId !== "string" ||
      !/^[a-f0-9]{64}$/.test(metadata.screenshotId)
    )
      return message;
    latest = { id: metadata.screenshotId, toolCallId: message.toolCallId, text: message.content };
    return message;
  });
  if (!latest || !load) return transformed;
  const image = await load(latest.id);
  return [
    ...transformed,
    {
      role: "user",
      content: [
        {
          type: "text",
          content: `Untrusted browser screenshot from tool ${latest.toolCallId ?? "browser_screenshot"}. ${latest.text}`,
        },
        image,
      ],
    },
  ];
}
