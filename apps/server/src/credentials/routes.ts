import { Hono } from "hono";
import { z } from "zod";
import { CredentialBroker } from "./broker.ts";
import type { CredentialLoginService } from "./login.ts";

export function credentialRoutes(
  broker: CredentialBroker,
  login?: CredentialLoginService,
): Hono<{ Variables: { owner: string } }> {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/credential-requests/:id", async (c) =>
    c.json(await broker.status(c.get("owner"), z.uuid().parse(c.req.param("id")))),
  );
  app.post("/credential-requests/:id/submit", async (c) => {
    const body = z
      .object({
        clientResponseId: z
          .string()
          .min(8)
          .max(256)
          .regex(/^[\w.:-]+$/),
        values: z.record(z.string(), z.unknown()),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await broker.submit(c.get("owner"), z.uuid().parse(c.req.param("id")), body),
      200,
    );
  });
  app.get("/credentials/:id", async (c) => {
    const id = z.uuid().parse(c.req.param("id"));
    const connection = await broker.connection(c.get("owner"), id);
    return c.json(connection);
  });
  app.get("/credentials/:id/bindings", async (c) =>
    c.json(await broker.browserBindings(c.get("owner"), z.uuid().parse(c.req.param("id")))),
  );
  if (login) {
    app.get("/credential-challenges/:id", async (c) =>
      c.json(await login.challenge(c.get("owner"), z.uuid().parse(c.req.param("id")))),
    );
    app.post("/credential-challenges/:id/submit", async (c) => {
      const body = z
        .object({
          clientResponseId: z
            .string()
            .min(8)
            .max(256)
            .regex(/^[\w.:-]+$/),
          value: z.string().min(1).max(128),
        })
        .strict()
        .parse(await c.req.json());
      return c.json(
        await login.submitChallenge(c.get("owner"), z.uuid().parse(c.req.param("id")), body),
      );
    });
  }
  app.post("/credentials/:id/revoke", async (c) => {
    await c.req.json().catch(() => ({}));
    return c.json(await broker.revoke(c.get("owner"), z.uuid().parse(c.req.param("id"))));
  });
  return app;
}
