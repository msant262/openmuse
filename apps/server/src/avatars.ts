import { createHash } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { rasterMime } from "../../../packages/domain/src/attachments.ts";
import {
  type AvatarAsset,
  type AvatarGeneration,
  type AvatarMedia,
  type AvatarMotion,
  type AvatarStudioState,
  avatarGenerationInput,
  avatarImportInput,
  avatarMotions,
  avatarRequestId,
  avatarRetryInput,
  avatarSelectionInput,
  type BuiltinCompanion,
  builtinCompanionSchema,
} from "../../../packages/domain/src/avatar-character.ts";
import { ActionLog } from "./action-log.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { DeploymentMaintenance } from "./deployment-maintenance.ts";
import { RuntimePause } from "./engine/runtime-pause.ts";
import { WorkAdmission } from "./engine/work-admission.ts";
import { AppError } from "./errors.ts";
import type { Files } from "./files.ts";
import { backgroundFailure } from "./log.ts";
import {
  type AvatarMediaProvider,
  avatarVideoMime,
  type GeneratedAvatarMedia,
  GrokAvatarProvider,
} from "./providers/avatar-media.ts";
import { ModelProviderError } from "./providers/errors.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = () => new Date().toISOString();
type GenerationRecord = Omit<AvatarGeneration, "candidates" | "retryable" | "completedMotions"> & {
  binding: string;
  revision: number;
  attempt: number;
  leaseUntil: number;
  dispatching: boolean;
  providerRequestId: string | null;
  currentMotion: AvatarMotion | null;
  workingPosterFileId: string | null;
  pollAt: number;
};

