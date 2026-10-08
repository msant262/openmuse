export type JsonCheckpoint<T> = { etag: string; value: T };

/** The social window uses POST only to carry message IDs; it is a read. */
export function invalidatesReadCache(path: string, method: string) {
  return (
    method !== "GET" &&
    !(method === "POST" && /^\/api\/conversations\/[^/]+\/social\/window$/.test(path))
  );
}

/** Cache only within one authenticated API instance; a 304 retains object identity. */
export class ConditionalJson {
  private entries = new Map<string, JsonCheckpoint<unknown>>();
  get<T>(path: string): JsonCheckpoint<T> | undefined {
    return this.entries.get(path) as JsonCheckpoint<T> | undefined;
  }
  save<T>(path: string, etag: string | null, value: T): T {
    if (etag) {
      this.entries.delete(path);
      this.entries.set(path, { etag, value });
      if (this.entries.size > 32) this.entries.delete(this.entries.keys().next().value ?? "");
    } else this.entries.delete(path);
    return value;
  }
  clear() {
    this.entries.clear();
  }
}
