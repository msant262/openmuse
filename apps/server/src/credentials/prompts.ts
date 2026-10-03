import { Hono } from "hono";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type {
  CredentialInteractionRequest,
  InteractionRequest,
} from "../../../../packages/domain/src/runtime.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { IntegrationService } from "../integrations.ts";
import type { CredentialBroker } from "./broker.ts";
import type { GenericCredentials } from "./generic.ts";

/** One owner-scoped queue drives one modal, independently of mounted chat panes. */
export function credentialPromptRoutes(
  db: Store,
  browser: CredentialBroker,
  api: GenericCredentials,
  legacy: IntegrationService,
) {
  const routes = new Hono<{ Variables: { owner: string } }>();
  routes.get("/credential-prompts", async (c) => {
    const owner = c.get("owner");
    const requests: CredentialInteractionRequest[] = [];
    const candidates = (await db.list<InteractionRequest>(owner, "interaction-requests"))
      .filter(
        (item): item is CredentialInteractionRequest =>
          item.kind === "credential" &&
          ["waiting", "saving", "connecting", "outcome_unknown", "needs_challenge"].includes(
            item.status,
          ),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const item of candidates) {
      if (item.threadId) {
        const thread = await db.get<{ deletedAt?: string }>(owner, "threads", item.threadId);
        if (!thread || thread.deletedAt) continue;
      }
      if (!item.schema.integrationId) {
        const task = await db.get<AgentTask>(owner, "tasks", item.taskId);
        if (
          !task ||
          !["waiting_input", "queued", "running"].includes(task.status) ||
          task.state.interactionRequestId !== item.id
        )
          continue;
        if (
          item.status === "waiting" &&
          (task.status !== "waiting_input" || task.attempts !== item.revision)
        )
          continue;
        if (item.status === "needs_challenge" && task.status !== "waiting_input") continue;
      }
      try {
        const current =
          item.schema.credentialKind === "api"
            ? await api.status(owner, item.id)
            : item.schema.integrationId
              ? await legacy.status(owner, item.id)
              : await browser.status(owner, item.id);
        if (
          ["waiting", "saving", "connecting", "outcome_unknown", "needs_challenge"].includes(
            current.status,
          )
        )
          requests.push(current as CredentialInteractionRequest);
      } catch (error) {
        // A concurrently removed chat/request must not hide the other forms.
        if (!(error instanceof AppError) || ![404, 410].includes(error.status)) throw error;
      }
    }
    return c.json({ requests });
  });
  return routes;
}
