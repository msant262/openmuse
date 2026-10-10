import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { consumeBrowserFile } from "../browser-files.ts";
import { acceptDesktopFrame } from "../desktop-frames.ts";
import { consumeDesktopText } from "../desktop-input.ts";
import { AppError } from "../errors.ts";
import { executorReceiptSchema, safeOperationId } from "./protocol.ts";
import { consumePythonReply } from "./python-replies.ts";
import type { ExecutorRegistry } from "./registry.ts";

/** These routes intentionally live outside /api session auth. The independent
 * middleware recognizes only this executor's scoped node credential, which cannot
 * authenticate as a user or call administrative/application routes.
 */
export function executorRoutes(registry: ExecutorRegistry) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof z.ZodError)
      return c.json(
        {
          error: "Invalid native protocol envelope",
          issues: error.issues.map((value) => value.message),
        },
        422,
      );
    if (error instanceof AppError) return c.json({ error: error.message }, error.status);
    if (error instanceof SyntaxError) return c.json({ error: "Invalid native protocol JSON" }, 400);
    return c.json({ error: "Native protocol persistence or dispatch failed" }, 503);
  });
  app.use("/:executorId/*", bodyLimit({ maxSize: 36 * 1024 * 1024 }));
  const epoch = z.number().int().positive();
  app.post("/:executorId/desktop/input", async (c) => {
    const id = c.req.param("executorId");
    registry.authenticate(id, c.req.header("authorization"));
    return c.json(await consumeDesktopText(registry, id, await c.req.json()));
  });
  app.post("/:executorId/browser-files/:reference/consume", async (c) => {
    const id = c.req.param("executorId");
    registry.authenticate(id, c.req.header("authorization"));
    return c.json(
      await consumeBrowserFile(registry, id, c.req.param("reference"), await c.req.json()),
    );
  });
  app.post("/:executorId/python-replies/:reference/consume", async (c) => {
    const id = c.req.param("executorId");
    registry.authenticate(id, c.req.header("authorization"));
    return c.json(
      await consumePythonReply(registry, id, c.req.param("reference"), await c.req.json()),
    );
  });
  app.post("/:executorId/desktop/frame", async (c) => {
    const id = c.req.param("executorId");
    registry.authenticate(id, c.req.header("authorization"));
    return c.json(await acceptDesktopFrame(registry, id, await c.req.json()));
  });
  for (const route of ["register", "heartbeat", "claim", "receipt", "reconcile", "artifact"]) {
    app.post(`/:executorId/${route}`, async (c) => {
      const executorId = c.req.param("executorId");
      registry.authenticate(executorId, c.req.header("authorization"));
      const raw = z.record(z.string(), z.unknown()).parse(await c.req.json());
      if (route === "register") {
        if (raw.executorId !== executorId)
          throw new AppError("Hello executor does not match scoped route", 403);
        return c.json(await registry.register(raw));
      }
      if (route === "reconcile") return c.json(await registry.reconcile(executorId, raw));
      const version = epoch.parse(raw.epoch);
      if (route === "heartbeat")
        return c.json(await registry.heartbeat(executorId, version, raw.readiness, raw.pauseAck));
      if (route === "claim") {
        const waitMs = z.number().int().min(0).max(20000).default(15000).parse(raw.waitMs);
        return c.json(
          await registry.claimOperations(executorId, version, { waitMs, signal: c.req.raw.signal }),
        );
      }
      if (route === "receipt") {
        const body = z
          .object({
            operationId: safeOperationId,
            sequence: z.number().int().positive(),
            receipt: executorReceiptSchema,
          })
          .parse(raw);
        return c.json(
          await registry.submitReceipt(
            executorId,
            version,
            body.operationId,
            body.sequence,
            body.receipt,
          ),
        );
      }
      return c.json(await registry.publishArtifact(executorId, version, raw));
    });
  }
  return app;
}
