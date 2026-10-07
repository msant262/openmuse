import { createHash } from "node:crypto";
import { z } from "zod";
import type { ActionProposal } from "../../../packages/domain/src/index.ts";
import { bindingHash } from "./conversation-inbox.ts";
import type { Store } from "./db.ts";
import { authorizeTaskEffect } from "./engine/task-journal.ts";
import { AppError } from "./errors.ts";
import type { MailChange } from "./gmail-changes.ts";
import type { GoogleWorkspaceHarness } from "./google-workspace-tools.ts";

export const gmailOrganizationSchema = z
  .object({
    account: z.string().min(1).max(320),
    query: z.string().trim().min(1).max(2000),
    labelNames: z.array(z.string().trim().min(1).max(225)).max(30).default([]),
    archive: z.boolean().default(false),
    operationId: z.string().min(1).max(120),
    cursor: z.number().int().nonnegative().default(0),
  })
  .strict()
  .refine((input) => input.archive || input.labelNames.length > 0, "Choose labels or archive");
interface Plan {
  id: string;
  taskId?: string;
  revision: number;
  requestHash: string;
  account: string;
  connectionId: string;
  ids: string[];
  query: string;
  labelIds: string[];
  labelNames: string[];
  archive: boolean;
  complete: boolean;
  actionIds: string[];
  processed: number;
  messages?: MailChange["messages"];
  archivedCount?: number;
  changedCount?: number;
}
const batchSize = 100;

/** IDs remain server-side. Pagination finishes before any change to the queried labels. */
export class GmailOrganization {
  constructor(private readonly harness: GoogleWorkspaceHarness) {}
  async run(
    owner: string,
    raw: z.input<typeof gmailOrganizationSchema>,
    options: NonNullable<Parameters<GoogleWorkspaceHarness["execute"]>[2]> = {},
  ) {
    const input = gmailOrganizationSchema.parse(raw);
    const { cursor: _cursor, ...request } = input;
    const requestHash = bindingHash(request);
    const id = createHash("sha256")
      .update(`gmail-organize:${options.taskId ?? "http"}:${input.operationId}`)
      .digest("hex");
    const { db, workspace } = this.harness;
    await options.before?.();
    options.signal?.throwIfAborted();
    let plan = await db.get<Plan>(owner, "gmail-organization", id);
    if (plan && plan.requestHash !== requestHash)
      throw new AppError("Gmail organization ID belongs to different details", 409);
    if (!plan) {
      const account = (await workspace.googleAccounts(owner)).find(
        (a) =>
          a.account.toLowerCase() === input.account.toLowerCase() ||
          a.connectionId === input.account,
      );
      if (!account) throw new AppError("The selected Google account is disconnected", 409);
      const ids = new Set<string>(),
        tokens = new Set<string>();
      let pageToken: string | undefined;
      do {
        await authorizeTaskEffect();
        options.signal?.throwIfAborted();
        const result = (await this.harness.execute(
          owner,
          {
            toolId: "gmail.users.messages.list",
            account: input.account,
            parameters: { q: input.query, maxResults: 500, ...(pageToken ? { pageToken } : {}) },
            operationId: `${input.operationId}:selection`,
          },
          options,
        )) as { data?: { messages?: { id: string }[]; nextPageToken?: string } };
        if (!result.data) throw new Error("Gmail did not return a message selection");
        for (const message of result.data.messages ?? []) ids.add(message.id);
        pageToken = result.data.nextPageToken;
        if (pageToken && tokens.has(pageToken))
          throw new Error("Gmail repeated a pagination token; selection is incomplete");
        if (pageToken) tokens.add(pageToken);
      } while (pageToken);
      const task = options.taskId
        ? await db.get<{ state: { appliedRevision?: number } }>(owner, "tasks", options.taskId)
        : undefined;
      const selected: Plan = {
        id,
        taskId: options.taskId,
        revision: task?.state.appliedRevision ?? 0,
        requestHash,
        account: account.account,
        connectionId: account.connectionId,
        ids: [...ids],
        query: input.query,
        labelIds: [],
        labelNames: input.labelNames,
        archive: input.archive,
        complete: ids.size === 0,
        processed: 0,
        actionIds: [],
      };
      await db.insertIfAbsent(owner, "gmail-organization", selected);
      plan = (await db.get<Plan>(owner, "gmail-organization", id)) ?? selected;
    }
    if (plan.complete) return this.result(plan);
    if (!plan.labelIds.length && plan.labelNames.length) {
      const result = (await this.harness.execute(
        owner,
        {
          toolId: "gmail.users.labels.list",
          account: plan.connectionId,
          parameters: {},
          operationId: `${input.operationId}:labels`,
        },
        options,
      )) as { data: { labels: { id: string; name: string }[] } };
      for (const [index, name] of plan.labelNames.entries()) {
        let label = result.data.labels.find(
          (l) => l.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
        );
        if (!label) {
          const created = (await this.harness.execute(
            owner,
            {
              toolId: "gmail.users.labels.create",
              account: plan.connectionId,
              parameters: {},
              body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
              operationId: `${input.operationId}:label:${index}`,
            },
            options,
          )) as { status: string; data?: { id: string; name: string } };
          if (created.status !== "succeeded" || !created.data?.id)
            return {
              ...created,
              organizationId: id,
              matched: plan.ids.length,
              processed: 0,
              cursor: 0,
              remaining: plan.ids.length,
            };
          label = created.data;
        }
        plan.labelIds.push(label.id);
      }
      await db.put(owner, "gmail-organization", plan);
    }
    // Reconstruct progress from durable provider receipts, including after a crash
    // between a confirmed batch and the progress checkpoint.
    let processed = 0;
    const actionIds: string[] = [];
    const changes: MailChange[] = [];
    const started = Date.now();
    while (processed < plan.ids.length) {
      const batch = plan.ids.slice(processed, processed + batchSize);
      const result = (await this.harness.execute(
        owner,
        {
          toolId: "gmail.users.messages.batchModify",
          account: plan.connectionId,
          parameters: {},
          body: {
            ids: batch,
            addLabelIds: plan.labelIds,
            removeLabelIds: plan.archive ? ["INBOX"] : [],
          },
          operationId: `${input.operationId}:batch:${processed}`,
        },
        options,
      )) as { status: string; actionId?: string; mailChange?: MailChange };
      if (result.status !== "succeeded" || !result.mailChange?.verified)
        return {
          ...result,
          organizationId: id,
          matched: plan.ids.length,
          processed,
          remaining: plan.ids.length - processed,
          cursor: processed,
        };
      if (!result.actionId) throw new Error("Gmail did not return a durable action receipt");
      actionIds.push(result.actionId);
      changes.push(result.mailChange);
      processed += batch.length;
      // Return a continuation between batches; the selected IDs never enter model context.
      if (
        processed > plan.processed &&
        Date.now() - started > 20_000 &&
        processed < plan.ids.length
      )
        break;
      options.signal?.throwIfAborted();
    }
    plan = {
      ...plan,
      processed,
      actionIds,
      complete: processed === plan.ids.length,
      messages: changes.flatMap((c) => c.messages).slice(0, 12),
      archivedCount: changes.reduce((n, c) => n + c.archived, 0),
      changedCount: changes.reduce((n, c) => n + c.changed, 0),
    };
    await db.put(owner, "gmail-organization", plan);
    return {
      ...this.result(plan),
      archived: changes.reduce((n, c) => n + c.archived, 0),
      changed: changes.reduce((n, c) => n + c.changed, 0),
      messages: changes.flatMap((c) => c.messages).slice(0, 12),
    };
  }
  private result(plan: Plan) {
    return {
      status: plan.complete ? "succeeded" : "in_progress",
      organizationId: plan.id,
      account: plan.account,
      query: plan.query,
      matched: plan.ids.length,
      processed: plan.processed,
      remaining: plan.ids.length - plan.processed,
      cursor: plan.processed,
      labelNames: plan.labelNames,
      archived: plan.archivedCount ?? 0,
      changed: plan.changedCount ?? 0,
      messages: plan.messages ?? [],
      verified: plan.complete,
      actionIds: plan.actionIds,
      noOp: plan.complete && plan.ids.length === 0,
    };
  }
}

