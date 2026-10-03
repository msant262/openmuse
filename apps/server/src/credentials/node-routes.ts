import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../errors.ts";
import type { ExecutorOperation } from "../executors/protocol.ts";
import type { CredentialGrantBroker } from "./grants.ts";

export type CredentialNodeRegistry = {
  authenticate(executorId: string, authorization?: string): void;
  registration(executorId: string): { owner: string };
  node(executorId: string): Promise<{
    epoch: number;
    connected: boolean;
    reconciled: boolean;
  } | null>;
  delivery(
    owner: string,
    id: string,
  ): Promise<{
    id: string;
    owner: string;
    state: "queued" | "claimed" | "settled";
    operation: ExecutorOperation;
    receipt?: unknown;
  } | null>;
  validateDispatch(owner: string, operation: ExecutorOperation): Promise<unknown>;
};

const bodySchema = z
  .object({
    epoch: z.number().int().positive(),
    operationId: z.string().min(1).max(128),
    sessionId: z.uuid(),
    desktopSessionId: z.uuid(),
    sessionGeneration: z.uuid(),
    origin: z.url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
    }),
    challengeId: z.uuid().optional(),
  })
  .strict();

/** Node-only one-use secret route. It is mounted under /executor, before user auth. */
export function credentialNodeRoutes(
  registry: CredentialNodeRegistry,
  grants: CredentialGrantBroker,
) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof z.ZodError)
      return c.json({ error: "Invalid credential transfer scope" }, 422);
    if (error instanceof AppError) return c.json({ error: error.message }, error.status);
    return c.json({ error: "Credential transfer failed" }, 503);
  });
  app.post("/:executorId/credential-grants/:grantId/consume", async (c) => {
    const executorId = z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
      .parse(c.req.param("executorId"));
    const grantId = z.uuid().parse(c.req.param("grantId"));
    registry.authenticate(executorId, c.req.header("authorization"));
    const body = bodySchema.parse(await c.req.json());
    const registration = registry.registration(executorId);

    const validateClaimedOperation = async () => {
      const node = await registry.node(executorId);
      if (!node || !node.connected || !node.reconciled || node.epoch !== body.epoch)
        throw new AppError("The registered executor session is stale", 409);
      const delivery = await registry.delivery(registration.owner, body.operationId);
      if (
        !delivery ||
        delivery.id !== body.operationId ||
        delivery.owner !== registration.owner ||
        delivery.state !== "claimed" ||
        delivery.receipt
      )
        throw new AppError("Credential grant is not bound to this claimed browser operation", 403);
      const operation = delivery.operation;
      const requestBody = operation.args.body as Record<string, unknown> | undefined;
      if (
        operation.executorId !== executorId ||
        operation.kind !== "browser" ||
        operation.capability !== "browser.dom" ||
        operation.executorEpoch !== body.epoch ||
        Date.parse(operation.expiresAt) <= Date.now() ||
        operation.args.operation !== "credentials" ||
        operation.args.sessionId !== body.desktopSessionId ||
        operation.args.sessionGeneration !== body.sessionGeneration ||
        operation.args.browserSessionId !== body.sessionId ||
        requestBody?.grantId !== grantId ||
        requestBody.origin !== body.origin ||
        requestBody.challengeId !== body.challengeId ||
        typeof requestBody.adapterId !== "string"
      )
        throw new AppError("Credential grant is not bound to this claimed browser operation", 403);

      // Recheck M4's current task revision, pause, lease, resource fence,
      // session generation and revocation state at each secret boundary.
      await registry.validateDispatch(registration.owner, operation);
      const [currentNode, currentDelivery] = await Promise.all([
        registry.node(executorId),
        registry.delivery(registration.owner, body.operationId),
      ]);
      if (
        !currentNode ||
        !currentNode.connected ||
        !currentNode.reconciled ||
        currentNode.epoch !== body.epoch ||
        !currentDelivery ||
        currentDelivery.id !== delivery.id ||
        currentDelivery.owner !== registration.owner ||
        currentDelivery.state !== "claimed" ||
        currentDelivery.receipt ||
        currentDelivery.operation.bindingHash !== operation.bindingHash ||
        currentDelivery.operation.resourceFence !== operation.resourceFence ||
        Date.parse(currentDelivery.operation.expiresAt) <= Date.now()
      )
        throw new AppError("Credential operation authority changed during validation", 409);
      return { delivery: currentDelivery, operation: currentDelivery.operation, requestBody };
    };

    const current = await validateClaimedOperation();
    const fields = await grants.consume(registration.owner, grantId, {
      operationId: current.delivery.id,
      bindingHash: current.operation.bindingHash,
      resourceFence: current.operation.resourceFence,
      executorId,
      executorEpoch: body.epoch,
      taskId: current.operation.taskId,
      revision: current.operation.revision,
      sessionId: body.sessionId,
      desktopSessionId: body.desktopSessionId,
      sessionGeneration: body.sessionGeneration,
      origin: body.origin,
      adapterId: current.requestBody.adapterId as string,
      ...(body.challengeId ? { challengeId: body.challengeId } : {}),
    });
    try {
      const afterRead = await validateClaimedOperation();
      if (
        afterRead.delivery.id !== current.delivery.id ||
        afterRead.operation.bindingHash !== current.operation.bindingHash ||
        afterRead.operation.resourceFence !== current.operation.resourceFence
      )
        throw new AppError("Credential operation authority changed during vault read", 409);
    } catch (error) {
      // Erase the in-memory copy before returning any authority error. The
      // one-use grant stays spent and the caller must request a fresh one.
      for (const field of fields.fields) field.value = "";
      throw error;
    }
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    return c.json(fields);
  });
  return app;
}
