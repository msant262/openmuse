import { Hono } from "hono";
import { z } from "zod";
import { computerCommandSchema, computerPathSchema, computerWriteSchema } from "./computer.ts";
import { type ComputerBackend, mediaSchema } from "./computer-contract.ts";
import { AppError } from "./errors.ts";
import type { Files } from "./files.ts";

export function computerRoutes(computer: ComputerBackend, files: Files) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/", async (c) => c.json(await computer.snapshot(c.get("owner"))));
  app.post("/start", async (c) => c.json(await computer.start(c.get("owner"))));
  app.post("/stop", async (c) => c.json(await computer.stop(c.get("owner"))));
  app.post("/commands", async (c) =>
    c.json(
      await computer.execute(c.get("owner"), computerCommandSchema.parse(await c.req.json()), {
        signal: c.req.raw.signal,
      }),
    ),
  );
  app.get("/files", async (c) => c.json(await computer.list(c.get("owner"), c.req.query("path"))));
  app.get("/commands/:id", async (c) => {
    if (!computer.command) throw new AppError("Job status requires the open RPC computer", 422);
    return c.json(await computer.command(c.get("owner"), c.req.param("id")));
  });
  app.post("/commands/:id/cancel", async (c) => {
    if (!computer.cancel)
      throw new AppError("Job cancellation requires the open RPC computer", 422);
    return c.json(await computer.cancel(c.get("owner"), c.req.param("id")));
  });
  for (const kind of ["transcribe", "preview"] as const)
    app.post(`/${kind}`, async (c) => {
      if (!computer.media)
        throw new AppError("Media processing requires the open RPC computer", 422);
      return c.json(
        await computer.media(c.get("owner"), kind, mediaSchema.parse(await c.req.json()), {
          signal: c.req.raw.signal,
        }),
      );
    });
  app.post("/files/read", async (c) => {
    const { path } = computerPathSchema.parse(await c.req.json());
    return c.json(await computer.read(c.get("owner"), path));
  });
  app.post("/files/write", async (c) => {
    const { path, text } = computerWriteSchema.parse(await c.req.json());
    return c.json(await computer.write(c.get("owner"), path, text));
  });
  app.post("/files/mkdir", async (c) => {
    const { path } = computerPathSchema.parse(await c.req.json());
    return c.json(await computer.mkdir(c.get("owner"), path));
  });
  app.post("/files/import", async (c) => {
    const { path, fileId } = computerPathSchema
      .extend({ fileId: z.string().min(1) })
      .parse(await c.req.json());
    return c.json(
      await computer.writeBytes(c.get("owner"), path, await files.bytes(c.get("owner"), fileId)),
    );
  });
  app.post("/files/export", async (c) => {
    const { path } = computerPathSchema.parse(await c.req.json());
    const { name, bytes } = await computer.fileBytes(c.get("owner"), path);
    return c.json(
      await files.importAttachment(c.get("owner"), name, bytes, `Computer: ${path}`),
      201,
    );
  });
  return app;
}