/** Completion is tied to this task/revision and to every frozen batch receipt. */
export async function verifiedGmailOrganization(
  db: Store,
  owner: string,
  taskId: string,
  revision: number,
) {
  const plans = await db.list<Plan>(owner, "gmail-organization");
  const verified: string[] = [];
  for (const plan of plans.filter(
    (p) =>
      p.taskId === taskId && p.revision === revision && p.complete && p.processed === p.ids.length,
  )) {
    let valid = true;
    for (let offset = 0; offset < plan.ids.length; offset += batchSize) {
      const action = await db.get<ActionProposal>(
        owner,
        "actions",
        plan.actionIds[offset / batchSize],
      );
      if (
        !action ||
        action.taskId !== taskId ||
        action.status !== "succeeded" ||
        (action.dispatchedRevision ?? action.preparedRevision ?? 0) !== revision
      ) {
        valid = false;
        break;
      }
      const receipt = await db.get<{ result: { mailChange?: MailChange }; actionHash: string }>(
        owner,
        "google-workspace-receipts",
        action.id,
      );
      const change = receipt?.result.mailChange;
      if (
        !receipt ||
        receipt.actionHash !== action.hash ||
        !change?.verified ||
        change.processed !== plan.ids.slice(offset, offset + batchSize).length ||
        bindingHash(receipt.result) !== bindingHash(JSON.parse(action.result!))
      ) {
        valid = false;
        break;
      }
    }
    if (valid) verified.push(plan.id);
  }
  return verified;
}
