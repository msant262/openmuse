import { Hono } from "hono";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type {
  CredentialInteractionRequest,
  InteractionRequest,
} from "../../../../packages/domain/src/runtime.ts";
import type { ComposioService } from "../composio/service.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { IntegrationService } from "../integrations.ts";
import type { CredentialBroker } from "./broker.ts";
import type { GenericCredentials } from "./generic.ts";

const pending = (item: InteractionRequest) =>
  ["waiting", "saving", "connecting", "outcome_unknown", "needs_challenge"].includes(item.status) ||
  (item.kind === "credential" &&
    item.schema.credentialKind === "composio" &&
    ["error", "expired"].includes(item.status));

/** One owner-scoped queue drives one modal, independently of mounted chat panes. */
export function credentialPromptRoutes(
  db: Store,
  browser: CredentialBroker,
  api: GenericCredentials,
  legacy: IntegrationService,
  composio?: Pick<ComposioService, "statusInteraction">,
) {
  const routes = new Hono<{ Variables: { owner: string } }>();
  routes.get("/credential-prompts", async (c) => {
    const owner = c.get("owner");
    const requests: CredentialInteractionRequest[] = [];
    const candidates = await db.pendingCredentialRequests<CredentialInteractionRequest>(owner);
    for (const item of candidates) {
      if (item.threadId) {
        const thread = await db.get<{ deletedAt?: string }>(owner, "threads", item.threadId);
        if (!thread || thread.deletedAt) continue;
      }
      if (
        !item.schema.integrationId &&
        !(item.schema.credentialKind === "composio" && item.taskId.startsWith("composio-settings:"))
      ) {
        const task = await db.get<AgentTask>(owner, "tasks", item.taskId);
        if (
          !task ||
          !["waiting_input", "queued", "running"].includes(task.status) ||
          task.state.interactionRequestId !== item.id
        )
          continue;
        if (
          (item.status === "waiting" || item.schema.credentialKind === "composio") &&
          (task.status !== "waiting_input" || task.attempts !== item.revision)
        )
          continue;
        if (item.status === "needs_challenge" && task.status !== "waiting_input") continue;
      }
      try {
        if (item.schema.credentialKind === "composio" && !composio) continue;
        const current =
          item.schema.credentialKind === "composio"
            ? await composio!.statusInteraction(owner, item.id)
            : item.schema.credentialKind === "api"
              ? await api.status(owner, item.id)
              : item.schema.integrationId
                ? await legacy.status(owner, item.id)
                : await browser.status(owner, item.id);
        if (pending(current)) requests.push(current as CredentialInteractionRequest);
      } catch (error) {
        // A concurrently removed chat/request must not hide the other forms.
        if (!(error instanceof AppError) || ![404, 410].includes(error.status)) throw error;
      }
    }
    return c.json({ requests });
  });
  return routes;
}
