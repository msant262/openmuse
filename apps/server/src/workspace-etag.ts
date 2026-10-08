import { createHash } from "node:crypto";
import type { Store } from "./db.ts";

export async function workspaceReadEtag(db: Store, owner: string, resource: string) {
  const version = await db.workspaceVersion(owner, resource);
  // Refresh time-dependent health and expiration even when no records change.
  return `"${createHash("sha256")
    .update(`${owner}:${resource}:${version}:${Math.floor(Date.now() / 15000)}`)
    .digest("hex")}"`;
}
