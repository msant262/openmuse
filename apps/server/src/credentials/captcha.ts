import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import {
  type CaptchaPlan,
  captchaActionSchema,
} from "../../../../packages/domain/src/credential-challenge.ts";
import type { BrowserService } from "../browser.ts";
import type { Store } from "../db.ts";
import { currentTaskScope, taskOperationId, validateTaskEffect } from "../engine/task-journal.ts";
import { AppError } from "../errors.ts";
import type { CredentialBroker } from "./broker.ts";
import type { CredentialChallenge } from "./contracts.ts";

export type CaptchaRecord = CredentialChallenge & {
  agentDeadline?: number;
  agentStopped?: boolean;
  actionId?: string | null;
  actionSequence?: number;
};
export class CredentialCaptcha {
  constructor(
    readonly db: Store,
    readonly credentials: CredentialBroker,
    readonly browser: Pick<BrowserService, "runAutomated" | "challenge">,
    readonly options: { now?: () => number; maxSubmissions?: number; attemptMs?: number } = {},
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  async step(
    owner: string,
    taskId: string,
    challengeId: string,
    raw: unknown,
    signal?: AbortSignal,
  ) {
    const action = captchaActionSchema.parse(raw);
    const scope = currentTaskScope();
    if (!scope || scope.owner !== owner || scope.task.id !== taskId)
      throw new AppError("Challenge requires its current task operation", 403);
    const challenge = await this.db.get<CaptchaRecord>(owner, "credential-challenges", challengeId);
    if (!challenge || challenge.taskId !== taskId || challenge.kind !== "captcha")
      throw new AppError("CAPTCHA not found for this task", 404);
    const current = await this.db.get<AgentTask>(owner, "tasks", taskId);
    if (!current || current.status !== "running" || current.leaseId !== scope.task.leaseId)
      throw new AppError("Challenge task changed", 409);
    const { adapter, connection } = await this.credentials.authorizeForTask(
      owner,
      taskId,
      challenge.credentialRefId,
    );
    if (connection.status === "outcome_unknown" || challenge.status === "outcome_unknown")
      return {
        status: "manual_required",
        challengeId,
        reason: "Inspect the uncertain submission using Take control; do not repeat it.",
      };
    if (challenge.status === "completed") return { status: "authenticated", challengeId };
    if (challenge.status !== "waiting") throw new AppError("Challenge is no longer active", 409);
    if (challenge.actionSequence === undefined)
      return {
        status: "manual_required",
        challengeId,
        reason: "This challenge predates the bounded agent attempt. Continue with Take control.",
      };
    const now = this.now();
    // A restart, provider retry or change of executor cannot extend this clock.
    const deadline =
      challenge.agentDeadline ??
      Date.parse(challenge.createdAt) + Math.min(60_000, this.options.attemptMs ?? 60_000);
    const maxSubmissions = Math.min(3, this.options.maxSubmissions ?? 3);
    const inspection = action.action === "check";
    if (
      !inspection &&
      (action.action === "help" ||
        challenge.agentStopped ||
        now >= deadline ||
        challenge.submissions >= maxSubmissions)
    ) {
      await this.db.compareAndSwap(
        owner,
        "credential-challenges",
        challengeId,
        { status: "waiting" },
        { agentStopped: true, agentDeadline: deadline },
      );
      return {
        status: "manual_required",
        challengeId,
        reason: "The bounded agent attempt ended. Continue with Take control.",
      };
    }
    if (!adapter.challengeSelectors.captcha || !adapter.authenticatedSelector)
      return {
        status: "manual_required",
        challengeId,
        reason: "This service lacks a trusted challenge region or login success signal.",
      };
    if (challenge.actionId)
      return {
        status: "manual_required",
        challengeId,
        reason: "A previous challenge action has an uncertain outcome. Inspect it first.",
      };
    const submits =
      action.action === "submit" ||
      (!adapter.challengeSubmitSelector &&
        ["click", "visual_click", "visual_drag"].includes(action.action));
    const operationId = taskOperationId();
    if (!operationId) throw new AppError("Challenge operation identity is missing", 409);
    await validateTaskEffect();
    const claimed = await this.db.compareAndSwap<CaptchaRecord>(
      owner,
      "credential-challenges",
      challengeId,
      {
        status: "waiting",
        submissions: challenge.submissions,
        actionId: null,
        actionSequence: challenge.actionSequence ?? null,
      },
      {
        agentDeadline: deadline,
        actionId: operationId,
        actionSequence: (challenge.actionSequence ?? 0) + 1,
        submissions: challenge.submissions + Number(submits),
      },
    );
    if (!claimed) throw new AppError("Challenge is already being handled", 409);
    const plan: CaptchaPlan = {
      challengeId,
      origin: adapter.origin,
      selector: adapter.challengeSelectors.captcha,
      authenticatedSelector: adapter.authenticatedSelector,
      submitSelector: adapter.challengeSubmitSelector,
      sensitiveSelectors: Object.values(adapter.selectors),
      expiresAt: deadline,
      action,
    };
    try {
      await validateTaskEffect();
      const result = await this.browser.runAutomated(
        owner,
        taskId,
        challenge.sessionId,
        undefined,
        signal,
        true,
        (id) => this.browser.challenge(owner, id, plan, signal),
      );
      await validateTaskEffect();
      if (result.status === "authenticated") {
        if (!challenge.executorId || !challenge.profileId || !challenge.sessionGeneration)
          throw new AppError("Challenge session binding is unavailable", 409);
        const authenticatedAt = new Date(this.now()).toISOString();
        await this.credentials.recordBrowserBinding(owner, challenge.credentialRefId, {
          executorId: challenge.executorId,
          profileId: challenge.profileId,
          sessionId: challenge.sessionId,
          sessionGeneration: challenge.sessionGeneration,
          authenticatedAt,
        });
        await this.credentials.setConnectionStatus(owner, challenge.credentialRefId, "connected", {
          authenticatedAt,
        });
      }
      await this.db.compareAndSwap(
        owner,
        "credential-challenges",
        challengeId,
        { actionId: operationId },
        {
          actionId: null,
          ...(result.status === "authenticated" ? { status: "completed" } : {}),
        },
      );
      return {
        ...result,
        challengeId,
        sessionId: challenge.sessionId,
        remainingSubmissions: maxSubmissions - claimed.submissions,
        expiresAt: deadline,
      };
    } catch (error) {
      // Read-only capture failures are safe to repeat. Once a control might have
      // reached the page, retain uncertainty through the normal journal/lease.
      const knownRejected =
        /^(STALE_CHALLENGE_FRAME|CHALLENGE_TARGET_DENIED|CHALLENGE_ORIGIN_CHANGED|CHALLENGE_TOO_LARGE|CHALLENGE_UNAVAILABLE|CHALLENGE_SUBMIT_REQUIRED|CHALLENGE_BUDGET_EXHAUSTED|PAYMENT_APPROVAL_REQUIRED|BROWSER_CONTROLLED)$/.test(
          String((error as { code?: string }).code),
        );
      const read = ["observe", "check"].includes(action.action);
      await this.db.compareAndSwap(
        owner,
        "credential-challenges",
        challengeId,
        { actionId: operationId },
        {
          actionId: null,
          ...(knownRejected && submits ? { submissions: challenge.submissions } : {}),
          ...(read || knownRejected ? {} : { status: "outcome_unknown" }),
        },
      );
      if (knownRejected)
        return {
          status: [
            "CHALLENGE_UNAVAILABLE",
            "CHALLENGE_TOO_LARGE",
            "CHALLENGE_ORIGIN_CHANGED",
            "CHALLENGE_BUDGET_EXHAUSTED",
            "BROWSER_CONTROLLED",
          ].includes(String((error as { code?: string }).code))
            ? "manual_required"
            : "pending",
          challengeId,
          code: String((error as { code?: string }).code),
          skipped: true,
          dispatched: false,
          reason:
            "This input was not dispatched. Observe again, or use Take control if the challenge is unavailable.",
        };
      throw error;
    }
  }
}