/** Durable owner-scoped media jobs. Unknown POST outcomes are never replayed automatically. */
export class AvatarService {
  private timer?: ReturnType<typeof setInterval>;
  private processing?: Promise<void>;
  private abort = new AbortController();
  private stopping = false;
  readonly provider: AvatarMediaProvider;
  constructor(
    readonly db: Store,
    readonly files: Files,
    readonly config: Config,
    provider?: AvatarMediaProvider,
  ) {
    this.provider = provider ?? new GrokAvatarProvider(config);
  }
  start() {
    if (this.timer) return;
    this.stopping = false;
    this.abort = new AbortController();
    const tick = () => {
      void this.tick().catch((error) => backgroundFailure("avatar generation", error));
    };
    tick();
    this.timer = setInterval(tick, 2000);
  }
  async close() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.abort.abort();
    await this.processing;
  }
  private async record(owner: string, id: string) {
    const job = await this.db.get<GenerationRecord>(owner, "avatar-generations", id);
    if (!job) throw new AppError("Geração de personagem não encontrada", 404);
    return job;
  }
  async asset(owner: string, id: string): Promise<AvatarAsset> {
    const asset = await this.db.get<AvatarAsset>(owner, "avatar-assets", id);
    if (!asset) throw new AppError("Personagem não encontrado", 404);
    return asset;
  }
  async decorate(owner: string, asset: AvatarAsset): Promise<AvatarAsset> {
    const media = async (value: AvatarMedia): Promise<AvatarMedia> => ({
      ...value,
      url: this.files.signed(owner, await this.files.get(owner, value.fileId)).url,
      ...(value.posterFileId && {
        posterUrl: this.files.signed(owner, await this.files.get(owner, value.posterFileId)).url,
      }),
    });
    return {
      ...asset,
      poster: await media(asset.poster),
      motions: Object.fromEntries(
        await Promise.all(
          Object.entries(asset.motions).map(async ([key, value]) => [key, await media(value)]),
        ),
      ),
    };
  }
  async generation(owner: string, id: string): Promise<AvatarGeneration> {
    const job = await this.record(owner, id);
    const candidates = await Promise.all(
      job.candidateIds.map(async (assetId) =>
        this.decorate(owner, await this.asset(owner, assetId)),
      ),
    );
    const selected = candidates.find((asset) => asset.id === job.selectedAssetId);
    return {
      id: job.id,
      prompt: job.prompt,
      label: job.label,
      status: job.status,
      phase: job.phase,
      candidateIds: job.candidateIds,
      candidates,
      ...(job.selectedAssetId && { selectedAssetId: job.selectedAssetId }),
      completedMotions: avatarMotions.filter((motion) => Boolean(selected?.motions[motion])),
      ...(job.error && { error: job.error }),
      retryable: ["failed", "uncertain"].includes(job.status),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }
  async state(owner: string): Promise<AvatarStudioState> {
    const identity = await this.db.get<{
      avatarAssetId?: string;
      builtinCompanion?: BuiltinCompanion;
    }>(owner, "agent-settings", "identity");
    const assets = await this.db.list<AvatarAsset>(owner, "avatar-assets");
    const jobs = await this.db.list<GenerationRecord>(owner, "avatar-generations");
    return {
      capabilities: await this.provider.capabilities(),
      builtinCompanion: identity?.builtinCompanion ?? "okami",
      assets: await Promise.all(assets.map((asset) => this.decorate(owner, asset))),
      generations: await Promise.all(
        jobs.slice(0, 30).map((job) => this.generation(owner, job.id)),
      ),
      ...(identity?.avatarAssetId && { activeAssetId: identity.avatarAssetId }),
    };
  }
  async create(owner: string, raw: unknown): Promise<AvatarGeneration> {
    const input = avatarGenerationInput.parse(raw);
    const id = hash(["avatar", input.requestId]);
    const binding = hash({ prompt: input.prompt, label: input.label });
    const old = await this.db.get<GenerationRecord>(owner, "avatar-generations", id);
    if (old) {
      if (old.binding !== binding)
        throw new AppError("Este pedido já pertence a outra descrição", 409);
      return this.generation(owner, id);
    }
    const capability = await this.provider.capabilities();
    if (!capability.images) throw new AppError(capability.reason ?? "Geração indisponível", 503);
    await this.assertDispatch(owner);
    const timestamp = now();
    const job: GenerationRecord = {
      id,
      binding,
      label: input.label ?? "Meu personagem",
      prompt: input.prompt,
      status: "queued",
      phase: "images",
      candidateIds: [],
      revision: 0,
      attempt: 0,
      leaseUntil: 0,
      dispatching: false,
      providerRequestId: null,
      currentMotion: null,
      workingPosterFileId: null,
      pollAt: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (!(await this.db.insertIfAbsent(owner, "avatar-generations", job)))
      return this.create(owner, raw);
    return this.generation(owner, id);
  }
  private async mutation(
    owner: string,
    requestId: string,
    binding: unknown,
    mutations: Parameters<Store["durableMutation"]>[3],
  ) {
    const result = await this.db.durableMutation(
      owner,
      `avatar:${requestId}`,
      hash(binding),
      mutations,
    );
    if (!["applied", "duplicate"].includes(result.status))
      throw new AppError(
        "O personagem mudou ou o pedido já foi usado. Atualize e tente novamente.",
        409,
      );
    return result;
  }
  async selectExisting(owner: string, id: string, requestId: string) {
    avatarRequestId.parse(requestId);
    const asset = await this.asset(owner, id);
    await this.db.insertIfAbsent(owner, "agent-settings", {
      id: "identity",
      name: "Okami",
      tone: "warm",
    });
    await this.mutation(owner, requestId, { kind: "select", id }, [
      { kind: "agent-settings", id: "identity", mode: "merge", value: { avatarAssetId: id } },
    ]);
    return this.decorate(owner, asset);
  }
  async selectDefault(owner: string, requestId: string, companion: BuiltinCompanion = "okami") {
    builtinCompanionSchema.parse(companion);
    avatarRequestId.parse(requestId);
    await this.db.insertIfAbsent(owner, "agent-settings", {
      id: "identity",
      name: "Okami",
      tone: "warm",
    });
    await this.mutation(
      owner,
      requestId,
      companion === "okami" ? { kind: "default" } : { kind: "default", companion },
      [
        {
          kind: "agent-settings",
          id: "identity",
          mode: "merge",
          value: { avatarAssetId: null, builtinCompanion: companion },
        },
      ],
    );
    return { selected: true };
  }
  async select(owner: string, id: string, raw: unknown) {
    const input = avatarSelectionInput.parse(raw);
    const job = await this.record(owner, id);
    if (job.selectedAssetId === input.assetId && job.phase !== "selection")
      return this.generation(owner, id);
    if (job.status !== "awaiting_selection" || !job.candidateIds.includes(input.assetId))
      throw new AppError("Escolha uma opção desta geração", 409);
    const asset = await this.asset(owner, input.assetId);
    const capability = await this.provider.capabilities();
    if (!capability.videos)
      throw new AppError(capability.reason ?? "Geração de vídeos indisponível", 503);
    await this.assertDispatch(owner);
    await this.db.insertIfAbsent(owner, "agent-settings", {
      id: "identity",
      name: "Okami",
      tone: "warm",
    });
    await this.mutation(owner, input.requestId, { kind: "animate", id, assetId: input.assetId }, [
      {
        kind: "avatar-generations",
        id,
        mode: "merge",
        expected: { revision: job.revision, status: "awaiting_selection" },
        value: {
          selectedAssetId: input.assetId,
          phase: "videos",
          status: "queued",
          revision: job.revision + 1,
          updatedAt: now(),
        },
      },
      {
        kind: "avatar-assets",
        id: asset.id,
        mode: "merge",
        value: { status: "animating", updatedAt: now() },
      },
      { kind: "agent-settings", id: "identity", mode: "merge", value: { avatarAssetId: asset.id } },
    ]);
    return this.generation(owner, id);
  }
  async retry(owner: string, id: string, raw: unknown) {
    const input = avatarRetryInput.parse(raw);
    const job = await this.record(owner, id);
    const receipt = await this.db.get<{ bindingHash: string }>(
      owner,
      "mutation-receipts",
      `avatar:${input.requestId}`,
    );
    if (receipt) {
      if (receipt.bindingHash !== hash({ kind: "retry", id }))
        throw new AppError("Este pedido já foi usado em outra ação", 409);
      return this.generation(owner, id);
    }
    if (!["failed", "uncertain"].includes(job.status))
      throw new AppError("Esta geração não precisa ser repetida", 409);
    if (job.status === "uncertain" && !input.acknowledgeUncertain)
      throw new AppError(
        "Não foi possível confirmar o pedido anterior. Uma nova tentativa pode consumir a cota novamente; confirme para continuar.",
        409,
        "AVATAR_OUTCOME_UNKNOWN",
      );
    const capability = await this.provider.capabilities();
    if (!capability.images || (job.phase === "videos" && !capability.videos))
      throw new AppError(capability.reason ?? "Geração indisponível", 503);
    await this.assertDispatch(owner);
    const changes: Parameters<Store["durableMutation"]>[3] = [
      {
        kind: "avatar-generations",
        id,
        mode: "merge",
        expected: { revision: job.revision },
        value: {
          revision: job.revision + 1,
          attempt: job.attempt + 1,
          status: "queued",
          dispatching: false,
          leaseUntil: 0,
          providerRequestId: job.providerRequestId,
          pollAt: 0,
          error: null,
          updatedAt: now(),
        },
      },
    ];
    if (job.selectedAssetId)
      changes.push({
        kind: "avatar-assets",
        id: job.selectedAssetId,
        mode: "merge",
        value: { status: "animating", updatedAt: now() },
      });
    await this.mutation(owner, input.requestId, { kind: "retry", id }, changes);
    return this.generation(owner, id);
  }
  async import(owner: string, raw: unknown) {
    const input = avatarImportInput.parse(raw);
    const id = hash(["avatar-import", input.requestId]);
    const poster = await this.validateMedia(owner, input.posterFileId, false);
    const motions: AvatarAsset["motions"] = {};
    for (const motion of avatarMotions)
      if (input.motions?.[motion])
        motions[motion] = await this.validateMedia(owner, input.motions[motion], true);
    const asset: AvatarAsset = {
      id,
      version: 1,
      source: "upload",
      label: input.label,
      status: avatarMotions.every((motion) => motions[motion]) ? "ready" : "still",
      poster,
      motions,
      createdAt: now(),
      updatedAt: now(),
    };
    await this.mutation(owner, input.requestId, { kind: "import", ...input }, [
      { kind: "avatar-assets", id, mode: "insert", value: { ...asset } },
    ]);
    return this.decorate(owner, await this.asset(owner, id));
  }
  private async validateMedia(owner: string, id: string, video: boolean): Promise<AvatarMedia> {
    const file = await this.files.get(owner, id);
    const bytes = await this.files.bytes(owner, id);
    const mime = video ? avatarVideoMime(bytes) : rasterMime(bytes);
    if (!mime || mime !== file.mimeType || (!video && bytes.length > 8 * 1024 * 1024))
      throw new AppError(
        video
          ? "Escolha um vídeo MP4 ou WebM válido"
          : "Escolha uma imagem PNG, JPEG ou WebP de até 8 MB",
        422,
      );
    return { fileId: id, mimeType: mime };
  }
  private async assertDispatch(owner: string) {
    await new RuntimePause(this.db).assertResumed(owner);
    if (await new DeploymentMaintenance(this.db).current())
      throw new AppError("A manutenção está aguardando a conclusão dos trabalhos", 503);
    if (this.stopping) throw new AppError("O servidor está reiniciando. Tente novamente.", 503);
  }
  tick(): Promise<void> {
    if (this.processing) return this.processing;
    const work = this.runTick();
    this.processing = work;
    return work.finally(() => {
      if (this.processing === work) this.processing = undefined;
    });
  }
  private async runTick() {
    if (this.stopping) return;
    const draining =
      (await new RuntimePause(this.db).get("__runtime__")).paused ||
      Boolean(await new DeploymentMaintenance(this.db).current());
    for (const { owner, value } of await this.db.scan<GenerationRecord>("avatar-generations")) {
      if (
        !["queued", "running"].includes(value.status) ||
        value.pollAt > Date.now() ||
        value.leaseUntil > Date.now()
      )
        continue;
      const reconciling = Boolean(value.providerRequestId || value.dispatching);
      if (draining && !reconciling) continue;
      const admission = new WorkAdmission(this.db, { leaseMs: 240000 });
      const admissionId = `avatar:${hash([owner, value.id])}`;
      if (!reconciling && !(await admission.claim(admissionId, "background", admissionId)))
        continue;
      try {
        const job = await this.db.compareAndSwap<GenerationRecord>(
          owner,
          "avatar-generations",
          value.id,
          { revision: value.revision, leaseUntil: value.leaseUntil },
          {
            revision: value.revision + 1,
            leaseUntil: Date.now() + 240000,
            status: "running",
            updatedAt: now(),
          },
        );
        if (!job) continue;
        if (job.dispatching && !job.providerRequestId) {
          await this.fail(
            owner,
            job,
            "uncertain",
            "A geração foi interrompida após o envio. Não repetimos o pedido para evitar consumir sua cota duas vezes.",
          );
        } else {
          await this.process(owner, job);
        }
        return;
      } finally {
        if (!reconciling) await admission.release(admissionId);
      }
    }
  }
  private async patch(owner: string, job: GenerationRecord, patch: Record<string, unknown>) {
    const updated = await this.db.compareAndSwap<GenerationRecord>(
      owner,
      "avatar-generations",
      job.id,
      { revision: job.revision },
      { ...patch, revision: job.revision + 1, updatedAt: now() },
    );
    if (!updated) throw new AppError("A geração mudou durante o processamento", 409);
    Object.assign(job, updated);
  }
  private async saveMedia(
    owner: string,
    job: GenerationRecord,
    key: string,
    media: GeneratedAvatarMedia,
  ): Promise<AvatarMedia> {
    const extension = media.mimeType === "image/jpeg" ? "jpg" : media.mimeType.split("/")[1];
    const file = await this.files.importAttachment(
      owner,
      `avatar-${key}.${extension}`,
      media.bytes,
      "Personagem criado por você",
      media.mimeType,
      `avatar:${job.id}:${job.attempt}:${key}`,
    );
    return {
      fileId: file.id,
      mimeType: file.mimeType,
      ...(media.durationMs && { durationMs: media.durationMs }),
    };
  }
  private async reference(owner: string, fileId: string): Promise<GeneratedAvatarMedia> {
    const file = await this.files.get(owner, fileId);
    return { bytes: await this.files.bytes(owner, fileId), mimeType: file.mimeType };
  }
  private async fail(
    owner: string,
    job: GenerationRecord,
    status: "failed" | "uncertain",
    error: string,
  ) {
    await this.patch(owner, job, { status, error, leaseUntil: 0 });
    if (job.selectedAssetId)
      await this.db.compareAndSwap(
        owner,
        "avatar-assets",
        job.selectedAssetId,
        {},
        { status: "failed", updatedAt: now() },
      );
  }
  private async process(owner: string, job: GenerationRecord) {
    let effect = false;
    const audit = {
      operationId: `avatar:${job.id}:${job.attempt}:${job.revision}`,
      tool: "generate_avatar",
      target: "Grok Imagine",
      summary: "Solicitar criação de personagem ou animação",
    };
    try {
      if (job.phase === "images") {
        await this.assertDispatch(owner);
        await this.patch(owner, job, { dispatching: true });
        await new ActionLog(this.db).append(owner, audit, "started");
        effect = true;
        const images = await this.provider.images(job.prompt, this.abort.signal);
        if (images.length !== 4) throw new Error("Expected four generated candidates");
        const ids: string[] = [];
        for (let i = 0; i < images.length; i++) {
          const poster = await this.saveMedia(owner, job, `candidate-${i}`, images[i]);
          const asset: AvatarAsset = {
            id: hash([job.id, job.attempt, i]),
            version: 1,
            label: job.label,
            prompt: job.prompt,
            source: "generated",
            status: "still",
            poster,
            motions: {},
            generationId: job.id,
            createdAt: now(),
            updatedAt: now(),
          };
          await this.db.insertIfAbsent(owner, "avatar-assets", asset);
          ids.push(asset.id);
        }
        await this.patch(owner, job, {
          status: "awaiting_selection",
          phase: "selection",
          candidateIds: ids,
          dispatching: false,
          leaseUntil: 0,
        });
        await new ActionLog(this.db).finish(owner, audit, "succeeded");
        return;
      }
      if (!job.selectedAssetId) throw new Error("Missing selected character");
      const asset = await this.asset(owner, job.selectedAssetId);
      const motion = job.currentMotion ?? avatarMotions.find((name) => !asset.motions[name]);
      if (!motion) {
        await this.db.compareAndSwap(
          owner,
          "avatar-assets",
          asset.id,
          {},
          { status: "ready", updatedAt: now() },
        );
        await this.patch(owner, job, {
          status: "succeeded",
          phase: "complete",
          leaseUntil: 0,
          dispatching: false,
        });
        return;
      }
      if (job.providerRequestId) {
        // A GET/download failure can resume the same provider receipt without a new charge.
        const result = await this.provider.video(job.providerRequestId, this.abort.signal);
        if (result.status === "pending") {
          await this.patch(owner, job, { leaseUntil: 0, pollAt: Date.now() + 5000 });
          return;
        }
        if (result.status === "failed") {
          await this.patch(owner, job, { providerRequestId: null });
          await this.fail(owner, job, "failed", result.error);
          return;
        }
        const media = await this.saveMedia(owner, job, motion, result.media);
        media.posterFileId =
          motion === "working"
            ? (job.workingPosterFileId ?? asset.poster.fileId)
            : asset.poster.fileId;
        const motions = { ...asset.motions, [motion]: media };
        const complete = avatarMotions.every((name) => motions[name]);
        await this.db.compareAndSwap(
          owner,
          "avatar-assets",
          asset.id,
          {},
          { motions, status: complete ? "ready" : "animating", updatedAt: now() },
        );
        await this.patch(owner, job, {
          leaseUntil: 0,
          pollAt: 0,
          providerRequestId: null,
          currentMotion: null,
          dispatching: false,
          error: null,
          ...(complete && { status: "succeeded", phase: "complete" }),
        });
        return;
      }
      await this.assertDispatch(owner);
      await this.patch(owner, job, { currentMotion: motion, dispatching: true });
      await new ActionLog(this.db).append(owner, audit, "started");
      effect = true;
      if (motion === "working" && !job.workingPosterFileId) {
        const poster = await this.provider.workingPoster(
          await this.reference(owner, asset.poster.fileId),
          this.abort.signal,
        );
        const media = await this.saveMedia(owner, job, "working-poster", poster);
        await this.patch(owner, job, {
          workingPosterFileId: media.fileId,
          dispatching: false,
          leaseUntil: 0,
        });
      } else {
        const posterFileId =
          motion === "working"
            ? (job.workingPosterFileId ?? asset.poster.fileId)
            : asset.poster.fileId;
        const requestId = await this.provider.submitVideo(
          await this.reference(owner, posterFileId),
          motion,
          this.abort.signal,
        );
        await this.patch(owner, job, {
          providerRequestId: requestId,
          dispatching: false,
          leaseUntil: 0,
          pollAt: Date.now() + 5000,
        });
      }
      await new ActionLog(this.db).finish(owner, audit, "succeeded");
    } catch (error) {
      if (job.providerRequestId && !effect) {
        if (
          error instanceof ModelProviderError &&
          ([401, 403].includes(error.status ?? 0) ||
            ["credentials_missing", "credentials_invalid", "invalid_grant"].includes(error.code))
        ) {
          await this.fail(owner, job, "failed", error.message);
          return;
        }
        await this.patch(owner, job, {
          leaseUntil: 0,
          pollAt: Date.now() + 30000,
          error:
            "A animação ainda está sendo consultada. Seu pedido foi preservado; nenhum vídeo será gerado novamente.",
        });
        return;
      }
      const rejected =
        error instanceof ModelProviderError &&
        (error.status
          ? error.status >= 400 && error.status < 500 && error.status !== 408
          : ["credentials_missing", "credentials_invalid", "invalid_grant"].includes(error.code));
      const status = effect && !rejected ? "uncertain" : "failed";
      await this.fail(
        owner,
        job,
        status,
        error instanceof ModelProviderError
          ? error.message
          : status === "uncertain"
            ? "Não foi possível confirmar o resultado da geração. Seu pedido não será repetido automaticamente."
            : "Não foi possível iniciar esta geração. Tente novamente.",
      );
      if (effect)
        await new ActionLog(this.db).finish(
          owner,
          audit,
          status === "uncertain" ? "outcome_unknown" : "failed",
        );
    }
  }
}

export function avatarRoutes(service: AvatarService) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.post("/default/select", async (c) => {
    const input = z
      .object({ requestId: avatarRequestId, companion: builtinCompanionSchema.optional() })
      .strict()
      .parse(await c.req.json());
    return c.json(await service.selectDefault(c.get("owner"), input.requestId, input.companion));
  });
  app.get("/", async (c) => c.json(await service.state(c.get("owner"))));
  app.post("/generations", async (c) =>
    c.json(await service.create(c.get("owner"), await c.req.json()), 202),
  );
  app.get("/generations/:id", async (c) =>
    c.json(await service.generation(c.get("owner"), c.req.param("id"))),
  );
  app.post("/generations/:id/select", async (c) =>
    c.json(await service.select(c.get("owner"), c.req.param("id"), await c.req.json()), 202),
  );
  app.post("/generations/:id/retry", async (c) =>
    c.json(await service.retry(c.get("owner"), c.req.param("id"), await c.req.json()), 202),
  );
  app.post("/import", async (c) =>
    c.json(await service.import(c.get("owner"), await c.req.json()), 201),
  );
  app.post("/:id/select", async (c) => {
    const input = z
      .object({ requestId: avatarRequestId })
      .strict()
      .parse(await c.req.json());
    return c.json(await service.selectExisting(c.get("owner"), c.req.param("id"), input.requestId));
  });
  return app;
}
