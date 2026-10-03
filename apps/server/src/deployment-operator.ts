import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { RuntimePauseState } from "../../../packages/domain/src/runtime.ts";
import type { ApiQuotas } from "./api-quotas.ts";
import type { Store } from "./db.ts";
import type { DeploymentMaintenance } from "./deployment-maintenance.ts";
import { deploymentStatus } from "./deployment-status.ts";
import { AppError } from "./errors.ts";

const operator = "__deployment_operator__";
const maintenanceBody = z
  .object({
    id: z.uuid(),
    operation: z.enum(["begin", "renew", "finish"]),
    ttlMs: z.number().int().min(10_000).max(120_000).optional(),
  })
  .strict();
const pauseBody = z
  .object({ paused: z.boolean(), expectedRevision: z.number().int().nonnegative() })
  .strict();
const routes = new Set([
  "GET /api/deployment/status",
  "POST /api/deployment/maintenance",
  "POST /api/agent/runtime-pause",
]);

/** Separate namespace, intercepted before public/session/executor routes. Its
 * root-held random secret never becomes an owner/device or task credential. */
export const deploymentOperatorAuthorization = (authorization?: string) =>
  authorization !== undefined && /^Bearer odb1\./i.test(authorization);

export function deploymentOperator(options: {
  db: Store;
  tokenSha256?: string;
  quotas: ApiQuotas;
  maintenance: DeploymentMaintenance;
  pause: (input: z.infer<typeof pauseBody>) => Promise<RuntimePauseState>;
}): MiddlewareHandler {
  if (options.tokenSha256 !== undefined && !/^[a-f0-9]{64}$/.test(options.tokenSha256))
    throw new Error("DEPLOYMENT_OPERATOR_TOKEN_SHA256 must be one lowercase SHA256 digest");
  const expected = options.tokenSha256 ? Buffer.from(options.tokenSha256, "hex") : undefined;
  return async (c, next) => {
    const authorization = c.req.header("authorization");
    if (!authorization || !deploymentOperatorAuthorization(authorization)) return next();
    const token = authorization.slice(7);
    if (
      !expected ||
      !/^odb1\.[A-Za-z0-9_-]{43}$/.test(token) ||
      !timingSafeEqual(expected, createHash("sha256").update(token).digest())
    )
      throw new AppError(
        "Deployment operator credential is invalid or revoked",
        401,
        "DEPLOYMENT_OPERATOR_INVALID",
      );
    const target = new URL(c.req.url);
    if (target.search || !routes.has(`${c.req.method} ${target.pathname}`))
      throw new AppError(
        "Deployment operator credential permits only exact maintenance routes",
        403,
        "DEPLOYMENT_OPERATOR_SCOPE",
      );
    const retry = options.quotas.take(
      operator,
      "root-backup",
      c.req.method === "GET" ? "observe" : "control",
    );
    if (retry) {
      c.header("Retry-After", String(retry));
      return c.json(
        { error: "Operator maintenance quota exceeded", code: "API_QUOTA_EXCEEDED" },
        429,
      );
    }
    if (target.pathname === "/api/deployment/status")
      return c.json(
        await deploymentStatus(options.db, Date.now(), () => options.maintenance.activeRequests),
      );
    return bodyLimit({
      maxSize: 4096,
      onError: (c) =>
        c.json(
          {
            error: "Operator maintenance body exceeds 4 KiB",
            code: "DEPLOYMENT_OPERATOR_BODY_TOO_LARGE",
          },
          413,
        ),
    })(c, async () => {
      if (target.pathname === "/api/deployment/maintenance") {
        const body = maintenanceBody.parse(await c.req.json());
        const value = await options.maintenance.update(
          operator,
          body.id,
          body.operation,
          body.ttlMs,
        );
        c.res = c.json({ id: value.id, active: value.active, expiresAt: value.expiresAt });
      } else c.res = c.json(await options.pause(pauseBody.parse(await c.req.json())));
    });
  };
}
