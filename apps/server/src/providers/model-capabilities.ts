import type { TextOptions } from "@tanstack/ai";
import { z } from "zod";
import type { ModelRequirements } from "../../../../packages/domain/src/runtime.ts";
import { type ModelProviderConfig, modelSpec } from "./config.ts";

export const modelCapabilitySchema = z
  .object({
    tools: z.boolean(),
    vision: z.boolean(),
    structuredOutput: z.boolean(),
    contextTokens: z.number().int().min(256).max(4000000),
  })
  .strict();
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;
export const capabilityConfigSchema = z.record(z.string().min(1), modelCapabilitySchema);

export function canonicalProvider(provider: string) {
  if (["local", "ollama", "llamacpp"].includes(provider)) return "local";
  if (["google", "gemini", "google-gemini"].includes(provider)) return "google";
  return provider === "xai-oauth" ? "grok" : provider;
}
export function canonicalModel(spec: string) {
  const { provider, model } = modelSpec(spec);
  return `${canonicalProvider(provider)}/${model}`;
}
export function routingCapabilities(model: string, config: ModelProviderConfig) {
  const declared = config.routing?.capabilities[canonicalModel(model)];
  return {
    capabilities: declared ?? {
      tools: true,
      vision: false,
      structuredOutput: true,
      contextTokens: 32768,
    },
    source: declared ? ("declared" as const) : ("compatibility_assumption" as const),
  };
}
export function meetsRequirements(capability: ModelCapability, requirements: ModelRequirements) {
  return (
    (!requirements.tools || capability.tools) &&
    (!requirements.vision || capability.vision) &&
    (!requirements.structuredOutput || capability.structuredOutput) &&
    requirements.contextTokens <= capability.contextTokens
  );
}

/** Conservative byte bound; no truncation or hidden context removal. Images require explicit vision. */
export function requestRequirements(
  options: TextOptions,
  override: Partial<ModelRequirements> = {},
  imageContextTokens = 8192,
): ModelRequirements {
  const containsImage = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(containsImage);
    const item = value as Record<string, unknown>;
    if (item.type === "image" || item.type === "image_url" || item.type === "input_image")
      return true;
    return Object.values(item).some(containsImage);
  };
  // Images have a separate capability gate and an operator-adjustable allowance.
  // Counting their base64 transport bytes as text invents token pressure.
  let images = 0;
  const input = JSON.stringify(
    {
      messages: options.messages,
      prompts: options.systemPrompts,
      tools: options.tools,
      schema: options.outputSchema,
    },
    (_key, value) => {
      if (
        value &&
        typeof value === "object" &&
        ["image", "image_url", "input_image"].includes(value.type)
      ) {
        images++;
        return { type: "image_context" };
      }
      return value;
    },
  );
  return {
    tools: Boolean(options.tools?.length) || Boolean(override.tools),
    vision: containsImage(options.messages) || Boolean(override.vision),
    structuredOutput: Boolean(options.outputSchema) || Boolean(override.structuredOutput),
    contextTokens: Math.max(
      Buffer.byteLength(input ?? "") + images * imageContextTokens,
      override.contextTokens ?? 0,
    ),
  };
}
