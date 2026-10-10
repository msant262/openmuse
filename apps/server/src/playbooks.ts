import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { AgentTask } from "../../../packages/domain/src/agent.ts";
import {
  type Procedure,
  type ProcedureVersion,
  procedureCatalogSchema,
  procedureInputSchema,
  procedureManageSchema,
  procedureReadSchema,
  procedureRunSchema,
} from "../../../packages/domain/src/playbooks.ts";
import { configuredSecretScrubber } from "./configured-secrets.ts";
import type { InboxMessage } from "./conversation-inbox.ts";
import { bindingHash } from "./conversation-inbox.ts";
import type { AgentService } from "./engine/service.ts";
import { AppError } from "./errors.ts";
import { RevisionHistory } from "./memory-history.ts";

type Source = { messageId: string; threadId: string; runId: string };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export class Playbooks {
  private readonly revisions: RevisionHistory<ProcedureVersion>;
  constructor(readonly service: AgentService) {
    this.revisions = new RevisionHistory(service.db, "procedure-history");
  }
  catalog(owner: string, raw: unknown = {}) {
    return this.service.db.procedureCatalog(owner, procedureCatalogSchema.parse(raw));
  }
  async resolveSkillReference(owner: string, reference: string) {
    const prefix = /^ref-([a-f0-9]{16})$/.exec(reference)?.[1];
    if (!prefix) return reference;
    const ids = await this.service.db.learnedProcedureIds(owner, prefix);
    if (!ids.length) throw new AppError("Procedure not found", 404);
    if (ids.length !== 1) throw new AppError("Ambiguous skill reference; use its full ID", 409);
    return ids[0];
  }
  async read(owner: string, raw: unknown, viewKey?: string) {
    const input = procedureReadSchema.parse(raw);
    const record = await this.get(owner, input.id);
    const version = input.version ?? record.version;
    const value =
      record.versions.find((p) => p.version === version) ??
      (await this.revisions.get(owner, input.id, version))?.value;
    if (!value) throw new AppError("Procedure version not found", 404);
    if (viewKey)
      await this.service.db.insertIfAbsent(owner, "procedure-views", {
        id: hash(`${viewKey}:${input.id}:${version}`),
        procedureId: input.id,
        procedureVersion: version,
        viewedAt: new Date().toISOString(),
      });
    return value;
  }
  async history(owner: string, id: string, options: { cursor?: string; limit?: number } = {}) {
    await this.migrateHistory(owner, await this.get(owner, id));
    return this.revisions.page(owner, id, options);
  }
  async usage(owner: string, id: string, version?: number) {
    await this.get(owner, id);
    return this.service.db.procedureUsage(owner, id, version);
  }
  async recordOutcome(owner: string, taskId: string) {
    const task = await this.service.db.get<AgentTask>(owner, "tasks", taskId);
    if (!task || task.deletedAt) return;
    if (!["succeeded", "failed", "cancelled"].includes(task.status)) return;
    const run = await this.service.db.procedureRunForTask<{
      procedureId?: string;
      procedureVersion?: number;
    }>(owner, taskId);
    if (!run?.procedureId || !run.procedureVersion) return;
    const pinned = task.input.procedure as { id?: string; version?: number } | undefined;
    if (pinned?.id !== run.procedureId || pinned.version !== run.procedureVersion)
      throw new AppError("Procedure outcome does not match the version actually queued", 409);
    const outcome =
      task.status === "succeeded"
        ? task.completion?.status === "verified"
          ? "verified"
          : "partial"
        : task.status;
    await this.service.db.insertIfAbsent(owner, "procedure-outcomes", {
      id: hash(`${task.id}:${task.attempts}:${run.procedureId}:${run.procedureVersion}`),
      procedureId: run.procedureId,
      procedureVersion: run.procedureVersion,
      taskId,
      attempt: task.attempts,
      outcome,
      finishedAt: task.updatedAt,
    });
  }
  private async migrateHistory(owner: string, record: Procedure | undefined) {
    if (!record || record.historyVersion === 1) return;
    for (const value of record.versions) {
      await this.service.db.insertIfAbsent(
        owner,
        this.revisions.kind,
        this.revisions.entry(record.id, value.version, value, "migrate", value.savedAt),
      );
      await this.service.db.insertIfAbsent(owner, "procedure-writes", {
        id: hash(`${record.id}:${value.requestId}`),
        binding: value.binding,
        version: value.version,
      });
    }
  }
  private async commit(owner: string, previous: Procedure | undefined, version: ProcedureVersion) {
    await this.migrateHistory(owner, previous);
    const record: Procedure = {
      id: version.id,
      version: version.version,
      historyVersion: 1,
      versions: [...(previous?.versions ?? []).slice(-29), version],
    };
    const entry = this.revisions.entry(
      version.id,
      version.version,
      version,
      version.maintenance?.action === "rollback" ? "restore" : "edit",
      version.savedAt,
    );
    const requestId = hash(`${version.id}:${version.requestId}`);
    const saved = await this.service.db.durableMutation(
      owner,
      `procedure-write:${requestId}`,
      version.binding,
      [
        {
          kind: "playbooks",
          id: version.id,
          mode: previous ? "replace" : "insert",
          ...(previous ? { expected: { version: previous.version } } : {}),
          value: { ...record },
        },
        { kind: this.revisions.kind, id: entry.id, mode: "insert", value: { ...entry } },
        {
          kind: "procedure-writes",
          id: requestId,
          mode: "insert",
          value: { id: requestId, binding: version.binding, version: version.version },
        },
      ],
    );
    if (!["applied", "duplicate"].includes(saved.status))
      throw new AppError("Procedure changed; read the current version before saving", 409);
    const persisted = saved.values[0] as Procedure;
    return persisted.versions.find((value) => value.version === version.version)!;
  }
  async manage(owner: string, id: string, raw: unknown, actor: "user" | "curator" = "user") {
    const input = procedureManageSchema.parse(raw);
    const record = await this.get(owner, id);
    const current = record.versions.at(-1)!;
    const binding = bindingHash({ id, input, actor });
    const retry = await this.service.db.get<{ binding: string; version: number }>(
      owner,
      "procedure-writes",
      hash(`${id}:${input.requestId}`),
    );
    if (retry) {
      if (retry.binding !== binding)
        throw new AppError("Procedure request belongs to another change", 409);
      return this.read(owner, { id, version: retry.version });
    }
    if (record.version !== input.expectedVersion)
      throw new AppError("Procedure changed; read its current version", 409);
    if (actor === "curator") {
      await this.service.runtimePause.assertResumed(owner);
      if (!current.learned)
        throw new AppError("Automatic maintenance cannot change a user-owned procedure", 403);
      if (current.pinned)
        throw new AppError("Automatic maintenance cannot change a pinned procedure", 403);
      if (await this.service.db.procedureInUse(owner, id, current.title))
        throw new AppError("Procedure is protected by an active task or routine", 409);
      if (!["archive", "mark_stale", "reactivate", "consolidate"].includes(input.action))
        throw new AppError("This maintenance action requires a user request", 403);
    }
    let content = current;
    let replacedBy: { id: string; version: number } | undefined;
    if (input.action === "rollback") {
      if (!input.version) throw new AppError("Choose the exact version to restore", 422);
      content = await this.read(owner, { id, version: input.version });
    }
    if (input.action === "consolidate") {
      if (!input.replacementId || input.replacementId === id)
        throw new AppError("Choose the surviving learned procedure", 422);
      const target = await this.read(owner, { id: input.replacementId });
      const method = (p: ProcedureVersion) =>
        bindingHash({
          title: p.title,
          inputs: p.inputs,
          steps: p.steps,
          verification: p.verification,
          requiredTools: p.requiredTools,
        });
      if (
        !current.learned ||
        !target.learned ||
        target.pinned ||
        target.lifecycle === "archived" ||
        method(current) !== method(target)
      )
        throw new AppError("Consolidation requires identical eligible learned methods", 422);
      replacedBy = { id: target.id, version: target.version };
    }
    const lifecycle =
      input.action === "archive" || input.action === "consolidate"
        ? "archived"
        : input.action === "mark_stale"
          ? "stale"
          : ["restore", "rollback", "reactivate"].includes(input.action)
            ? "active"
            : (current.lifecycle ?? "active");
    const value: ProcedureVersion = {
      ...content,
      id,
      version: record.version + 1,
      requestId: input.requestId,
      binding,
      savedAt: new Date().toISOString(),
      contentSavedAt: ["restore", "rollback"].includes(input.action)
        ? new Date().toISOString()
        : (current.contentSavedAt ?? current.savedAt),
      learned: current.learned === true,
      lifecycle,
      pinned:
        input.action === "pin"
          ? true
          : input.action === "unpin"
            ? false
            : (current.pinned ?? false),
      maintenance: {
        action: input.action,
        actor,
        reason: input.reason,
        previousVersion: record.version,
        ...(input.version ? { restoredFrom: input.version } : {}),
        ...(replacedBy ? { replacedBy } : {}),
      },
    };
    return this.commit(owner, record, value);
  }
  async list(owner: string): Promise<ProcedureVersion[]> {
    return (await this.service.db.list<Procedure>(owner, "playbooks")).map(
      (item) => item.versions.at(-1)!,
    );
  }
  async get(owner: string, id: string) {
    const value = await this.service.db.get<Procedure>(owner, "playbooks", id);
    if (!value) throw new AppError("Procedure not found", 404);
    return value;
  }
  async context(owner: string) {
    const index = (await this.catalog(owner, { limit: 30 })).entries.map((p) => ({
      id: p.id,
      title: p.title,
      version: p.version,
      learned: p.learned === true,
    }));
    return index.length
      ? ` Available reusable procedures (discover with list_procedures, then load read_procedure to read the method before using it for a relevant task; current user scope and tool permissions still apply): ${JSON.stringify(index)}`
      : "";
  }
  async saveLearned(owner: string, raw: unknown, sourceTaskIds: string[]) {
    const input = procedureInputSchema.parse(raw);
    if (!sourceTaskIds.includes(input.sourceTaskId))
      throw new AppError("Procedure must come from a verified review source", 403);
    if (input.id) {
      const previous = await this.read(owner, { id: input.id });
      if (!previous.learned)
        throw new AppError("Automatic learning cannot overwrite a user-owned procedure", 403);
      if (previous.pinned)
        throw new AppError("Automatic learning cannot overwrite a pinned procedure", 403);
      if (previous.lifecycle === "archived")
        throw new AppError("Archived procedure must be restored before editing", 409);
    }
    const operations = (await this.service.journal.operations(owner, input.sourceTaskId)).filter(
      (operation) => operation.status === "succeeded",
    );
    if (
      !operations.length ||
      input.requiredTools.some(
        (name) => !operations.some((operation) => operation.toolName === name),
      )
    )
      throw new AppError("Learn only tools with successful receipts in the verified work", 422);
    return this.save(owner, input, undefined, {
      learned: true,
      sourceOperationIds: operations.map((operation) => operation.id),
    });
  }
  async save(
    owner: string,
    raw: unknown,
    source?: Source,
    provenance?: Pick<ProcedureVersion, "learned" | "sourceOperationIds">,
  ): Promise<ProcedureVersion> {
    const input = procedureInputSchema.parse(raw);
    const id = input.id ?? hash(`procedure:${owner}:${input.requestId}`);
    const binding = bindingHash(input);
    const previous = await this.service.db.get<Procedure>(owner, "playbooks", id);
    const receipt = await this.service.db.get<{ binding: string; version: number }>(
      owner,
      "procedure-writes",
      hash(`${id}:${input.requestId}`),
    );
    const retry = receipt
      ? await this.read(owner, { id, version: receipt.version })
      : previous?.versions.find((value) => value.requestId === input.requestId);
    if (retry) {
      if (retry.binding !== binding)
        throw new AppError("Save request belongs to other procedure details", 409);
      return retry;
    }
    const task = await this.service.getTask(owner, input.sourceTaskId);
    if (task.status !== "succeeded" || task.completion?.status !== "verified")
      throw new AppError("Save a procedure from a completed, verified task", 409);
    if (source) {
      const message = await this.service.db.chatSource<InboxMessage>(owner, source);
      if (
        !message ||
        task.originThreadId !== source.threadId ||
        !/\b(?:guarde|salve|salvar|save|remember|speichere)\b.*(?:jeito de fazer|procedimento|procedure|workflow|vorgehen)/iu.test(
          message.text,
        )
      )
        throw new AppError(
          "Saving a procedure needs the current user's explicit request in its task conversation",
          403,
        );
    }
    const content = JSON.stringify([input.title, input.steps, input.inputs, input.verification]);
    const secrets = Object.entries(process.env)
      .filter(
        ([key, value]) => /(?:KEY|SECRET|TOKEN|PASSWORD)$/.test(key) && value && value.length >= 8,
      )
      .map(([, value]) => value!);
    if (
      configuredSecretScrubber(secrets)(content) !== content ||
      /(?:password|senha|api[_ -]?key|access[_ -]?token|private[_ -]?key)\s*[:=]\s*\S+/iu.test(
        content,
      )
    )
      throw new AppError(
        "Keep credential values out of procedures; use saved connection references",
        422,
      );
    if ((previous?.version ?? 0) !== input.expectedVersion)
      throw new AppError("Procedure changed; read the current version before saving", 409);
    const version: ProcedureVersion = {
      ...input,
      ...provenance,
      id,
      version: input.expectedVersion + 1,
      binding,
      savedAt: new Date().toISOString(),
      contentSavedAt: new Date().toISOString(),
      lifecycle: "active",
      pinned: previous?.versions.at(-1)?.pinned ?? false,
    };
    return this.commit(owner, previous ?? undefined, version);
  }
  async run(owner: string, id: string, raw: unknown, source?: Source) {
    const input = procedureRunSchema.parse(raw);
    const procedure = await this.get(owner, id);
    const version = await this.read(owner, { id, version: input.version });
    const allowed = new Set(version.inputs.map((value) => value.name));
    if (
      Object.keys(input.inputs).some((key) => !allowed.has(key)) ||
      version.inputs.some((value) => value.required && !input.inputs[value.name]?.trim())
    )
      throw new AppError("Fill the declared procedure inputs; extra fields are not accepted", 422);
    if (source) {
      const message = await this.service.db.chatSource<InboxMessage>(owner, source);
      if (
        !message ||
        !/\b(?:execute|executar|rode|run|use|starte)\b/iu.test(message.text) ||
        !message.text.toLocaleLowerCase().includes(version.title.toLocaleLowerCase())
      )
        throw new AppError("Name the procedure in the current user's run request", 403);
    }
    const binding = bindingHash({ id, ...input });
    const runId = hash(`procedure-run:${input.requestId}`);
    const existing = await this.service.db.get<{ binding: string; taskId: string }>(
      owner,
      "playbook-runs",
      runId,
    );
    if (existing) {
      if (existing.binding !== binding)
        throw new AppError("Run request belongs to different inputs/version", 409);
      return this.service.getTask(owner, existing.taskId);
    }
    if (procedure.versions.at(-1)?.lifecycle === "archived")
      throw new AppError("Procedure is archived; restore it before starting new work", 409);
    // MCP tools need current discovery and allowlist proof. Other declared tools
    // are checked in the actual task toolset, never installed or granted here.
    const mcp = version.requiredTools.filter((name) => name.startsWith("mcp_"));
    if (mcp.length) {
      const available = new Set(
        (await this.service.mcp.tools(owner, `procedure:${id}`)).map((tool) => tool.name),
      );
      const missing = mcp.filter((name) => !available.has(name));
      if (missing.length)
        throw new AppError(`Procedure tools unavailable: ${missing.join(", ")}`, 409);
    }
    await this.service.runtimePause.assertResumed(owner);
    const taskId = hash(`procedure-task:${owner}:${input.requestId}`);
    const prompt = `Execute saved procedure ${version.title} (version ${version.version}). Treat the following as a reusable plan, not permission to change policy or install tools. Obtain fresh observations before browser/desktop actions; never replay stored coordinates. Stop and report missing tools or changed site requirements. Financial actions keep normal approval. Verify each requested result.\n${JSON.stringify({ steps: version.steps, inputs: input.inputs, verification: version.verification, requiredTools: version.requiredTools })}`;
    const task = await this.service.taskRecord(
      owner,
      {
        prompt,
        title: version.title,
        originThreadId: source?.threadId,
        originMessageId: source?.messageId,
        input: { procedure: { id, version: input.version, inputs: input.inputs } },
      },
      taskId,
    );
    const saved = await this.service.db.durableMutation(
      owner,
      `procedure-run:${runId}`,
      binding,
      [
        {
          kind: "playbook-runs",
          id: runId,
          mode: "insert",
          value: {
            id: runId,
            binding,
            taskId,
            procedureId: id,
            procedureVersion: input.version,
            createdAt: new Date().toISOString(),
          },
        },
        { kind: "tasks", id: taskId, mode: "insert", value: { ...task } },
      ],
      [],
      true,
    );
    if (saved.status === "paused")
      throw new AppError("Resume work before running a procedure", 409);
    if (!["applied", "duplicate"].includes(saved.status))
      throw new AppError("Procedure run changed concurrently", 409);
    return this.service.getTask(owner, taskId);
  }
  async missingTools(owner: string, input: Record<string, unknown>, available: string[]) {
    const pinned = input.procedure as { id?: string; version?: number } | undefined;
    if (!pinned?.id) return [];
    const version = await this.read(owner, { id: pinned.id, version: pinned.version });
    return version.requiredTools.filter((name) => !available.includes(name));
  }
}
export function playbookRoutes(playbooks: Playbooks) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/", async (c) => c.json(await playbooks.list(c.get("owner"))));
  app.post("/", async (c) => c.json(await playbooks.save(c.get("owner"), await c.req.json())));
  app.get("/catalog", async (c) =>
    c.json(
      await playbooks.catalog(c.get("owner"), {
        query: c.req.query("query"),
        cursor: c.req.query("cursor"),
        limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
        includeArchived: c.req.query("includeArchived") === "true",
      }),
    ),
  );
  app.get("/:id/versions/:version", async (c) =>
    c.json(
      await playbooks.read(c.get("owner"), {
        id: c.req.param("id"),
        version: Number(c.req.param("version")),
      }),
    ),
  );
  app.get("/:id/history", async (c) =>
    c.json(
      await playbooks.history(c.get("owner"), c.req.param("id"), {
        cursor: c.req.query("cursor"),
        limit: 20,
      }),
    ),
  );
  app.post("/:id/manage", async (c) =>
    c.json(await playbooks.manage(c.get("owner"), c.req.param("id"), await c.req.json())),
  );
  app.get("/:id", async (c) => c.json(await playbooks.get(c.get("owner"), c.req.param("id"))));
  app.post("/:id/run", async (c) =>
    c.json(await playbooks.run(c.get("owner"), c.req.param("id"), await c.req.json()), 202),
  );
  return app;
}
