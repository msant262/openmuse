import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { Auth } from "./auth.ts";
import type { BrowserService } from "./browser.ts";
import { desktopInputSchema } from "./desktop-contract.ts";
import type { DesktopService } from "./desktop-service.ts";
import type { DesktopViewers } from "./desktop-viewers.ts";
import { AppError } from "./errors.ts";

export function desktopRoutes(
  desktop: DesktopService | undefined,
  viewers: DesktopViewers | undefined,
  auth: Auth,
  browser?: BrowserService,
) {
  const app = new Hono<{ Variables: { owner: string } }>();
  const available = () => {
    if (!desktop || !viewers)
      throw new AppError("A registered native desktop is not configured", 503);
    return { desktop, viewers };
  };
  const device = async (authorization?: string) => {
    if (!authorization?.startsWith("Bearer om1."))
      throw new AppError("Pair this device before opening a desktop viewer", 401);
    return auth.devices.identity(authorization.slice(7));
  };
  app.get("/", async (c) => {
    if (!desktop) return c.json({ enabled: false });
    return c.json({ enabled: true, ...(await desktop.status(c.get("owner"))) });
  });
  app.post("/viewers", async (c) => {
    const identity = await device(c.req.header("authorization")),
      services = available();
    const { sessionId } = z
      .object({ sessionId: z.uuid() })
      .strict()
      .parse(await c.req.json());
    return c.json(await services.viewers.open(identity.owner, identity.deviceId, sessionId), 201);
  });
  app.post("/viewers/:viewerId/:operation", async (c) => {
    const identity = await device(c.req.header("authorization")),
      { desktop, viewers } = available();
    const viewerId = z.uuid().parse(c.req.param("viewerId")),
      operation = c.req.param("operation");
    const raw = z.record(z.string(), z.unknown()).parse(await c.req.json());
    if (operation === "close") {
      z.object({}).strict().parse(raw);
      return c.json(await viewers.close(identity.owner, identity.deviceId, viewerId));
    }
    const common = z.object({ sessionId: z.uuid(), operationId: z.uuid() });
    if (operation === "observe") {
      const args = z
        .object({
          sessionId: z.uuid(),
          previousImage: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .strict()
        .parse(raw);
      return c.json(
        await viewers.run(
          identity.owner,
          identity.deviceId,
          viewerId,
          randomUUID(),
          operation,
          {
            sessionId: args.sessionId,
            ...(args.previousImage ? { previousImage: args.previousImage } : {}),
          },
          () =>
            desktop.observe(identity.owner, args.sessionId, c.req.raw.signal, args.previousImage),
        ),
      );
    }
    if (operation === "import-downloads") {
      const args = common.strict().parse(raw);
      if (!browser) throw new AppError("Native browser files are unavailable", 503);
      const session = await desktop.session(identity.owner, args.sessionId);
      return c.json(
        await viewers.run(
          identity.owner,
          identity.deviceId,
          viewerId,
          args.operationId,
          operation,
          { sessionId: args.sessionId },
          () =>
            desktop.run(
              identity.owner,
              session,
              false,
              () => browser.imports(identity.owner, session.browserSessionId, c.req.raw.signal),
              c.req.raw.signal,
            ),
          true,
        ),
      );
    }
    if (operation === "take-control") {
      const args = common.strict().parse(raw);
      return c.json(
        await viewers.run(
          identity.owner,
          identity.deviceId,
          viewerId,
          args.operationId,
          operation,
          { sessionId: args.sessionId },
          () => desktop.takeControl(identity.owner, args.sessionId, identity.deviceId),
        ),
      );
    }
    if (operation === "open-browser") {
      const args = common
        .extend({ url: z.url().max(4096) })
        .strict()
        .parse(raw);
      return c.json(
        await viewers.run(
          identity.owner,
          identity.deviceId,
          viewerId,
          args.operationId,
          operation,
          { sessionId: args.sessionId, url: args.url },
          async () => {
            const session = await desktop.session(identity.owner, args.sessionId);
            const response = await desktop.browserRequest(
              identity.owner,
              "/sessions",
              { id: session.browserSessionId, url: args.url },
              c.req.raw.signal,
            );
            const result = await response.json();
            await desktop.db.put(identity.owner, "browsers", {
              ...result,
              executorId: session.executorId,
              desktopSessionId: session.id,
            });
            return result;
          },
          true,
        ),
      );
    }
    if (operation === "release-control" || operation === "heartbeat") {
      const args = common.extend({ grantId: z.uuid() }).strict().parse(raw);
      return c.json(
        await viewers.run(
          identity.owner,
          identity.deviceId,
          viewerId,
          args.operationId,
          operation,
          { sessionId: args.sessionId, grantId: args.grantId },
          () =>
            operation === "heartbeat"
              ? desktop.renewControl(
                  identity.owner,
                  args.sessionId,
                  identity.deviceId,
                  args.grantId,
                )
              : desktop.releaseControl(
                  identity.owner,
                  args.sessionId,
                  identity.deviceId,
                  args.grantId,
                ),
        ),
      );
    }
    if (operation === "input") {
      const args = common
        .extend({ grantId: z.uuid(), input: desktopInputSchema })
        .strict()
        .parse(raw);
      // Journal binds typed values by hash in the native envelope. Human text
      // is not copied into public tool history or input receipts.
      const { action, ...frame } = args.input;
      const safe = {
        sessionId: args.sessionId,
        grantId: args.grantId,
        ...frame,
        action: action.action,
        inputHash: createHash("sha256").update(JSON.stringify(args.input)).digest("hex"),
      };
      return c.json(
        await viewers.run(
          identity.owner,
          identity.deviceId,
          viewerId,
          args.operationId,
          operation,
          safe,
          () =>
            desktop.humanAct(
              identity.owner,
              args.sessionId,
              identity.deviceId,
              args.grantId,
              args.input,
            ),
          true,
        ),
      );
    }
    throw new AppError("Desktop viewer operation not found", 404);
  });
  return app;
}
