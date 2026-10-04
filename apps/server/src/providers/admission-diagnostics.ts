import { z } from "zod";
import {
  type ModelRequirements,
  modelRequirementsSchema,
} from "../../../../packages/domain/src/runtime.ts";
import { canonicalModel, meetsRequirements } from "./model-capabilities.ts";
import type { ModelRouter } from "./model-router.ts";

/** Numeric admission evidence only: never prompts, arguments, images or credentials. */
export const modelAdmissionSchema = z
  .object({
    stage: z.enum(["context_projection", "provider_dispatch"]),
    requirements: modelRequirementsSchema.strict(),
    candidates: z
      .array(
        z
          .object({
            model: z.string().min(1).max(240),
            capabilities: modelRequirementsSchema.strict(),
            capabilitySource: z.enum(["declared", "preflight", "compatibility_assumption"]),
            eligible: z.boolean(),
            considered: z.boolean(),
            cooldownUntil: z.number().nonnegative(),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();

export function modelAdmission(
  stage: "context_projection" | "provider_dispatch",
  requirements: ModelRequirements,
  models: readonly string[],
  router?: ModelRouter,
  considered: readonly string[] = models,
) {
  const configured = new Set(models.map(canonicalModel));
  const candidates = new Set(considered.map(canonicalModel));
  const result = modelAdmissionSchema.safeParse({
    stage,
    requirements,
    candidates: (router?.status().models ?? [])
      .filter((model) => configured.has(canonicalModel(model.model)))
      .slice(0, 64)
      .map(({ model, capabilities, capabilitySource, cooldownUntil }) => ({
        model,
        capabilities,
        capabilitySource,
        cooldownUntil,
        eligible: meetsRequirements(capabilities, requirements),
        considered: candidates.has(canonicalModel(model)),
      })),
  });
  return result.success ? result.data : undefined;
}
