import { randomUUID } from "node:crypto";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type { BrowserService } from "../browser.ts";
import type { Store } from "../db.ts";
import { currentTaskScope } from "../engine/task-journal.ts";
import { AppError } from "../errors.ts";
import type { CredentialBroker } from "./broker.ts";
import { type CaptchaRecord, CredentialCaptcha } from "./captcha.ts";
import type { CredentialChallenge, CredentialStatus } from "./contracts.ts";
import type { CredentialGrantBroker } from "./grants.ts";
import {
  trustedCredentialChallengeInput,
  trustedCredentialChallengePlan,
  trustedCredentialInput,
  trustedCredentialPlan,
} from "./trusted-input.ts";

export type CredentialLoginToolResult = {
  status: Extract<
    CredentialStatus,
    "connected" | "needs_challenge" | "invalid_credentials" | "outcome_unknown" | "error"
  >;
  credentialRef: { id: string; version: number };
  origin: string;
  serviceName: string;
  challengeId?: string;
  challengeKind?: CredentialChallenge["kind"];
  reasonCode?: string;
  agentAttempt?: boolean;
};

type CredentialBrowserResult = {
  status: "authenticated" | "manual_required" | "challenge" | "failed" | "outcome_unknown";
  origin: string;
  sessionId: string;
  sessionGeneration?: string;
  executorId?: string;
  profileId?: string;
  reasonCode?: string;
  challengeKind?: CredentialChallenge["kind"];
  challengeId?: string;
};
type CredentialBrowser = Pick<
  BrowserService,
  "runAutomated" | "credentials" | "submitCredentialChallenge" | "isNativeSession" | "challenge"
>;
type BrowserTarget = {
  executorId: string;
  profileId: string;
  sessionId: string;
  sessionGeneration: string;
};

