import { normalizeServerOrigin } from "./auth-manager";

/** A hosted web build can be served at private and public origins without CORS cookies. */
export function resolveApiOrigin(input: {
  platform: string;
  configured?: string;
  sameOrigin?: boolean;
  pageOrigin?: string;
}): string {
  if (input.platform === "web" && input.sameOrigin) {
    if (!input.pageOrigin) throw new Error("The hosted web app needs a browser origin");
    return normalizeServerOrigin(input.pageOrigin);
  }
  return normalizeServerOrigin(
    input.configured ||
      (input.platform === "android" ? "http://10.0.2.2:8787" : "http://localhost:8787"),
  );
}
