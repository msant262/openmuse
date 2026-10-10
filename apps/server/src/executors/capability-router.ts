import { z } from "zod";
import type { ExecutorCapability } from "../../../../packages/domain/src/runtime.ts";
import { BrowserError } from "../browser-contract.ts";
import type { Store } from "../db.ts";
import { capabilitySchema, safeExecutorId } from "./protocol.ts";

export const browserOperationClassSchema = z.enum(["public_read", "authenticated_read", "mutable"]);
export type BrowserOperationClass = z.infer<typeof browserOperationClassSchema>;
const reads = new Set([
  "open",
  "read",
  "snapshot",
  "images",
  "agent-screenshot",
  "screenshot",
  "inspect",
  "control-read",
  "search",
]);
/** Called with concrete service operations. A model's description is never a classifier. */
export function classifyBrowserOperation(
  operation: string,
  publicProfile: boolean,
): BrowserOperationClass {
  return reads.has(operation) ? (publicProfile ? "public_read" : "authenticated_read") : "mutable";
}
export const browserExecutorSchema = z.object({
  executorId: safeExecutorId,
  hostId: safeExecutorId,
  transport: z.enum(["native", "vps"]),
  epoch: z.number().int().positive(),
  sessionGeneration: z.string().min(1).max(256),
  profileId: z.string().min(1).max(128),
  sessionId: z.uuid(),
  ready: z.boolean(),
  capabilities: z
    .array(z.object({ name: capabilitySchema, version: z.number().int().positive() }))
    .max(32),
});
export type BrowserExecutor = z.infer<typeof browserExecutorSchema>;
const authenticationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("public") }),
  z.object({
    status: z.literal("connected"),
    accountId: z.string().min(1),
    authenticatedAt: z.string(),
  }),
]);
export const executorBindingSchema = browserExecutorSchema
  .omit({ ready: true, capabilities: true })
  .extend({
    id: z.string().min(1).max(256),
    taskId: z.string().min(1).max(256),
    accountId: z.string().min(1).max(256).optional(),
    fence: z.number().int().positive(),
    operationClass: browserOperationClassSchema,
    authentication: authenticationSchema,
  });
export type ExecutorBinding = z.infer<typeof executorBindingSchema>;
export type ArtifactRequirement = { artifactId: string; version: string };
export type BrowserChoice = {
  owner: string;
  taskId: string;
  capability: ExecutorCapability;
  capabilityVersion?: number;
  accountId?: string;
  artifactVersions: ArtifactRequirement[];
  operationClass: BrowserOperationClass;
  excludeExecutorId?: string;
  requiredTransport?: "native" | "vps";
};

