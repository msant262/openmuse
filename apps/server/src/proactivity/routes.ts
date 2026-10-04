import { Hono } from "hono";
import { z } from "zod";
import type { AgentService } from "../engine/service.ts";

export function proactivityRoutes(service: AgentService) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/status", async (c) => c.json(await service.proactivity.status(c.get("owner"))));
  app.post("/learning/retry", async (c) => c.json(await service.learning.retry(c.get("owner"))));
  app.get("/settings", async (c) => c.json(await service.proactivity.settings.get(c.get("owner"))));
  app.post("/settings", async (c) =>
    c.json(await service.proactivity.settings.update(c.get("owner"), await c.req.json())),
  );
  app.get("/suggestions", async (c) =>
    c.json({
      suggestions: await service.proactivity.list(c.get("owner"), c.req.query("threadId")),
    }),
  );
  app.get("/cycles", async (c) =>
    c.json(await service.db.listPage(c.get("owner"), "proactivity-cycles", 20)),
  );
  app.post("/review", async (c) => {
    const owner = c.get("owner"),
      cycleId = await service.proactivity.scheduleDue(owner, Date.now(), true);
    const cycle = cycleId
      ? await service.db.get<{ taskId: string }>(owner, "proactivity-cycles", cycleId)
      : null;
    const status = cycle
      ? (await service.getTask(owner, cycle.taskId)).status
      : (await service.runtimePause.get(owner)).paused
        ? "paused"
        : (await service.proactivity.settings.get(owner)).enabled
          ? "not_due"
          : "disabled";
    return c.json({ cycleId, status });
  });
  app.post("/suggestions/:id/respond", async (c) =>
    c.json(
      await service.proactivity.respond(c.get("owner"), c.req.param("id"), await c.req.json()),
    ),
  );
  app.post("/suggestions/:id/unsuppress", async (c) => {
    const body = z
      .object({ expectedRevision: z.number().int().min(1) })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await service.proactivity.unsuppress(
        c.get("owner"),
        c.req.param("id"),
        body.expectedRevision,
      ),
    );
  });
  return app;
}
