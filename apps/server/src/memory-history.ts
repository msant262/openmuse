import type { RevisionEntry } from "../../../packages/domain/src/agent.ts";
import type { Store } from "./db.ts";

/** Authoritative snapshots in the same database as facts/profiles; never Markdown. */
export class RevisionHistory<T> {
  constructor(
    private readonly db: Store,
    readonly kind: string,
  ) {}
  id(entityId: string, revision: number) {
    return `${entityId}:${revision}`;
  }
  entry(
    entityId: string,
    revision: number,
    value: T,
    action: RevisionEntry<T>["action"],
    changedAt: string,
  ): RevisionEntry<T> {
    return { id: this.id(entityId, revision), entityId, revision, value, action, changedAt };
  }
  get(owner: string, entityId: string, revision: number) {
    return this.db.get<RevisionEntry<T>>(owner, this.kind, this.id(entityId, revision));
  }
  page(owner: string, entityId: string, options: { cursor?: string; limit?: number } = {}) {
    return this.db.revisionPage<T>(owner, this.kind, entityId, options);
  }
}