/** Owns routing bindings only. Work admission and physical leases stay in M3/M4. */
export class CapabilityRouter {
  constructor(
    readonly db: Store,
    private readonly options: {
      executors: (owner: string, accountId?: string) => Promise<BrowserExecutor[]>;
      authentication?: (
        owner: string,
        accountId: string,
        target: BrowserExecutor,
      ) => Promise<{ accountId: string; authenticatedAt: string } | undefined>;
      requestLogin?: (
        owner: string,
        accountId: string,
        target: BrowserExecutor,
        taskId: string,
      ) => Promise<void>;
    },
  ) {}
  binding(owner: string, taskId: string) {
    return this.db.get<ExecutorBinding>(owner, "browser-bindings", taskId);
  }
  async assertCurrent(owner: string, binding: ExecutorBinding) {
    const current = await this.binding(owner, binding.taskId);
    if (
      !current ||
      current.fence !== binding.fence ||
      current.executorId !== binding.executorId ||
      current.epoch !== binding.epoch ||
      current.profileId !== binding.profileId ||
      current.sessionGeneration !== binding.sessionGeneration ||
      current.sessionId !== binding.sessionId
    )
      throw new BrowserError(
        "STALE_BROWSER_BINDING",
        "The browser executor/session changed. Obtain a fresh observation before acting.",
        409,
        binding.sessionId,
      );
  }
  private async uncertain(owner: string, taskId: string) {
    return this.db.browserTaskUncertain(owner, taskId, [...reads]);
  }
  private async availableArtifacts(request: BrowserChoice, target: BrowserExecutor) {
    for (const requirement of request.artifactVersions) {
      const artifact = await this.db.get<{
        executorId: string;
        version: string;
        published: boolean;
      }>(request.owner, "native-artifacts", requirement.artifactId);
      if (
        !artifact ||
        artifact.version !== requirement.version ||
        (artifact.executorId !== target.executorId && !artifact.published)
      )
        throw new BrowserError(
          "BROWSER_ARTIFACT_UNAVAILABLE",
          "The required artifact version is not published or available on this executor. Work will wait.",
          409,
        );
    }
  }
  async choose(request: BrowserChoice): Promise<ExecutorBinding> {
    browserOperationClassSchema.parse(request.operationClass);
    if (!request.capability.startsWith("browser."))
      throw new BrowserError(
        "CAPABILITY_NOT_MIGRATABLE",
        "Shell and desktop work do not migrate to the browser fallback.",
        409,
      );
    if (await this.uncertain(request.owner, request.taskId))
      throw new BrowserError(
        "BROWSER_OUTCOME_UNKNOWN",
        "An external operation needs reconciliation before changing browser bindings.",
        409,
      );
    for (let attempt = 0; attempt < 8; attempt++) {
      const previous = await this.binding(request.owner, request.taskId);
      if (previous?.accountId && previous.accountId !== request.accountId)
        throw new BrowserError(
          "BROWSER_ACCOUNT_MISMATCH",
          "This browser task is already bound to another account.",
          409,
          previous.sessionId,
        );
      const candidates = (await this.options.executors(request.owner, request.accountId)).map(
        (value) => browserExecutorSchema.parse(value),
      );
      const supports = (value: BrowserExecutor) =>
        value.ready &&
        (!request.requiredTransport || value.transport === request.requiredTransport) &&
        value.executorId !== request.excludeExecutorId &&
        value.capabilities.some(
          (capability) =>
            capability.name === request.capability &&
            capability.version === (request.capabilityVersion ?? 1),
        );
      const exact =
        previous &&
        candidates.find(
          (value) =>
            value.executorId === previous.executorId &&
            value.epoch === previous.epoch &&
            value.profileId === previous.profileId &&
            value.sessionGeneration === previous.sessionGeneration &&
            value.sessionId === previous.sessionId &&
            supports(value),
        );
      const target =
        exact ??
        candidates.find((value) => value.transport === "native" && supports(value)) ??
        (request.operationClass !== "mutable"
          ? candidates.find((value) => value.transport === "vps" && supports(value))
          : undefined);
      if (!target || (previous && !exact && request.operationClass === "mutable"))
        throw new BrowserError(
          "BROWSER_EXECUTOR_UNAVAILABLE",
          "The bound browser executor is offline or lacks the required capability. Mutable work will wait.",
          503,
          previous?.sessionId,
        );
      await this.availableArtifacts(request, target);
      let authentication: ExecutorBinding["authentication"] = { status: "public" };
      if (request.accountId) {
        let proof = await this.options.authentication?.(request.owner, request.accountId, target);
        if (!proof) {
          await this.options.requestLogin?.(
            request.owner,
            request.accountId,
            target,
            request.taskId,
          );
          proof = await this.options.authentication?.(request.owner, request.accountId, target);
        }
        if (!proof) {
          throw new BrowserError(
            "BROWSER_LOGIN_REQUIRED",
            "The destination browser requires a validated login or secure challenge. Chat remains available.",
            409,
            target.sessionId,
          );
        }
        if (proof.accountId !== request.accountId)
          throw new BrowserError(
            "BROWSER_ACCOUNT_MISMATCH",
            "The destination browser is authenticated as a different saved account.",
            409,
            target.sessionId,
          );
        authentication = { status: "connected", ...proof };
      } else if (request.operationClass === "authenticated_read") {
        // Accountless reads can remain on the exact profile; they cannot inherit a
        // login from another host based on a model assertion.
        if (!exact && target.transport === "vps")
          throw new BrowserError(
            "BROWSER_LOGIN_REQUIRED",
            "Authenticated browser work requires a broker-owned account binding.",
            409,
            target.sessionId,
          );
      }
      if (exact && previous && previous.accountId === request.accountId) return previous;
      const { ready: _ready, capabilities: _capabilities, ...identity } = target;
      const binding = executorBindingSchema.parse({
        ...identity,
        id: request.taskId,
        taskId: request.taskId,
        accountId: request.accountId,
        fence: (previous?.fence ?? 0) + 1,
        operationClass: request.operationClass,
        authentication,
      });
      const saved = previous
        ? await this.db.compareAndSwap<ExecutorBinding>(
            request.owner,
            "browser-bindings",
            request.taskId,
            { fence: previous.fence, executorId: previous.executorId, epoch: previous.epoch },
            binding,
          )
        : await this.db.insertIfAbsent(request.owner, "browser-bindings", binding);
      if (saved) return saved;
    }
    throw new BrowserError(
      "STALE_BROWSER_BINDING",
      "Browser routing raced with a newer binding. Retry the observation.",
      409,
    );
  }
}
