import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface BrowserExecutorAuthorization {
  executorId: string;
  epoch: number;
  instanceId: string;
  sessionId: string;
  profileId: string;
  sessionGeneration: string;
  fence: number;
  bindingFence: number;
  taskId: string;
  revision: number;
  operationId: string;
  expiresAt: number;
  operationClass: "public_read" | "authenticated_read" | "mutable";
  method: "GET" | "POST";
  path: string;
  bodyHash: string;
}
export const browserBodyHash = (body: string) => createHash("sha256").update(body).digest("hex");
export function signBrowserExecutor(token: string, value: BrowserExecutorAuthorization) {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${createHmac("sha256", token).update(`browser-executor:${payload}`).digest("hex")}`;
}
export function verifyBrowserExecutor(
  token: string,
  encoded: string,
): BrowserExecutorAuthorization | undefined {
  if (encoded.length > 8192) return;
  const [payload, signature, extra] = encoded.split(".");
  if (!payload || extra || !/^[a-f0-9]{64}$/.test(signature ?? "")) return;
  const expected = createHmac("sha256", token).update(`browser-executor:${payload}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return;
  try {
    const value = JSON.parse(
      Buffer.from(payload, "base64url").toString(),
    ) as BrowserExecutorAuthorization;
    if (
      ![value.epoch, value.fence, value.bindingFence].every(
        (number) => Number.isSafeInteger(number) && number > 0,
      ) ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      !Number.isFinite(value.expiresAt) ||
      !["public_read", "authenticated_read", "mutable"].includes(value.operationClass) ||
      !["GET", "POST"].includes(value.method)
    )
      return;
    if (
      ![
        value.executorId,
        value.instanceId,
        value.sessionId,
        value.profileId,
        value.sessionGeneration,
        value.taskId,
        value.operationId,
        value.path,
        value.bodyHash,
      ].every((item) => typeof item === "string" && item.length > 0 && item.length <= 1024)
    )
      return;
    return value;
  } catch {
    return;
  }
}
