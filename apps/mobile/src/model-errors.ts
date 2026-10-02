/** Only a fixed provider usage URL is eligible for an actionable error link. */
export function modelUsageUrl(error: string): string | undefined {
  return error.includes("https://chatgpt.com/settings/usage")
    ? "https://chatgpt.com/settings/usage"
    : undefined;
}
