import { configuredSecretScrubber } from "./configured-secrets.ts";

const authentication =
  /password|passwd|secret|token|credential|authori[sz]ation|api[_-]?key|private[_-]?key|access[_-]?key|cookie|bearer|^(?:auth|authentication|headers|otp|pin)$|verification[_-]?code|session[_-]?(?:id|key)/i;
const businessPriority = (key: string) =>
  /amount|currency|recipient|payee|product|destination|account|quantity|price|total/i.test(key)
    ? 2
    : /description|items/i.test(key)
      ? 1
      : 0;
/** Readable native-review data only. Never use this preview as an execution binding or audit summary. */
export function mcpRequestPreview(
  args: Record<string, unknown>,
  configuredSecrets: string[],
): string {
  const scrub = configuredSecretScrubber(configuredSecrets);
  let budget = 4800,
    truncated = false;
  function visit(value: unknown, depth: number): unknown {
    if (typeof value === "string") {
      const text = scrub(value);
      const allowed = Math.max(0, Math.min(1600, budget));
      budget -= Math.min(text.length, allowed);
      if (text.length > allowed) {
        truncated = true;
        return `${text.slice(0, allowed)} [preview truncated]`;
      }
      return text;
    }
    if (value === null || typeof value !== "object") {
      budget -= 20;
      return value;
    }
    if (depth >= 6 || budget <= 0) {
      truncated = true;
      return "[preview truncated]";
    }
    const entries = Array.isArray(value)
      ? value.slice(0, 25).map((item, index) => [String(index), item] as const)
      : Object.entries(value).sort(([a], [b]) => businessPriority(b) - businessPriority(a));
    const output: Record<string, unknown> = Object.create(null),
      array: unknown[] = [];
    for (let index = 0; index < entries.length; index++) {
      if (index >= 24 || budget <= 0) {
        truncated = true;
        break;
      }
      const [key, part] = entries[index];
      const safeKey = scrub(key).slice(0, 100);
      if (safeKey !== key) truncated = true;
      budget -= safeKey.length + 8;
      const result = authentication.test(key) ? "[redacted]" : visit(part, depth + 1);
      if (Array.isArray(value)) array.push(result);
      else output[safeKey] = result;
    }
    return Array.isArray(value) ? array : output;
  }
  let preview = JSON.stringify(visit(args, 0), null, 2);
  if (preview.length > 7800) {
    preview = preview.slice(0, 7800);
    truncated = true;
  }
  return (
    preview + (truncated ? "\n[Preview truncated: review complete request before approving]" : "")
  );
}
