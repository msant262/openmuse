import { fallbackAllowed, type ModelProviderError } from "./errors.ts";
import { canonicalModel } from "./model-capabilities.ts";

export interface ModelHealth {
  failures: number;
  cooldownUntil: number;
  code?: string;
  message?: string;
}

/** Account/model health is shared by requests; a failing model never disables another route. */
export class ProviderHealth {
  private readonly models = new Map<string, ModelHealth>();
  constructor(
    private readonly cooldownMs = 200,
    private readonly now = Date.now,
  ) {}
  get(model: string): ModelHealth {
    return this.models.get(canonicalModel(model)) ?? { failures: 0, cooldownUntil: 0 };
  }
  report(model: string, failure: ModelProviderError) {
    const previous = this.get(model);
    const failures = previous.failures + 1;
    const delay =
      failure.retryAfterMs ?? Math.min(60000, this.cooldownMs * 2 ** Math.min(failures - 1, 8));
    this.models.set(canonicalModel(model), {
      failures,
      cooldownUntil: this.now() + (fallbackAllowed(failure) ? delay : 0),
      code: failure.code,
      message: failure.message,
    });
  }
  succeeded(model: string) {
    this.models.delete(canonicalModel(model));
  }
}
