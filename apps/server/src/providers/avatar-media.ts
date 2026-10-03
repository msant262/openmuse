import { readFile } from "node:fs/promises";
import { z } from "zod";
import { rasterMime } from "../../../../packages/domain/src/attachments.ts";
import type {
  AvatarCapabilities,
  AvatarMotion,
} from "../../../../packages/domain/src/avatar-character.ts";
import { decodeBase64 } from "../base64.ts";
import type { Config } from "../config.ts";
import { modelProviderConfig } from "./config.ts";
import { httpProviderError, ModelProviderError } from "./errors.ts";
import { GROK_API_URL, grokAccessToken } from "./grok-auth.ts";

export interface AvatarProviderSettings {
  provider: "auto" | "grok" | "off";
  imageModel: string;
  videoModel: string;
}
export interface GeneratedAvatarMedia {
  bytes: Uint8Array;
  mimeType: string;
  durationMs?: number;
}
export type AvatarVideoResult =
  | { status: "pending" }
  | { status: "failed"; error: string }
  | { status: "done"; media: GeneratedAvatarMedia };
export interface AvatarMediaProvider {
  capabilities(): Promise<AvatarCapabilities>;
  images(prompt: string, signal?: AbortSignal): Promise<GeneratedAvatarMedia[]>;
  workingPoster(
    reference: GeneratedAvatarMedia,
    signal?: AbortSignal,
  ): Promise<GeneratedAvatarMedia>;
  submitVideo(
    reference: GeneratedAvatarMedia,
    motion: AvatarMotion,
    signal?: AbortSignal,
  ): Promise<string>;
  video(requestId: string, signal?: AbortSignal): Promise<AvatarVideoResult>;
}
export const avatarVisualBrief =
  "Render ONE adorable bespoke high-end 3D plush collectible companion per image. Use the refined craftsmanship and emotional appeal of an exceptional handmade miniature: harmonious compact rounded proportions, beautifully sculpted coherent silhouette, an inviting warm lovable face, delicate realistic short fur or velvet nap and carefully stitched soft textile details. Luxurious physically soft studio light reveals tactile material and subtle depth. Unless the description specifies otherwise, use tiny glossy black bead eyes (each only 8 to 10 percent of face width), a shallow matte face, subtle rosy cheeks and the smallest gentle closed smile; expressive, calm and appealing at 48px. Simplify the requested anatomy into soft compact plush proportions, preserving its recognizable species traits. Avoid uncanny, blank, frightening, deformed or generic ball-shaped faces, giant anime eyes, iris rings, plastic/glass bodies and exaggerated brows. Full-body centered portrait, subject around 70 percent of square frame, comfortable margin around the entire silhouette, pure white seamless background with a subtle soft contact shadow and bright diffused upper-left key light. Near-orthographic locked perspective. ONE character only; no text, logo, watermark, collage, frame or scenery.";
// Keep shared direction species-neutral: named examples can become unwanted visual features.
const avatarCharacterConstraints =
  "The character description is the sole authority for species, anatomy, colors and accessories. Include only explicitly requested features and the normal anatomy of the requested species. Explicit exclusions override typical species anatomy and all styling defaults. Do not add decorative appendages, hybrid anatomy, costumes or accessories to make a candidate more distinctive. For an unspecified or invented creature, use the simplest coherent plush body compatible with the description and leave unmentioned ornamental features absent. All four candidates must satisfy the same requested traits and exclusions; vary only subtle proportions, expression and textile detailing within those constraints.";
export const workingAvatarBrief =
  "Preserve this exact character's identity, anatomy, face, eyes, colors, body proportions and textile material; do not add, remove or redesign any body parts. Put the same miniature plush companion at a narrow light wood tabletop, wearing simple black over-ear headphones, with a slim dark gray laptop at lower screen-right. Its existing limbs rest close to the keyboard. Subtle three-quarter view facing screen-right. Keep the head and face fully visible above the laptop, calm small smile, pure white seamless background, fixed soft light and full silhouette margin. No human fingers, additional characters, words, UI or logos.";
