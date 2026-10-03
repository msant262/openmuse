import { Hono } from "hono";
import { z } from "zod";
import { composioSlug } from "./contracts.ts";
import type { ComposioService } from "./service.ts";

export function composioRoutes(service: ComposioService) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/composio/status", async (c) => c.json(await service.status(c.get("owner"))));
  app.put("/composio/setup", async (c) => {
    const input = z
      .object({ apiKey: z.string().min(1).max(8192) })
      .strict()
      .parse(await c.req.json());
    return c.json(await service.setup(c.get("owner"), input.apiKey));
  });
  app.get("/composio/catalog", async (c) =>
    c.json(await service.catalog(c.get("owner"), c.req.query())),
  );
  app.get("/composio/toolkits/:slug", async (c) =>
    c.json(await service.toolkit(c.get("owner"), composioSlug.parse(c.req.param("slug")))),
  );
  app.get("/composio/connections", async (c) => c.json(await service.overview(c.get("owner"))));
  app.post("/composio/toolkits/:slug/connect", async (c) => {
    const input = z
      .object({
        purpose: z
          .string()
          .trim()
          .min(1)
          .max(600)
          .default("Connect this app to use it in your conversations"),
        replace: z.boolean().optional(),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await service.connect(c.get("owner"), {
        ...input,
        toolkit: composioSlug.parse(c.req.param("slug")),
      }),
    );
  });
  app.get("/composio/requests/:id", async (c) =>
    c.json(await service.statusInteraction(c.get("owner"), z.uuid().parse(c.req.param("id")))),
  );
  app.post("/composio/requests/:id/cancel", async (c) =>
    c.json(await service.cancel(c.get("owner"), z.uuid().parse(c.req.param("id")))),
  );
  app.post("/composio/requests/:id/retry", async (c) =>
    c.json(await service.retry(c.get("owner"), z.uuid().parse(c.req.param("id")))),
  );
  app.get("/composio/flows/:id", async (c) =>
    c.json(await service.flow(c.get("owner"), z.uuid().parse(c.req.param("id")))),
  );
  app.post("/composio/flows/:id/cancel", async (c) => {
    const id = z.uuid().parse(c.req.param("id"));
    await service.cancel(c.get("owner"), id);
    return c.json(await service.flow(c.get("owner"), id));
  });
  app.post("/composio/connections/:id/disconnect", async (c) =>
    c.json(await service.disconnect(c.get("owner"), composioSlug.parse(c.req.param("id")))),
  );
  return app;
}
