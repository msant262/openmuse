import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { refreshModelCatalog, type SavedModelCatalog } from "./catalog.ts";
import { modelProviderConfig, modelSpec } from "./config.ts";
import {
  canonicalModel,
  registerCatalogCapabilities,
  routingCapabilities,
} from "./model-capabilities.ts";
import { sharedModelRouter } from "./model-router.ts";
import { providerConfigured } from "./models.ts";

type ModelPreference = { id: "model"; model: string | null; updatedAt: string };

/** Connected provider catalogs and operator-configured models. Credentials never enter this response. */
export async function modelPreferences(db: Store, config: Config, owner: string) {
  config.modelProviders ??= modelProviderConfig(config.dataDir);
  const providers = config.modelProviders;
  const catalog = await db.get<SavedModelCatalog>(owner, "settings", "model-catalog");
  for (const item of catalog?.models ?? [])
    if (item.capabilities) registerCatalogCapabilities(providers, item.id, item.capabilities);
  const candidates = [
    ...(catalog?.models.map((item) => item.id) ?? []),
    config.model,
    ...(config.modelFallbacks ?? []),
    ...Object.keys(providers.routing?.capabilities ?? {}),
  ].filter((model): model is string => Boolean(model));
  const models = [...new Set(candidates.map(canonicalModel))].map((id) => {
    const { provider, model } = modelSpec(id);
    return {
      id,
      label: catalog?.models.find((item) => item.id === id)?.label ?? model,
      provider,
      available:
        providerConfigured(id, providers) &&
        routingCapabilities(id, providers).capabilities.tools &&
        (!catalog?.models.some((item) => item.id === id) ||
          Boolean(catalog.models.find((item) => item.id === id)?.capabilities) ||
          Boolean(providers.routing?.capabilities[id]) ||
          [config.model, ...(config.modelFallbacks ?? [])].some(
            (model) => model && canonicalModel(model) === id,
          )),
    };
  });
  const saved = await db.get<ModelPreference>(owner, "settings", "model");
  const selected = saved?.model ?? null;
  const available = models.find((model) => model.id === selected && model.available);
  return {
    selected,
    effective: available?.id ?? config.model ?? null,
    models,
    fallbacks: config.modelFallbacks ?? [],
  };
}

export async function modelSelection(db: Store, config: Config, owner: string) {
  const preference = await modelPreferences(db, config, owner);
  return {
    model: preference.effective ?? undefined,
    fallbacks: [
      ...new Set([
        ...(preference.selected && config.model && config.model !== preference.effective
          ? [config.model]
          : []),
        ...(config.modelFallbacks ?? []),
      ]),
    ].filter((model) => canonicalModel(model) !== preference.effective),
  };
}

export function modelPreferenceRoutes(db: Store, config: Config) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/models/preferences", async (c) => {
    await refreshModelCatalog(db, config, c.get("owner"));
    return c.json(await modelPreferences(db, config, c.get("owner")));
  });
  app.put("/models/preferences", async (c) => {
    const { model } = z
      .object({ model: z.string().min(1).max(200).nullable() })
      .strict()
      .parse(await c.req.json());
    const owner = c.get("owner");
    const preferences = await modelPreferences(db, config, owner);
    if (model !== null && !preferences.models.some((item) => item.id === model && item.available))
      throw new AppError(
        "Choose an available model from your connected providers",
        422,
        "MODEL_NOT_AVAILABLE",
      );
    await db.put(owner, "settings", { id: "model", model, updatedAt: new Date().toISOString() });
    return c.json(await modelPreferences(db, config, owner));
  });
  return app;
}

/** Context projection and inference must use the same selected model order. */
export function selectionContextModel(
  config: Config,
  selection: { model?: string; fallbacks: string[] },
): import("../engine/context-budget.ts").ContextModelResolver | undefined {
  if (!selection.model) return undefined;
  config.modelProviders ??= modelProviderConfig(config.dataDir);
  const providers = config.modelProviders;
  const models = [selection.model, ...selection.fallbacks];
  const router = sharedModelRouter(providers);
  return (requirements) => ({
    id: "selected-model-context-capacity",
    contextTokens: router.contextCapacity(
      { ...requirements, contextTokens: requirements.contextTokens ?? 0 },
      models,
    ),
    outputReserveTokens: 4096,
    imageContextTokens: providers.routing?.imageContextTokens ?? 8192,
  });
}
