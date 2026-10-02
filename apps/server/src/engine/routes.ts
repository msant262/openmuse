import { Hono } from "hono";
import { z } from "zod";
import type {
  AgentIdentity,
  AgentMemory,
  AgentNotification,
} from "../../../../packages/domain/src/agent.ts";
import {
  agentProfilePatchSchema,
  profileScopeSchema,
} from "../../../../packages/domain/src/agent.ts";
import { AppError } from "../errors.ts";
import { routineInput } from "../routines.ts";
import type { AgentService } from "./service.ts";
import { taskTimingUpdateSchema } from "./task-timing.ts";

const text = z.string().trim().min(1).max(4000);
const memorySchema = z.object({ text, source: z.string().trim().min(1).max(200).optional() });
const goalPatchSchema = z.object({
  status: z.enum(["active", "paused", "completed"]).optional(),
  milestones: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        title: z.string().trim().min(1).max(200),
        done: z.boolean(),
      }),
    )
    .max(100)
    .optional(),
});

export function agentRoutes(service: AgentService): Hono<{ Variables: { owner: string } }> {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/", async (c) => c.json(await service.snapshot(c.get("owner"))));
  app.get("/profile", async (c) =>
    c.json(await service.profiles.get(c.get("owner"), c.req.query("threadId"))),
  );
  const profileChange = z
    .object({
      scope: profileScopeSchema,
      expectedRevision: z.number().int().min(0),
      requestId: z.string().min(1).max(256),
      patch: agentProfilePatchSchema,
    })
    .strict();
  app.post("/profile", async (c) =>
    c.json(
      await service.profiles.update(c.get("owner"), {
        ...profileChange.parse(await c.req.json()),
        origin: { kind: "settings" },
      }),
    ),
  );
  app.post("/profile/reset", async (c) =>
    c.json(
      await service.profiles.reset(c.get("owner"), {
        ...profileChange.omit({ patch: true }).parse(await c.req.json()),
        origin: { kind: "settings" },
      }),
    ),
  );
  app.get("/interactions/:id", async (c) =>
    c.json(await service.interactions.status(c.get("owner"), c.req.param("id"))),
  );
  app.post("/interactions/:id/answer", async (c) =>
    c.json(
      await service.interactions.answer(c.get("owner"), c.req.param("id"), await c.req.json()),
    ),
  );
  app.post("/tasks", async (c) =>
    c.json(await service.createTask(c.get("owner"), await c.req.json()), 201),
  );
  app.post("/tasks/:id/directives", async (c) =>
    c.json(
      await service.mailbox.enqueue(
        c.get("owner"),
        c.req.param("id"),
        z
          .object({
            clientMessageId: z.string().min(1).max(256),
            text: z.string().trim().min(1).max(24000),
            expectedRevision: z.number().int().nonnegative().optional(),
            threadId: z
              .string()
              .regex(/^[\w.-]+$/)
              .optional(),
            attachmentIds: z.array(z.string()).max(30).optional(),
          })
          .strict()
          .parse(await c.req.json()),
      ),
      201,
    ),
  );
  app.post("/tasks/:id/timing", async (c) =>
    c.json(
      await service.timing.update(
        c.get("owner"),
        c.req.param("id"),
        taskTimingUpdateSchema.parse(await c.req.json()),
      ),
    ),
  );
  app.post("/tasks/:id/budget", async (c) =>
    c.json(
      await service.actor.extendBudget(
        c.get("owner"),
        c.req.param("id"),
        z
          .object({
            requestId: z.string().min(1).max(256),
            expectedRevision: z.number().int().nonnegative(),
            additionalSteps: z.number().int().positive().max(10000),
            additionalMilliseconds: z.number().int().positive().max(86400000).optional(),
          })
          .strict()
          .parse(await c.req.json()),
      ),
    ),
  );
  app.get("/tasks/:id", async (c) =>
    c.json(await service.detail(c.get("owner"), c.req.param("id"))),
  );
  app.post("/tasks/:id/control", async (c) => {
    const { action } = z
      .object({ action: z.enum(["pause", "resume", "cancel", "retry"]) })
      .parse(await c.req.json());
    return c.json(await service.control(c.get("owner"), c.req.param("id"), action));
  });
  app.post("/tasks/:id/priority", async (c) => {
    const { priority } = z
      .object({ priority: z.enum(["low", "normal", "high"]) })
      .strict()
      .parse(await c.req.json());
    return c.json(await service.updateTaskPriority(c.get("owner"), c.req.param("id"), priority));
  });
  app.post("/runtime-pause", async (c) => {
    const body = z
      .object({ paused: z.boolean(), expectedRevision: z.number().int().min(0) })
      .strict()
      .parse(await c.req.json());
    return c.json(await service.setRuntimePause(c.get("owner"), body));
  });
  app.post("/tasks/:id/input", async (c) => {
    const body = z
      .object({
        answer: z.string().trim().min(1).max(12000),
        fields: z
          .record(z.string().min(1).max(300), z.union([z.string().max(12000), z.boolean()]))
          .optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await service.answer(c.get("owner"), c.req.param("id"), body.answer, body.fields),
    );
  });
  app.post("/goals", async (c) =>
    c.json(await service.createGoal(c.get("owner"), await c.req.json()), 201),
  );
  app.post("/goals/:id", async (c) => {
    const body = goalPatchSchema.parse(await c.req.json());
    return c.json(await service.updateGoal(c.get("owner"), c.req.param("id"), body));
  });
  app.post("/monitors", async (c) =>
    c.json(await service.createMonitor(c.get("owner"), await c.req.json()), 201),
  );
  app.post("/monitors/:id/control", async (c) => {
    const { action } = z
      .object({ action: z.enum(["pause", "resume", "stop", "check"]) })
      .parse(await c.req.json());
    return c.json(await service.controlMonitor(c.get("owner"), c.req.param("id"), action));
  });
  app.post("/ideas/refresh", async (c) => c.json(await service.refreshIdeas(c.get("owner"))));
  app.post("/ideas/:id", async (c) => {
    const body = z
      .object({
        action: z.enum(["accept", "dismiss"]),
        prompt: z.string().trim().min(1).max(12000).optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await service.decideIdea(c.get("owner"), c.req.param("id"), body.action, body.prompt),
    );
  });
  app.post("/memories", async (c) => {
    const body = memorySchema.parse(await c.req.json());
    return c.json(await service.memory.save(c.get("owner"), body.text, body.source ?? "You"), 201);
  });
  app.post("/memories/:id", async (c) => {
    const body = memorySchema.parse(await c.req.json());
    const memory = await service.db.compareAndSwap<AgentMemory>(
      c.get("owner"),
      "memories",
      c.req.param("id"),
      {},
      body,
    );
    if (!memory) throw new AppError("Memory not found", 404);
    return c.json(memory);
  });
  app.post("/memories/:id/forget", async (c) => {
    await service.memory.forget(c.get("owner"), c.req.param("id"));
    return c.json({ ok: true });
  });
  app.get("/routines", async (c) =>
    c.json({
      routines: await service.routines.list(c.get("owner")),
      timezone: service.routines.timezone,
    }),
  );
  app.post("/routines", async (c) => {
    const { idempotencyKey, ...body } = z
      .object({ ...routineInput.shape, idempotencyKey: z.string().min(16).max(160) })
      .strict()
      .parse(await c.req.json());
    return c.json(await service.routines.create(c.get("owner"), body, idempotencyKey), 201);
  });
  app.post("/routines/:id", async (c) =>
    c.json(await service.routines.update(c.get("owner"), c.req.param("id"), await c.req.json())),
  );
  app.post("/routines/:id/delete", async (c) => {
    await service.routines.remove(c.get("owner"), c.req.param("id"));
    return c.json({ deleted: true });
  });
  app.get("/push/devices", async (c) => c.json(await service.push.devices(c.get("owner"))));
  app.post("/push/devices", async (c) =>
    c.json(await service.push.register(c.get("owner"), await c.req.json()), 201),
  );
  app.post("/push/devices/:id/delete", async (c) =>
    c.json(await service.push.unregister(c.get("owner"), c.req.param("id"))),
  );
  app.post("/identity", async (c) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        tone: z.enum(["warm", "concise", "thoughtful"]).optional(),
        avatar: z.enum(["sky", "sand", "lilac"]).optional(),
        showChatUpdates: z.boolean().optional(),
        expectedRevision: z.number().int().min(0).optional(),
        requestId: z.string().min(1).max(256).optional(),
      })
      .strict()
      .parse(await c.req.json());
    const owner = c.get("owner");
    await service.ensure(owner);
    if (body.name || body.tone) {
      if (body.expectedRevision === undefined || !body.requestId)
        throw new AppError("Personality edits require expectedRevision and requestId", 422);
      await service.profiles.update(owner, {
        scope: { kind: "global" },
        patch: {
          ...(body.name ? { assistantName: body.name } : {}),
          ...(body.tone ? { tone: body.tone } : {}),
        },
        expectedRevision: body.expectedRevision,
        requestId: body.requestId,
        origin: { kind: "settings" },
      });
    }
    const { expectedRevision, requestId, ...appearance } = body;
    const identity = await service.db.compareAndSwap<AgentIdentity>(
      owner,
      "agent-settings",
      "identity",
      {},
      appearance,
    );
    if (!identity) throw new AppError("Agent identity changed; refresh and try again", 409);
    return c.json(identity);
  });
  app.get("/notifications", async (c) =>
    c.json((await service.snapshot(c.get("owner"))).notifications),
  );
  app.post("/notifications/:id/read", async (c) => {
    const notification = await service.db.compareAndSwap<AgentNotification>(
      c.get("owner"),
      "notifications",
      c.req.param("id"),
      {},
      { read: true },
    );
    if (!notification) throw new AppError("Notification not found", 404);
    return c.json(notification);
  });
  app.post("/sample-page", async (c) => {
    if (service.config.mode !== "sample") throw new AppError("Not found", 404);
    const body = z.object({ text: z.string().max(100000) }).parse(await c.req.json());
    await service.db.put(c.get("owner"), "sample-pages", { id: "availability", text: body.text });
    return c.json({ ok: true });
  });
  return app;
}
