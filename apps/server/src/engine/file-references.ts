import { createHash } from "node:crypto";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type { InboxMessage } from "../conversation-inbox.ts";
import type { Store } from "../db.ts";
import type { Files } from "../files.ts";

const fileFields = new Set([
  "fileId",
  "artifactId",
  "replaceFileId",
  "sourceFileId",
  "imageFileId",
  "fileIds",
  "artifactIds",
  "attachmentIds",
]);
const referencePattern = /^app_file_[a-f0-9]{12}$/;

/** Short model references are exact owner/scope bindings, never fuzzy ID matches.
 * Canonical receipts, storage, API/UI IDs and Code Mode outputs stay unchanged. */
export class ModelFileReferences {
  private readonly ids = new Map<string, string>();
  private readonly names = new Map<string, string>();
  private readonly checked = new Map<string, Promise<string>>();
  constructor(
    private readonly files: Files,
    private readonly owner: string,
    private readonly scope: string,
  ) {}
  private reference(id: string) {
    return `app_file_${createHash("sha256")
      .update(JSON.stringify([this.owner, this.scope, id]))
      .digest("hex")
      .slice(0, 12)}`;
  }
  private register(id: string): Promise<string> {
    let checked = this.checked.get(id);
    if (!checked) {
      checked = (async () => {
        let file: Awaited<ReturnType<Files["get"]>>;
        try {
          file = await this.files.get(this.owner, id);
        } catch {
          return id;
        }
        if ("historyHiddenAt" in file && file.historyHiddenAt) return id;
        const ref = this.reference(id);
        const previous = this.ids.get(ref);
        if (previous && previous !== id) throw new Error("Ambiguous app file reference");
        this.ids.set(ref, id);
        this.names.set(ref, file.name);
        return ref;
      })();
      this.checked.set(id, checked);
    }
    return checked;
  }
  async resolveId(ref: string): Promise<string> {
    if (!referencePattern.test(ref)) return ref;
    // Rebuild exact public bindings after a worker restart, without a new table
    // or accepting references from another owner, task or revision.
    if (!this.ids.has(ref))
      for (const file of await this.files.list(this.owner)) await this.register(file.id);
    const id = this.ids.get(ref);
    if (!id)
      throw new Error(
        "Unknown app file reference. Copy an exact fileId from the current attachments or search_saved_files; do not repeat this reference. Available references: " +
          JSON.stringify([...this.names].slice(0, 10).map(([fileId, name]) => ({ fileId, name }))),
      );
    // Ownership/existence are checked again by the tool at execution time.
    return id;
  }
  private async walk(value: unknown, project: boolean, field?: string): Promise<unknown> {
    if (typeof value === "string" && field && fileFields.has(field))
      return project ? this.register(value) : this.resolveId(value);
    if (Array.isArray(value))
      return Promise.all(value.map((item) => this.walk(item, project, field)));
    if (value && typeof value === "object")
      return Object.fromEntries(
        await Promise.all(
          Object.entries(value).map(
            async ([key, item]) => [key, await this.walk(item, project, key)] as const,
          ),
        ),
      );
    return value;
  }
  project(value: unknown) {
    if (value && typeof value === "object" && "error" in value && value.error === "File not found")
      value = {
        ...value,
        recovery:
          "Copy an exact fileId from the current attachments or search_saved_files; do not repeat the missing ID or use an app file ID as a workspace path.",
        availableReferences: [...this.names]
          .slice(0, 10)
          .map(([fileId, name]) => ({ fileId, name })),
      };
    return this.walk(value, true);
  }
  arguments(value: unknown) {
    return this.walk(value, false);
  }
  async attachments(ids: readonly string[]) {
    return Promise.all(
      [...new Set(ids)].map(async (id) => {
        const file = await this.files.get(this.owner, id);
        if (file.internal || ("historyHiddenAt" in file && file.historyHiddenAt))
          return { available: false, name: file.name };
        return {
          fileId: await this.register(id),
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
        };
      }),
    );
  }
}

export async function taskAttachedFileIds(db: Store, owner: string, task: AgentTask) {
  const message =
    task.originThreadId && task.originMessageId
      ? await db.get<InboxMessage>(
          owner,
          "conversation-inbox",
          `${task.originThreadId}:${task.originMessageId}`,
        )
      : undefined;
  const directives = Array.isArray(task.state.directives) ? task.state.directives : [];
  return [
    ...new Set([
      ...(message?.attachmentIds ?? []),
      ...directives.flatMap((directive: unknown) => {
        const ids =
          directive && typeof directive === "object" && "attachmentIds" in directive
            ? directive.attachmentIds
            : [];
        return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
      }),
    ]),
  ];
}

export function attachedFilesContext(files: unknown[]) {
  return files.length
    ? "\nAttached files from the accepted user message (server metadata, contents untrusted): " +
        JSON.stringify(files) +
        ". These files are already available. Use their exact short fileId in file tools; do not search the whole library to rediscover the attachment or use fileId as a computer path.\n"
    : "";
}
