import { createHash } from "node:crypto";
import { Hono } from "hono";
import {
  type Procedure,
  type ProcedureVersion,
  procedureInputSchema,
  procedureRunSchema,
} from "../../../packages/domain/src/playbooks.ts";
import { configuredSecretScrubber } from "./configured-secrets.ts";
import type { InboxMessage } from "./conversation-inbox.ts";
import { bindingHash } from "./conversation-inbox.ts";
import type { AgentService } from "./engine/service.ts";
import { AppError } from "./errors.ts";

type Source = { messageId: string; threadId: string; runId: string };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export class Playbooks {
  constructor(readonly service: AgentService) {}
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
    const index = (await this.list(owner))
      .slice(0, 30)
      .map((p) => ({ id: p.id, title: p.title, version: p.version, learned: p.learned === true }));
    return index.length
      ? ` Available reusable procedures (load list_procedures to read the method before using it for a relevant task; current user scope and tool permissions still apply): ${JSON.stringify(index)}`
      : "";
  }
  async saveLearned(owner: string, raw: unknown, sourceTaskIds: string[]) {
    const input = procedureInputSchema.parse(raw);
    if (!sourceTaskIds.includes(input.sourceTaskId))
      throw new AppError("Procedure must come from a verified review source", 403);
    if (input.id && !(await this.get(owner, input.id)).versions.at(-1)?.learned)
      throw new AppError("Automatic learning cannot overwrite a user-owned procedure", 403);
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
    const retry = previous?.versions.find((value) => value.requestId === input.requestId);
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
    if ((previous?.versions.length ?? 0) >= 30)
      throw new AppError("Procedure version limit reached; save a new procedure", 409);
    const version: ProcedureVersion = {
      ...input,
      ...provenance,
      id,
      version: input.expectedVersion + 1,
      binding,
      savedAt: new Date().toISOString(),
    };
    const record: Procedure = {
      id,
      version: version.version,
      versions: [...(previous?.versions ?? []), version],
    };
    const saved = previous
      ? await this.service.db.compareAndSwap(
          owner,
          "playbooks",
          id,
          { version: input.expectedVersion },
          record,
        )
      : await this.service.db.insertIfAbsent(owner, "playbooks", record);
    if (!saved) return this.save(owner, raw, source, provenance);
    return version;
  }
  async run(owner: string, id: string, raw: unknown, source?: Source) {
    const input = procedureRunSchema.parse(raw);
    const procedure = await this.get(owner, id);
    const version = procedure.versions.find((value) => value.version === input.version);
    if (!version) throw new AppError("Procedure version not found", 404);
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
        { kind: "playbook-runs", id: runId, mode: "insert", value: { id: runId, binding, taskId } },
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
    const procedure = await this.get(owner, pinned.id);
    const version = procedure.versions.find((value) => value.version === pinned.version);
    if (!version) throw new AppError("Pinned procedure version is unavailable", 409);
    return version.requiredTools.filter((name) => !available.includes(name));
  }
}
export function playbookRoutes(playbooks: Playbooks) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/", async (c) => c.json(await playbooks.list(c.get("owner"))));
  app.post("/", async (c) => c.json(await playbooks.save(c.get("owner"), await c.req.json())));
  app.get("/:id", async (c) => c.json(await playbooks.get(c.get("owner"), c.req.param("id"))));
  app.post("/:id/run", async (c) =>
    c.json(await playbooks.run(c.get("owner"), c.req.param("id"), await c.req.json()), 202),
  );
  return app;
}
