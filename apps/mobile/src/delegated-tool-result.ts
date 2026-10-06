/** Any server tool may hand work to the durable worker, including native Google tools. */
export function delegatedToolResult(
  result: unknown,
): { delegated: true; taskId: string } | undefined {
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") return undefined;
  const receipt = value as { delegated?: unknown; taskId?: unknown };
  return receipt.delegated === true && typeof receipt.taskId === "string" && receipt.taskId
    ? { delegated: true, taskId: receipt.taskId }
    : undefined;
}
