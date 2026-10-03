import { createHash } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type {
  FileRecoverySnapshot,
  FileVersionMetadata,
  NativeArtifactMetadata,
} from "../../../packages/domain/src/file-versions.ts";
import { AppError } from "./errors.ts";
import type { ExecutorDispatchContext, ExecutorRequest } from "./executors/protocol.ts";
import { executorRequestSchema, safeOperationId, sha256Schema } from "./executors/protocol.ts";
import type { ExecutorRegistry } from "./executors/registry.ts";

/** Owner-scoped recovery metadata on VPS; origin executor keeps version content.
 * Every mutation is the same authoritative operation/transport path as commands.
 */
export class FileVersions {
  constructor(
    readonly registry: ExecutorRegistry,
    readonly options: {
      retentionDays?: number;
      maxVersionBytes?: number;
      pollMs?: number;
      receiptWaitMs?: number;
      context?: (
        owner: string,
        requestId: string,
        request?: ExecutorRequest,
      ) => Promise<ExecutorDispatchContext | undefined>;
      manualContext?: (
        owner: string,
        requestId: string,
        request?: ExecutorRequest,
      ) => Promise<ExecutorDispatchContext>;
    } = {},
  ) {}
  async list(owner: string, artifactId?: string): Promise<FileRecoverySnapshot> {
    const versions = await this.registry.db.list<FileVersionMetadata>(owner, "file-versions");
    const artifacts = await this.registry.db.list<NativeArtifactMetadata>(
      owner,
      "native-artifacts",
    );
    return {
      versions: versions.filter((value) => !artifactId || value.artifactId === artifactId),
      artifacts: artifacts.filter((value) => !artifactId || value.artifactId === artifactId),
      policy: {
        retentionDays: this.options.retentionDays ?? 30,
        maxVersionBytes: this.options.maxVersionBytes ?? 2 * 1024 ** 3,
        scope: "controlled-tools",
        backupRequired: true,
      },
    };
  }
  private async artifact(owner: string, id: string) {
    safeOperationId.parse(id);
    const artifact = await this.registry.db.get<NativeArtifactMetadata>(
      owner,
      "native-artifacts",
      id,
    );
    if (!artifact) throw new AppError("Native artifact not found", 404);
    if (this.registry.registration(artifact.executorId).owner !== owner)
      throw new AppError("Native artifact origin owner does not match", 403);
    return artifact;
  }
  private async effect(
    owner: string,
    executorId: string,
    args: Record<string, unknown>,
    requestId: string,
    context?: ExecutorDispatchContext,
  ) {
    safeOperationId.parse(requestId);
    const id = createHash("sha256").update(`${owner}:file-version:${requestId}`).digest("hex");
    const request = executorRequestSchema.parse({
      id,
      executorId,
      kind: "file-version",
      capability: "files",
      capabilityVersion: 1,
      args,
    });
    const trusted =
      (await this.options.context?.(owner, requestId, request)) ??
      context ??
      (await this.options.manualContext?.(owner, requestId, request));
    if (!trusted)
      throw new AppError(
        "Recovery requires trusted task context or authenticated manual-operation authorization",
        503,
      );
    const operation = await this.registry.enqueue(owner, request, trusted);
    const deadline = Date.now() + (this.options.receiptWaitMs ?? 30000);
    while (Date.now() < deadline) {
      const delivery = await this.registry.delivery(owner, operation.id);
      const receipt = delivery?.receipt;
      if (receipt && receipt.status !== "running") {
        if (receipt.status !== "succeeded")
          throw new AppError(
            receipt.message ??
              "Recovery effect is uncertain; inspect origin files before repeating",
            503,
          );
        const data = receipt.data ?? {};
        if (args.operation === "restore") {
          const conflict = await this.registry.publicationConflict(owner, executorId, data);
          if (conflict)
            throw new AppError(
              `Origin artifact publication conflicted: ${conflict.reason}; inspect the current file`,
              503,
            );
          const artifact = await this.registry.db.get<NativeArtifactMetadata>(
            owner,
            "native-artifacts",
            String(data.artifactId),
          );
          // Never announce a staged file as a completed artifact before the
          // origin hash/version publication has received its durable ACK.
          if (
            artifact?.published &&
            artifact.version === data.version &&
            artifact.sha256 === data.sha256 &&
            (artifact.generation ?? 1) === (data.generation ?? 1) &&
            artifact.versionId === data.versionId
          )
            return { ...data, published: true };
        } else {
          const version = z
            .object({
              id: safeOperationId,
              artifactId: safeOperationId,
              path: z.string(),
              sha256: sha256Schema,
              size: z.number().int().nonnegative(),
              createdAt: z.number(),
              taskId: z.string().nullable().optional(),
              trashed: z.boolean(),
              retentionDays: z.number().int().positive(),
            })
            .parse(data);
          if (version.artifactId !== args.artifactId || version.sha256 !== args.expectedVersion)
            throw new AppError("Recovery metadata binding does not match artifact/version", 502);
          await this.registry.db.insertIfAbsent(owner, "file-versions", { ...version, executorId });
          if (args.operation === "trash")
            await this.registry.db.compareAndSwap(
              owner,
              "native-artifacts",
              String(args.artifactId),
              { version: args.expectedVersion },
              { trashed: true, version: null },
            );
          return data;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 100));
    }
    throw new AppError(
      "Origin recovery receipt/publication is pending or offline; no effect was repeated",
      503,
    );
  }
  async capture(
    owner: string,
    taskId: string,
    artifactId: string,
    expectedVersion: string,
    requestId: string,
    context?: ExecutorDispatchContext,
  ) {
    const artifact = await this.artifact(owner, artifactId);
    sha256Schema.parse(expectedVersion);
    safeOperationId.parse(taskId);
    return this.effect(
      owner,
      artifact.executorId,
      { operation: "capture", artifactId, expectedVersion, taskId },
      requestId,
      context,
    );
  }
  async trash(
    owner: string,
    taskId: string,
    artifactId: string,
    expectedVersion: string,
    requestId: string,
    context?: ExecutorDispatchContext,
  ) {
    const artifact = await this.artifact(owner, artifactId);
    sha256Schema.parse(expectedVersion);
    safeOperationId.parse(taskId);
    return this.effect(
      owner,
      artifact.executorId,
      { operation: "trash", artifactId, expectedVersion, taskId },
      requestId,
      context,
    );
  }
  async restore(
    owner: string,
    versionId: string,
    expectedCurrentVersion: string | null,
    requestId: string,
    context?: ExecutorDispatchContext,
  ) {
    safeOperationId.parse(versionId);
    sha256Schema.nullable().parse(expectedCurrentVersion);
    const version = await this.registry.db.get<FileVersionMetadata>(
      owner,
      "file-versions",
      versionId,
    );
    if (!version) throw new AppError("Recovery version not found", 404);
    await this.artifact(owner, version.artifactId);
    return this.effect(
      owner,
      version.executorId,
      { operation: "restore", versionId, expectedCurrentVersion },
      requestId,
      context,
    );
  }
}