export class CredentialLoginService {
  readonly captcha: CredentialCaptcha;
  private wakeTask?: (owner: string, taskId: string) => Promise<unknown>;
  constructor(
    private readonly db: Store,
    private readonly credentials: CredentialBroker,
    private readonly browser: CredentialBrowser,
    private readonly grants: CredentialGrantBroker,
    private readonly options: {
      now?: () => number;
      challengeTtlMs?: number;
      captchaAttemptMs?: number;
      captchaMaxSubmissions?: number;
    } = {},
  ) {
    this.captcha = new CredentialCaptcha(db, credentials, browser, {
      now: options.now,
      attemptMs: options.captchaAttemptMs,
      maxSubmissions: options.captchaMaxSubmissions,
    });
  }
  configureWake(wakeTask: (owner: string, taskId: string) => Promise<unknown>) {
    this.wakeTask = wakeTask;
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private safeResult(
    status: CredentialLoginToolResult["status"],
    connection: {
      credentialRef: { id: string; version: number };
      origin: string;
      serviceName: string;
    },
    more: Partial<CredentialLoginToolResult> = {},
  ): CredentialLoginToolResult {
    return {
      status,
      credentialRef: connection.credentialRef,
      origin: connection.origin,
      serviceName: connection.serviceName,
      ...more,
    };
  }

  async authenticate(
    owner: string,
    taskId: string,
    refId: string,
    signal?: AbortSignal,
    target?: BrowserTarget,
    challengeId?: string,
  ): Promise<CredentialLoginToolResult> {
    const task = await this.db.get<AgentTask>(owner, "tasks", taskId);
    if (!task || task.status !== "running")
      throw new AppError("This task is no longer active", 409);
    const authorized = await this.credentials.authorizeForTask(owner, taskId, refId);
    const { connection, adapter } = authorized;
    const challenge = challengeId
      ? await this.credentials.getChallenge(owner, taskId, refId, challengeId)
      : undefined;
    if (connection.status === "outcome_unknown")
      throw new AppError(
        "The last login outcome is uncertain. Inspect the browser before retrying.",
        409,
        "CREDENTIAL_OUTCOME_UNKNOWN",
      );
    if (!adapter.authenticatedSelector)
      throw new AppError(
        "This login adapter has no trusted success signal and cannot confirm account login",
        409,
        "LOGIN_CONFIRMATION_UNAVAILABLE",
      );
    if (challenge && !["otp", "totp"].includes(challenge.kind))
      return this.safeResult("needs_challenge", connection, {
        challengeId: challenge.id,
        challengeKind: challenge.kind,
        ...(challenge.kind === "captcha" ? { agentAttempt: true } : {}),
      });

    await this.credentials.setConnectionStatus(owner, refId, "connecting");
    let code: string | undefined;
    if (challenge && !(await this.browser.isNativeSession(owner, challenge.sessionId))) {
      try {
        code = this.grants.takeChallengeCode(owner, taskId, challenge.id);
      } catch {
        await this.credentials.setConnectionStatus(owner, refId, "needs_challenge", {
          challengeId: challenge.id,
          challengeKind: challenge.kind,
        });
        return this.safeResult("needs_challenge", connection, {
          challengeId: challenge.id,
          challengeKind: challenge.kind,
        });
      }
    }
    const scope = currentTaskScope();
    if (
      !scope ||
      scope.owner !== owner ||
      scope.task.id !== taskId ||
      scope.operation.taskId !== taskId
    )
      throw new AppError("Credential login requires the current durable task operation", 403);
    const revision = scope.operation.revision;
    const plan = challenge
      ? trustedCredentialChallengePlan(adapter, refId, taskId, revision, {
          id: challenge.id,
          kind: challenge.kind,
        })
      : trustedCredentialPlan(adapter, refId, taskId, revision);
    let result: CredentialBrowserResult;
    try {
      result = await this.browser.runAutomated(
        owner,
        taskId,
        challenge?.sessionId ?? target?.sessionId,
        challenge ? undefined : target ? undefined : (adapter.loginUrl ?? adapter.origin),
        signal,
        true,
        async (sessionId) => {
          if (target && target.sessionId !== sessionId)
            throw new AppError(
              "The requested destination browser binding changed",
              409,
              "BROWSER_BINDING_CHANGED",
            );
          if (await this.browser.isNativeSession(owner, sessionId))
            return (
              challenge
                ? this.browser.submitCredentialChallenge(owner, sessionId, plan, signal)
                : this.browser.credentials(owner, sessionId, plan, signal)
            ) as Promise<CredentialBrowserResult>;
          if (challenge) {
            if (!code)
              throw new AppError(
                "The verification code expired; enter it again",
                409,
                "CHALLENGE_CODE_EXPIRED",
              );
            const input = trustedCredentialChallengeInput(
              adapter,
              { id: challenge.id, kind: challenge.kind },
              code,
            );
            return this.browser.submitCredentialChallenge(
              owner,
              sessionId,
              input,
              signal,
            ) as Promise<CredentialBrowserResult>;
          }
          // Only the isolated VPS worker receives a direct, short-lived body.
          // The Lenovo branch above supplies a metadata-only plan; OpenBao is
          // read only by the node's claimed, one-use consume route.
          const stored = await this.credentials.getForTask(owner, taskId, refId);
          return this.browser.credentials(
            owner,
            sessionId,
            trustedCredentialInput(stored.adapter, stored.values),
            signal,
          ) as Promise<CredentialBrowserResult>;
        },
      );
    } catch (error) {
      const unknown = (error as { code?: unknown })?.code === "OUTCOME_UNKNOWN";
      const status = unknown ? "outcome_unknown" : "error";
      await this.credentials.setConnectionStatus(owner, refId, status);
      if (challenge && unknown)
        await this.db.compareAndSwap(
          owner,
          "credential-challenges",
          challenge.id,
          { status: "waiting" },
          { status: "outcome_unknown" },
        );
      return this.safeResult(status, connection, {
        reasonCode: unknown ? "SUBMIT_UNCONFIRMED" : "LOGIN_FAILED",
      });
    } finally {
      code = undefined;
    }
    if (
      result.sessionId.length < 1 ||
      result.origin !== adapter.origin ||
      (challenge &&
        (result.sessionId !== challenge.sessionId || result.challengeId !== challenge.id)) ||
      (challenge &&
        ((challenge.executorId && result.executorId !== challenge.executorId) ||
          (challenge.profileId && result.profileId !== challenge.profileId) ||
          (challenge.sessionGeneration &&
            result.sessionGeneration !== challenge.sessionGeneration))) ||
      (target &&
        (result.executorId !== target.executorId ||
          result.profileId !== target.profileId ||
          result.sessionId !== target.sessionId ||
          result.sessionGeneration !== target.sessionGeneration))
    ) {
      await this.credentials.setConnectionStatus(owner, refId, "outcome_unknown");
      if (challenge)
        await this.db.compareAndSwap(
          owner,
          "credential-challenges",
          challenge.id,
          { status: "waiting" },
          { status: "outcome_unknown" },
        );
      return this.safeResult("outcome_unknown", connection, { reasonCode: "LOGIN_SCOPE_CHANGED" });
    }

    if (result.status === "authenticated") {
      if (!result.sessionGeneration || !result.executorId || !result.profileId) {
        await this.credentials.setConnectionStatus(owner, refId, "outcome_unknown");
        return this.safeResult("outcome_unknown", connection, {
          reasonCode: "SESSION_BINDING_UNAVAILABLE",
        });
      }
      const authenticatedAt = new Date(this.now()).toISOString();
      await this.credentials.recordBrowserBinding(owner, refId, {
        executorId: result.executorId,
        profileId: result.profileId,
        sessionId: result.sessionId,
        sessionGeneration: result.sessionGeneration,
        authenticatedAt,
      });
      await this.credentials.setConnectionStatus(owner, refId, "connected", { authenticatedAt });
      if (challenge)
        await this.db.compareAndSwap(
          owner,
          "credential-challenges",
          challenge.id,
          { status: "waiting" },
          { status: "completed" },
        );
      return this.safeResult("connected", connection);
    }
    if (result.status === "challenge") {
      if (!result.sessionGeneration || !result.executorId || !result.profileId) {
        await this.credentials.setConnectionStatus(owner, refId, "outcome_unknown");
        return this.safeResult("outcome_unknown", connection, {
          reasonCode: "SESSION_BINDING_UNAVAILABLE",
        });
      }
      const challengeRecord: CaptchaRecord = challenge ?? {
        id: result.challengeId ?? randomUUID(),
        taskId,
        revision: task.attempts,
        taskRevision: Number(task.state.appliedRevision ?? 0),
        credentialRefId: refId,
        adapterId: adapter.id,
        origin: adapter.origin,
        sessionId: result.sessionId,
        ...(result.sessionGeneration ? { sessionGeneration: result.sessionGeneration } : {}),
        ...(result.executorId ? { executorId: result.executorId } : {}),
        ...(result.profileId ? { profileId: result.profileId } : {}),
        kind: result.challengeKind ?? "unknown",
        status: "waiting",
        submissions: 0,
        actionId: null,
        actionSequence: 0,
        agentDeadline: this.now() + Math.min(60_000, this.options.captchaAttemptMs ?? 60_000),
        createdAt: new Date(this.now()).toISOString(),
        expiresAt: new Date(
          this.now() +
            (result.challengeKind === "captcha"
              ? 600_000
              : Math.min(60_000, this.options.challengeTtlMs ?? 60_000)),
        ).toISOString(),
      };
      await this.db.insertIfAbsent(owner, "credential-challenges", challengeRecord);
      await this.credentials.setConnectionStatus(owner, refId, "needs_challenge", {
        challengeId: challengeRecord.id,
        challengeKind: challengeRecord.kind,
      });
      return this.safeResult("needs_challenge", connection, {
        challengeId: challengeRecord.id,
        challengeKind: challengeRecord.kind,
        ...(challengeRecord.kind === "captcha" ? { agentAttempt: true } : {}),
      });
    }
    const status: CredentialStatus =
      result.status === "failed"
        ? "invalid_credentials"
        : result.status === "outcome_unknown"
          ? "outcome_unknown"
          : "error";
    await this.credentials.setConnectionStatus(owner, refId, status);
    if (challenge) {
      const next = status === "outcome_unknown" ? "outcome_unknown" : "waiting";
      await this.db.compareAndSwap(
        owner,
        "credential-challenges",
        challenge.id,
        { status: "waiting" },
        { status: next },
      );
    }
    return this.safeResult(status, connection, {
      ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
    });
  }

  async submitChallenge(
    owner: string,
    challengeId: string,
    input: { clientResponseId: string; value: string },
  ) {
    const challenge = await this.db.get<CredentialChallenge & { lastResponseId?: string }>(
      owner,
      "credential-challenges",
      challengeId,
    );
    if (!challenge) throw new AppError("Credential challenge not found", 404);
    if (challenge.lastResponseId === input.clientResponseId) {
      if (this.grants.hasChallengeCode(owner, challenge.taskId, challengeId))
        await this.wakeTask?.(owner, challenge.taskId);
      return { accepted: true, challengeId, submissions: challenge.submissions };
    }
    if (challenge.status !== "waiting" || !["otp", "totp"].includes(challenge.kind))
      throw new AppError(
        "This verification step needs browser control or another supported human factor",
        409,
      );
    const now = this.now();
    if (Date.parse(challenge.expiresAt) <= now || now - Date.parse(challenge.createdAt) > 60_000) {
      await this.db.compareAndSwap(
        owner,
        "credential-challenges",
        challengeId,
        { status: "waiting" },
        { status: "expired" },
      );
      throw new AppError("This verification step expired; request a fresh sign-in", 409);
    }
    if (challenge.submissions >= 3)
      throw new AppError("Maximum verification attempts reached; request a fresh sign-in", 429);
    const task = await this.db.get<AgentTask>(owner, "tasks", challenge.taskId);
    if (
      !task ||
      task.status !== "waiting_input" ||
      (challenge.taskRevision !== undefined
        ? Number(task.state.appliedRevision ?? 0) !== challenge.taskRevision ||
          Number(task.state.desiredRevision ?? 0) !== challenge.taskRevision
        : task.attempts !== challenge.revision + challenge.submissions) ||
      task.state.credentialChallengeId !== challengeId
    )
      throw new AppError("This verification step is no longer attached to the active task", 409);
    if (!input.value.trim() || input.value.length > 128 || /[\r\n\0]/.test(input.value))
      throw new AppError("Enter the verification code from the service", 422);
    const updated = await this.db.compareAndSwap<CredentialChallenge & { lastResponseId?: string }>(
      owner,
      "credential-challenges",
      challengeId,
      { status: "waiting", submissions: challenge.submissions },
      { submissions: challenge.submissions + 1, lastResponseId: input.clientResponseId },
    );
    if (!updated) throw new AppError("This verification step changed; reload and try again", 409);
    this.grants.stageChallengeCode(
      owner,
      challenge.taskId,
      challenge.credentialRefId,
      challengeId,
      input.value,
    );
    await this.wakeTask?.(owner, challenge.taskId);
    return { accepted: true, challengeId, submissions: updated.submissions };
  }

  async handback(owner: string, sessionId: string) {
    for (const challenge of await this.db.list<CredentialChallenge>(
      owner,
      "credential-challenges",
    )) {
      if (
        challenge.sessionId !== sessionId ||
        challenge.kind !== "captcha" ||
        challenge.status !== "waiting"
      )
        continue;
      const task = await this.db.get<AgentTask>(owner, "tasks", challenge.taskId);
      if (task?.status === "waiting_input" && task.state.credentialChallengeId === challenge.id)
        await this.wakeTask?.(owner, task.id);
    }
  }

  async challenge(owner: string, challengeId: string) {
    const challenge = await this.db.get<CredentialChallenge>(
      owner,
      "credential-challenges",
      challengeId,
    );
    if (!challenge) throw new AppError("Credential challenge not found", 404);
    if (challenge.status === "waiting" && Date.parse(challenge.expiresAt) <= this.now()) {
      await this.db.compareAndSwap(
        owner,
        "credential-challenges",
        challengeId,
        { status: "waiting" },
        { status: "expired" },
      );
      await this.credentials.setConnectionStatus(owner, challenge.credentialRefId, "error");
      return {
        id: challenge.id,
        kind: challenge.kind,
        status: "expired" as const,
        submissions: challenge.submissions,
        expiresAt: challenge.expiresAt,
      };
    }
    return {
      id: challenge.id,
      kind: challenge.kind,
      status: challenge.status,
      submissions: challenge.submissions,
      expiresAt: challenge.expiresAt,
    };
  }
}
