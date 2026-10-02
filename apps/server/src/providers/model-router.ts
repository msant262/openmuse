import { randomUUID } from "node:crypto";
import type {
  ModelRequirements,
  ModelRoutingStatus,
  WorkClass,
} from "../../../../packages/domain/src/runtime.ts";
import {
  modelRequirementsSchema,
  modelRoutingStatusSchema,
  workClassSchema,
} from "../../../../packages/domain/src/runtime.ts";
import { defaultModelRouting, type ModelProviderConfig, modelSpec } from "./config.ts";
import { type ModelProviderError, ModelUnavailableError } from "./errors.ts";
import {
  canonicalModel,
  canonicalProvider,
  type ModelCapability,
  meetsRequirements,
  modelCapabilitySchema,
  routingCapabilities,
} from "./model-capabilities.ts";
import { ProviderHealth } from "./provider-health.ts";

export interface ModelLease {
  id: string;
  model: string;
  provider: string;
  workClass: WorkClass;
}
export type ModelLeaseOutcome = {
  status: "succeeded" | "failed" | "cancelled";
  failure?: ModelProviderError;
};
export interface ModelSelectionRequest {
  workClass: WorkClass;
  requirements: ModelRequirements;
  excludedModels?: readonly string[];
  models?: readonly string[];
  signal?: AbortSignal;
  deadline?: number;
}
type Pending = {
  request: ModelSelectionRequest;
  models: string[];
  resolve: (lease: ModelLease) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
};

