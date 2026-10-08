import { Hono } from "hono";
import { z } from "zod";
import type { AgentIdentity, AgentNotification } from "../../../../packages/domain/src/agent.ts";
import {
  agentProfilePatchSchema,
  profileScopeSchema,
} from "../../../../packages/domain/src/agent.ts";
import { avatarDesignSchema } from "../../../../packages/domain/src/avatar.ts";
import { avatarRoutes } from "../avatars.ts";
import { AppError } from "../errors.ts";
import { memoryInput } from "../memory.ts";
import { playbookRoutes } from "../playbooks.ts";
import { proactivityRoutes } from "../proactivity/routes.ts";
import { routineInput } from "../routines.ts";
import { matchesReadEtag, workspaceReadEtag } from "../workspace-etag.ts";
import type { AgentService } from "./service.ts";
import { taskTimingUpdateSchema } from "./task-timing.ts";

const memorySchema = memoryInput.omit({ source: true }).extend({
  source: memoryInput.shape.source.removeDefault().optional(),
  text: memoryInput.shape.text.max(4000),
});
const revisionChange = z
  .object({ expectedRevision: z.number().int().min(0), requestId: z.string().min(1).max(256) })
  .strict();
const goalPatchSchema = z.object({
  expectedRevision: z.number().int().min(0).optional(),
  milestone: z
    .object({
      id: z.string().min(1).max(200),
      title: z.string().min(1).max(200).optional(),
      done: z.boolean().optional(),
      responsible: z.enum(["user", "agent"]).optional(),
    })
    .strict()
    .optional(),
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
  app.route("/avatars", avatarRoutes(service.avatars));
  app.route("/proactivity", proactivityRoutes(service));
  app.route("/playbooks", playbookRoutes(service.playbooks));
  app.get("/", async (c) => {
    const owner = c.get("owner");
    const etag = await workspaceReadEtag(service.db, owner, "agent");
    c.header("ETag", etag);
    c.header("Cache-Control", "private, no-cache");
    if (matchesReadEtag(c.req.header("If-None-Match"), etag)) return c.body(null, 304);
    return c.json(await service.snapshot(owner));
  });
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
  app.get("/profile/history", async (c) =>
    c.json(
      await service.profiles.history(
        c.get("owner"),
        c.req.query("threadId")
          ? { kind: "conversation", threadId: c.req.query("threadId") ?? "" }
          : { kind: "global" },
        {
          cursor: c.req.query("cursor"),
          limit: z.coerce
            .number()
            .int()
            .min(1)
            .max(100)
            .parse(c.req.query("limit") ?? 20),
        },
      ),
    ),
  );
  app.post("/profile/restore", async (c) =>
    c.json(
      await service.profiles.restore(c.get("owner"), {
        ...profileChange
          .omit({ patch: true })
          .extend({ revision: z.number().int().min(0) })
          .parse(await c.req.json()),
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
  app.post("/tasks/:id/remove", async (c) => {
    const { cancelActive } = z
      .object({ cancelActive: z.boolean().default(false) })
      .strict()
      .parse(await c.req.json());
    return c.json(await service.removeTask(c.get("owner"), c.req.param("id"), cancelActive));
  });
  app.post("/tasks/clear-finished", async (c) =>
    c.json(await service.clearFinishedTasks(c.get("owner"))),
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
    return c.json(
      await service.memory.save(c.get("owner"), body.text, body.source ?? "You", {
        validUntil: body.validUntil,
        timezone: body.timezone,
        origin: { kind: "settings" },
      }),
      201,
    );
  });
  app.get("/memories", async (c) =>
    c.json(
      await service.memory.page(c.get("owner"), {
        cursor: c.req.query("cursor"),
        query: c.req.query("query"),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(100)
          .parse(c.req.query("limit") ?? 40),
        includeInactive: c.req.query("includeInactive") === "true",
        status: z.enum(["active", "forgotten", "expired"]).optional().parse(c.req.query("status")),
      }),
    ),
  );
  app.post("/memories/:id", async (c) => {
    const body = memorySchema
      .extend(revisionChange.shape)
      .strict()
      .parse(await c.req.json());
    return c.json(
      await service.memory.update(c.get("owner"), c.req.param("id"), body, { kind: "settings" }),
    );
  });
  app.post("/memories/:id/forget", async (c) => {
    await service.memory.forget(
      c.get("owner"),
      c.req.param("id"),
      revisionChange.parse(await c.req.json()),
    );
    return c.json({ ok: true });
  });
  app.get("/memories/:id/history", async (c) =>
    c.json(
      await service.memory.history(c.get("owner"), c.req.param("id"), {
        cursor: c.req.query("cursor"),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(100)
          .parse(c.req.query("limit") ?? 20),
      }),
    ),
  );
  app.post("/memories/:id/restore", async (c) =>
    c.json(
      await service.memory.restore(c.get("owner"), c.req.param("id"), {
        ...revisionChange.extend({ revision: z.number().int().min(0) }).parse(await c.req.json()),
        allowForgotten: true,
      }),
    ),
  );
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
    const body = z
      .object({ expectedRevision: z.number().int().min(1).optional() })
      .parse(await c.req.json());
    await service.routines.remove(c.get("owner"), c.req.param("id"), body.expectedRevision);
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
        avatarDesign: avatarDesignSchema.optional(),
        avatarAssetId: z.string().min(1).max(128).optional(),
        showChatUpdates: z.boolean().optional(),
        expectedRevision: z.number().int().min(0).optional(),
        requestId: z.string().min(1).max(256).optional(),
      })
      .strict()
      .parse(await c.req.json());
    const owner = c.get("owner");
    await service.ensure(owner);
    if (body.avatarAssetId) await service.avatars.asset(owner, body.avatarAssetId);
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
    c.json(
      (
        await service.db.recordPage<AgentNotification>(c.get("owner"), "notifications", {
          limit: 100,
          order: "createdAt",
        })
      ).entries,
    ),
  );
  app.get("/notifications/page", async (c) =>
    c.json(
      await service.db.recordPage<AgentNotification>(c.get("owner"), "notifications", {
        order: "createdAt",
        cursor: c.req.query("cursor"),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(100)
          .parse(c.req.query("limit") ?? 40),
      }),
    ),
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