const motionBrief: Record<AvatarMotion, string> = {
  idle: "Hands rest at sides. Very faint slow breathing (only 1 percent), one soft blink and a tiny content head settle of at most two degrees.",
  working:
    "Keep the headphones, laptop and tabletop unchanged. Tiny alternating mitten-arm movements imply typing, wrists near keyboard. Occasional blink and very slight attentive head nod toward screen. Body stays anchored.",
  responding:
    "A tiny acknowledging nod and one gentle blink, then return to the resting pose. Hands at sides and mouth stays a minimal closed smile. No lip sync or exaggerated talking mouth.",
};
export function avatarProviderSettings(
  env: NodeJS.ProcessEnv = process.env,
): AvatarProviderSettings {
  return {
    provider: z.enum(["auto", "grok", "off"]).parse(env.AVATAR_PROVIDER?.trim() || "auto"),
    imageModel: env.AVATAR_IMAGE_MODEL?.trim() || "grok-imagine-image-2.0",
    videoModel: env.AVATAR_VIDEO_MODEL?.trim() || "grok-imagine-video-1.5",
  };
}
async function bounded(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing provider response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.length;
    if (length > limit) {
      await reader.cancel();
      throw new Error("Provider media exceeds size limit");
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks);
}
export function avatarVideoMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(4, 8)).toString() === "ftyp")
    return "video/mp4";
  if (bytes.length >= 4 && [0x1a, 0x45, 0xdf, 0xa3].every((v, i) => bytes[i] === v))
    return "video/webm";
  return undefined;
}
/** This provider uses the protected Grok subscription grant, independently of chat routing. */
export class GrokAvatarProvider implements AvatarMediaProvider {
  readonly settings: AvatarProviderSettings;
  private readonly credentialFile: string;
  constructor(
    config: Config,
    private readonly upstream: typeof fetch = fetch,
  ) {
    this.settings = config.avatarProvider ?? avatarProviderSettings();
    this.credentialFile = (
      config.modelProviders ?? modelProviderConfig(config.dataDir ?? ".openmuse")
    ).grokFile;
  }
  async capabilities(): Promise<AvatarCapabilities> {
    if (this.settings.provider === "off")
      return {
        provider: null,
        images: false,
        videos: false,
        reason:
          "A criação de personagens está desativada nesta instalação. Seus personagens salvos continuam disponíveis.",
      };
    try {
      const saved = JSON.parse(await readFile(this.credentialFile, "utf8"));
      if (!saved.access_token || !saved.refresh_token) throw new Error("No grant");
      return { provider: "grok", images: true, videos: true };
    } catch {
      return {
        provider: null,
        images: false,
        videos: false,
        reason:
          "Conecte a conta Grok no servidor para criar personagens e animações. Seus personagens salvos continuam disponíveis.",
      };
    }
  }
  private async request(path: string, body?: Record<string, unknown>, signal?: AbortSignal) {
    const token = await grokAccessToken(this.credentialFile, {}, signal);
    const response = await this.upstream(`${GROK_API_URL}${path}`, {
      method: body ? "POST" : "GET",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "OpenMuse/0.1",
      },
      ...(body && { body: JSON.stringify(body) }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(180000)])
        : AbortSignal.timeout(180000),
    });
    if (!response.ok) throw await httpProviderError("grok", response);
    return JSON.parse((await bounded(response, 48 * 1024 * 1024)).toString());
  }
  private parseImages(value: unknown, count: number) {
    const parsed = z
      .object({ data: z.array(z.object({ b64_json: z.string() })).length(count) })
      .parse(value);
    return parsed.data.map((image): GeneratedAvatarMedia => {
      const bytes = decodeBase64(image.b64_json, 8 * 1024 * 1024);
      const mimeType = bytes && rasterMime(bytes);
      if (!bytes || !mimeType) throw new Error("Provider returned invalid image data");
      return { bytes, mimeType };
    });
  }
  async images(prompt: string, signal?: AbortSignal) {
    return this.parseImages(
      await this.request(
        "/images/generations",
        {
          model: this.settings.imageModel,
          prompt: `Character description:\n${prompt}\n\nRendering style:\n${avatarVisualBrief}\n\nCharacter constraints:\n${avatarCharacterConstraints}`,
          n: 4,
          aspect_ratio: "1:1",
          response_format: "b64_json",
        },
        signal,
      ),
      4,
    );
  }
  async workingPoster(reference: GeneratedAvatarMedia, signal?: AbortSignal) {
    return this.parseImages(
      await this.request(
        "/images/edits",
        {
          model: this.settings.imageModel,
          prompt: workingAvatarBrief,
          image: { url: this.dataUrl(reference), type: "image_url" },
          n: 1,
          aspect_ratio: "1:1",
          response_format: "b64_json",
        },
        signal,
      ),
      1,
    )[0];
  }
  private dataUrl(reference: GeneratedAvatarMedia) {
    return `data:${reference.mimeType};base64,${Buffer.from(reference.bytes).toString("base64")}`;
  }
  async submitVideo(reference: GeneratedAvatarMedia, motion: AvatarMotion, signal?: AbortSignal) {
    const url = this.dataUrl(reference);
    const result = await this.request(
      "/videos/generations",
      {
        model: this.settings.videoModel,
        prompt: `Animate this exact miniature plush character as a restrained seamless six-second loop. Preserve identity, anatomy, eyes, material, colors, lighting, framing and all props across every frame; do not add, remove or redesign any body parts. ${motionBrief[motion]} Begin and end in the identical pose. Camera locked, background and shadow fixed. No zoom, pan, bouncing, swaying, squashing, waving, morphing, texture shimmer, new props, words, music or speech.`,
        image: { url },
        ...(this.settings.videoModel.includes("1.5") && { last_frame: { url } }),
        duration: 6,
        aspect_ratio: "1:1",
        resolution: "720p",
        generate_audio: false,
      },
      signal,
    );
    return z.object({ request_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/) }).parse(result)
      .request_id;
  }
  async video(requestId: string, signal?: AbortSignal): Promise<AvatarVideoResult> {
    const result = await this.request(
      `/videos/${encodeURIComponent(requestId)}`,
      undefined,
      signal,
    );
    if (["failed", "expired"].includes(result.status))
      return {
        status: "failed",
        error: "O provedor não concluiu este vídeo. Tente gerar a animação novamente.",
      };
    if (result.status !== "done") return { status: "pending" };
    if (result.video?.respect_moderation === false)
      return {
        status: "failed",
        error: "O provedor recusou esta animação. Ajuste a descrição do personagem.",
      };
    const url = new URL(z.string().url().parse(result.video?.url));
    // Only provider-owned output hosts; no credential/header is forwarded to media storage.
    if (
      url.protocol !== "https:" ||
      url.hostname !== "vidgen.x.ai" ||
      url.username ||
      url.password ||
      url.port
    )
      throw new Error("Untrusted video output URL");
    const response = await this.upstream(url, {
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
        : AbortSignal.timeout(60000),
    });
    if (!response.ok)
      throw new ModelProviderError(
        "grok",
        "video_download_failed",
        "O vídeo está pronto, mas o download falhou. O aplicativo tentará buscar o mesmo vídeo novamente.",
        response.status,
      );
    const bytes = await bounded(response, 25 * 1024 * 1024);
    const mimeType = avatarVideoMime(bytes);
    if (!mimeType) throw new Error("Invalid generated video");
    return {
      status: "done",
      media: {
        bytes,
        mimeType,
        durationMs: typeof result.video.duration === "number" ? result.video.duration * 1000 : 6000,
      },
    };
  }
}
