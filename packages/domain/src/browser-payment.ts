// Internal server/worker protocol. Never expose authorization tokens to model or mobile.
import { createHmac, timingSafeEqual } from "node:crypto";
export interface BrowserPaymentBinding {
  snapshotId: string;
  element: number;
  action: Record<string, unknown>;
  url: string;
  frameUrl: string;
  fingerprint: string;
  formDigest: string;
  pageDigest: string;
}
export interface BrowserAuthorization {
  id: string;
  sessionId: string;
  expiresAt: number;
  binding: BrowserPaymentBinding;
}
export function signBrowserAuthorization(secret: string, payload: BrowserAuthorization) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`openmuse-reviewed-browser-v1:${data}`)
    .digest("base64url");
  return `${data}.${signature}`;
}
export function verifyBrowserAuthorization(secret: string, token: unknown): BrowserAuthorization {
  if (typeof token !== "string" || token.length > 60_000) throw new Error("Invalid authorization");
  const [data, signature, extra] = token.split(".");
  if (!data || !signature || extra) throw new Error("Invalid authorization");
  const expected = createHmac("sha256", secret)
    .update(`openmuse-reviewed-browser-v1:${data}`)
    .digest();
  const supplied = Buffer.from(signature, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    throw new Error("Invalid authorization");
  const value = JSON.parse(Buffer.from(data, "base64url").toString()) as BrowserAuthorization;
  if (
    !/^[a-f0-9]{64}$/.test(value.id) ||
    !/^[a-f0-9-]{36}$/i.test(value.sessionId) ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= Date.now() ||
    value.expiresAt > Date.now() + 31 * 60_000 ||
    !value.binding
  )
    throw new Error("Invalid or expired authorization");
  return value;
}