export function fileVersionRoutes(versions?: FileVersions) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/", async (c) =>
    c.json(
      versions
        ? await versions.list(c.get("owner"), c.req.query("artifactId"))
        : {
            versions: [],
            artifacts: [],
            policy: {
              retentionDays: 30,
              maxVersionBytes: 2 * 1024 ** 3,
              scope: "controlled-tools",
              backupRequired: true,
            },
            available: false,
          },
    ),
  );
  const mutation = z.object({
    artifactId: safeOperationId,
    expectedVersion: sha256Schema,
    requestId: safeOperationId,
  });
  for (const action of ["capture", "trash"] as const)
    app.post(`/${action}`, async (c) => {
      if (!versions) throw new AppError("Native file recovery is unavailable", 503);
      const input = mutation.parse(await c.req.json());
      return c.json(
        await versions[action](
          c.get("owner"),
          "manual",
          input.artifactId,
          input.expectedVersion,
          input.requestId,
        ),
      );
    });
  app.post("/restore", async (c) => {
    if (!versions) throw new AppError("Native file recovery is unavailable", 503);
    const input = z
      .object({
        versionId: safeOperationId,
        expectedCurrentVersion: sha256Schema.nullable(),
        requestId: safeOperationId,
      })
      .parse(await c.req.json());
    return c.json(
      await versions.restore(
        c.get("owner"),
        input.versionId,
        input.expectedCurrentVersion,
        input.requestId,
      ),
    );
  });
  return app;
}