export class ModelRouter {
  readonly health: ProviderHealth;
  private readonly models = new Set<string>();
  private readonly active = new Map<string, ModelLease>();
  private readonly pending: Pending[] = [];
  private readonly verified = new Map<string, ModelCapability>();
  private readonly observedQuota = new Map<string, number>();
  private lastSelection?: { provider: string; model: string; fallback: boolean };
  constructor(
    private readonly config: ModelProviderConfig,
    private readonly now = Date.now,
  ) {
    if (config.routing?.quotaScope && config.routing.quotaScope !== "process")
      throw new Error("Shared model quotas require a shared inference admission adapter.");
    this.health = new ProviderHealth(
      config.routing?.cooldownMs ?? defaultModelRouting.cooldownMs,
      now,
    );
  }
  register(models: readonly string[]) {
    for (const model of models) this.models.add(model);
  }
  confirmCapabilities(model: string, capability: ModelCapability) {
    this.verified.set(canonicalModel(model), modelCapabilitySchema.parse(capability));
    this.pump();
  }
  /** Only a measured concurrency limit, never an RPM/token rate header, reduces the seat count. */
  observeQuota(provider: string, concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1)
      throw new Error("Invalid observed inference quota");
    const key = canonicalProvider(provider);
    this.observedQuota.set(key, Math.min(this.observedQuota.get(key) ?? 32, concurrency));
    this.pump();
  }
  selected(model: string, fallback: boolean) {
    this.lastSelection = {
      provider: canonicalProvider(modelSpec(model).provider),
      model: modelSpec(model).model,
      fallback,
    };
  }
  private quota(provider: string) {
    const declared = this.config.routing?.quotas[provider] ?? {
      total: 4,
      background: 3,
      interactive: 1,
    };
    const total = Math.min(
      declared.total,
      declared.background + declared.interactive,
      this.observedQuota.get(provider) ?? declared.total,
    );
    return {
      total,
      background: total === 1 ? 1 : Math.min(declared.background, total - 1),
      interactive: Math.min(declared.interactive, total),
    };
  }
  eligibleModels(
    requirements: ModelRequirements,
    models: readonly string[],
    excludedModels: readonly string[] = [],
  ) {
    modelRequirementsSchema.parse(requirements);
    const excluded = new Set(excludedModels.map(canonicalModel));
    return models.filter(
      (model) =>
        !excluded.has(canonicalModel(model)) &&
        meetsRequirements(
          this.verified.get(canonicalModel(model)) ??
            routingCapabilities(model, this.config).capabilities,
          requirements,
        ),
    );
  }
  private eligible(request: ModelSelectionRequest, models: string[]) {
    return this.eligibleModels(request.requirements, models, request.excludedModels);
  }
  private unavailable(models: string[], reason: "capability" | "cooldown") {
    const retryAt =
      reason === "cooldown"
        ? Math.min(...models.map((m) => this.health.get(m).cooldownUntil))
        : undefined;
    return new ModelUnavailableError(reason, Number.isFinite(retryAt) ? retryAt : undefined);
  }
  select(request: ModelSelectionRequest): Promise<ModelLease> {
    workClassSchema.parse(request.workClass);
    modelRequirementsSchema.parse(request.requirements);
    const models = [...(request.models ?? this.models)];
    this.register(models);
    request.signal?.throwIfAborted();
    const eligible = this.eligible(request, models);
    if (!eligible.length) {
      const capable = this.eligibleModels(request.requirements, models);
      return Promise.reject(this.unavailable(capable, capable.length ? "cooldown" : "capability"));
    }
    if (eligible.every((model) => this.health.get(model).cooldownUntil > this.now()))
      return Promise.reject(this.unavailable(eligible, "cooldown"));
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.remove(pending);
        reject(request.signal?.reason);
        this.pump();
      };
      const timeout = setTimeout(
        () => {
          this.remove(pending);
          reject(new ModelUnavailableError("quota"));
          this.pump();
        },
        Math.max(1, (request.deadline ?? this.now() + 300000) - this.now()),
      );
      const pending: Pending = {
        request,
        models,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timeout);
          request.signal?.removeEventListener("abort", abort);
        },
      };
      request.signal?.addEventListener("abort", abort, { once: true });
      this.pending.push(pending);
      this.pump();
    });
  }
  private remove(pending: Pending) {
    const index = this.pending.indexOf(pending);
    if (index !== -1) this.pending.splice(index, 1);
    pending.cleanup();
  }
  private pump() {
    // Interactive requests take the next available seat, including quota one.
    for (const pending of [...this.pending].sort(
      (a, b) =>
        Number(a.request.workClass === "background") - Number(b.request.workClass === "background"),
    )) {
      const candidates = this.eligible(pending.request, pending.models);
      const healthy = candidates.filter(
        (model) => this.health.get(model).cooldownUntil <= this.now(),
      );
      if (!healthy.length) {
        this.remove(pending);
        const capable = candidates.length
          ? candidates
          : this.eligibleModels(pending.request.requirements, pending.models);
        pending.reject(this.unavailable(capable, capable.length ? "cooldown" : "capability"));
        continue;
      }
      const model = healthy.find((model) => {
        const provider = canonicalProvider(modelSpec(model).provider),
          quota = this.quota(provider);
        const active = [...this.active.values()].filter((lease) => lease.provider === provider);
        return (
          active.length < quota.total &&
          active.filter((lease) => lease.workClass === pending.request.workClass).length <
            quota[pending.request.workClass]
        );
      });
      if (!model) continue;
      const lease: ModelLease = {
        id: randomUUID(),
        model,
        provider: canonicalProvider(modelSpec(model).provider),
        workClass: pending.request.workClass,
      };
      this.active.set(lease.id, lease);
      this.remove(pending);
      pending.resolve(lease);
    }
  }
  release(lease: ModelLease, outcome: ModelLeaseOutcome) {
    const admitted = this.active.get(lease.id);
    if (!admitted) return;
    if (!this.active.delete(lease.id)) return;
    if (outcome.failure) this.health.report(admitted.model, outcome.failure);
    else if (outcome.status === "succeeded") this.health.succeeded(admitted.model);
    this.pump();
  }
  status(): ModelRoutingStatus {
    return modelRoutingStatusSchema.parse({
      quotaScope: "process",
      active: this.lastSelection,
      providers: [
        ...new Set([...this.models].map((m) => canonicalProvider(modelSpec(m).provider))),
      ].map((provider) => ({
        provider,
        quota: this.quota(provider),
        active: [...this.active.values()].filter((l) => l.provider === provider).length,
      })),
      models: [...this.models].map((model) => ({
        model,
        capabilitySource: this.verified.has(canonicalModel(model))
          ? "preflight"
          : routingCapabilities(model, this.config).source,
        capabilities:
          this.verified.get(canonicalModel(model)) ??
          routingCapabilities(model, this.config).capabilities,
        ...this.health.get(model),
      })),
    });
  }
}

// Public route identity only; keys/tokens never enter cache keys or status.
const routers = new Map<string, ModelRouter>();
function publicRoute(baseUrl: string | undefined) {
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "invalid-route";
  }
}
export function sharedModelRouter(config: ModelProviderConfig) {
  const identity = JSON.stringify([
    config.authDir,
    config.chatgptFile,
    config.grokFile,
    publicRoute(process.env.OPENAI_BASE_URL),
    publicRoute(process.env.ANTHROPIC_BASE_URL),
    publicRoute(process.env.GOOGLE_GENERATIVE_AI_BASE_URL),
    config.compatible?.baseUrl,
    config.compatible?.api,
    config.mimo?.baseUrl,
    config.mimo?.api,
    config.local.baseUrl,
    config.local.api,
    config.routing,
  ]);
  let router = routers.get(identity);
  if (!router) {
    router = new ModelRouter(config);
    routers.set(identity, router);
  }
  return router;
}
