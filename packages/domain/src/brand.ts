/** Product defaults; storage/package IDs intentionally keep their upstream names. */
export const PRODUCT_NAME = "OkamiBot";
export const DEFAULT_AGENT_PROFILE = {
  assistantName: PRODUCT_NAME,
  preferredUserName: "",
  personality: "",
  language: "en-US",
  tone: "warm" as const,
  formality: "neutral" as const,
  responseLength: "concise" as const,
  humor: "light" as const,
  emojis: true,
  textStyle: "plain" as const,
};
