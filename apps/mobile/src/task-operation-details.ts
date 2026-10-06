export type TaskOperationDetail = {
  id: string;
  toolName: string;
  status: string;
  args?: unknown;
  receipt?: unknown;
};

export function taskOperationValue(value: unknown): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
