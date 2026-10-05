import { resolve } from "node:path";
import { z } from "zod";
import { CODEX_RESPONSES_URL, codexAccessToken } from "./codex-auth.ts";
import type { ModelProviderConfig } from "./config.ts";
import { httpProviderError, ModelProviderError, safeCode } from "./errors.ts";
import { ImageNotDispatchedError } from "./image-errors.ts";

const itemSchema = z.object({
  type: z.string(),
  status: z.string().optional(),
  result: z.string().optional(),
});
const eventSchema = z.object({
  type: z.string(),
  item: itemSchema.optional(),
  response: z
    .object({
      status: z.string().optional(),
      output: z.array(itemSchema).optional(),
      error: z.object({ code: z.string().optional() }).nullish(),
    })
    .optional(),
  error: z.object({ code: z.string().optional() }).optional(),
});
const incomplete = () =>
  new ModelProviderError(
    "codex",
    "provider_stream_incomplete",
    "A geração do GPT Image foi interrompida antes da confirmação. Nenhuma imagem foi publicada e o pedido não será repetido automaticamente.",
  );

/** Normalize the Codex hosted-tool stream into the bounded image adapter contract. */
export async function codexImageResponse(response: Response): Promise<Response> {
  if (!response.body) throw incomplete();
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    size = 0,
    count = 0;
  let completed: z.infer<typeof eventSchema>["response"];
  const done: z.infer<typeof itemSchema>[] = [];
  const frame = (value: string) => {
    const data = value
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    if (++count > 2048) throw incomplete();
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      throw incomplete();
    }
    const parsed = eventSchema.safeParse(raw);
    if (!parsed.success) throw incomplete();
    const event = parsed.data;
    if (["error", "response.failed", "response.incomplete"].includes(event.type)) {
      throw new ModelProviderError(
        "codex",
        safeCode(event.error?.code ?? event.response?.error?.code) ?? "image_generation_failed",
        "O GPT Image não concluiu a geração. Verifique o limite ou a disponibilidade da assinatura nas Configurações.",
      );
    }
    if (event.type === "response.output_item.done" && event.item) done.push(event.item);
    if (event.type === "response.completed") {
      if (!event.response || (event.response.status && event.response.status !== "completed"))
        throw incomplete();
      completed = event.response;
    }
  };
  try {
    while (true) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      size += value.byteLength;
      if (size > 40 * 1024 * 1024)
        throw new ModelProviderError(
          "codex",
          "image_response_too_large",
          "A imagem ultrapassou o limite de resposta.",
        );
      buffer += decoder.decode(value, { stream: true });
      let match = /\r?\n\r?\n/.exec(buffer);
      while (match) {
        frame(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        match = /\r?\n\r?\n/.exec(buffer);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) frame(buffer);
    if (!completed) throw incomplete();
    const finalImages = (completed.output ?? []).filter(
      (item) => item.type === "image_generation_call",
    );
    const images = finalImages.length
      ? finalImages
      : done.filter((item) => item.type === "image_generation_call");
    if (
      images.length !== 1 ||
      (images[0].status && images[0].status !== "completed") ||
      !images[0].result
    )
      throw new ModelProviderError(
        "codex",
        "image_missing",
        "O GPT Image terminou sem entregar uma imagem utilizável.",
      );
    return Response.json({ data: [{ b64_json: images[0].result }] });
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function codexImageProvider(config: ModelProviderConfig, upstream: typeof fetch = fetch) {
  const model = config.codexImageModel ?? "gpt-image-2";
  return {
    model,
    async generate(body: Record<string, unknown>, signal?: AbortSignal) {
      const auth = await codexAccessToken(
        config.codexFile ?? resolve(config.authDir, "codex.json"),
        {},
        signal,
      ).catch((error) => {
        throw new ImageNotDispatchedError(error);
      });
      const ratio = typeof body.aspect_ratio === "string" ? body.aspect_ratio : "1:1";
      const size = ["3:4", "9:16"].includes(ratio)
        ? "1024x1536"
        : ["4:3", "16:9"].includes(ratio)
          ? "1536x1024"
          : "1024x1024";
      let response: Response;
      try {
        response = await upstream(CODEX_RESPONSES_URL, {
          method: "POST",
          redirect: "error",
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(300000)])
            : AbortSignal.timeout(300000),
          headers: {
            Authorization: `Bearer ${auth.token}`,
            ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "User-Agent": "OpenMuse/0.1",
            originator: "openmuse",
          },
          body: JSON.stringify({
            model: config.codexResponsesModel ?? "gpt-6-astra",
            instructions:
              "You are an image generation assistant. Generate the image requested by the user with the image_generation tool. " +
              `Current UTC date and time: ${new Date().toISOString()}\n` +
              "The calling application handles research and verification. Treat its prompt as a rendering brief: preserve supplied text, numerical values, labels and source attribution. Do not invent different factual claims or attribution.",
            input: [{ role: "user", content: [{ type: "input_text", text: body.prompt }] }],
            tools: [{ type: "image_generation", model, size, output_format: "png" }],
            tool_choice: { type: "image_generation" },
            stream: true,
            store: false,
          }),
        });
      } catch {
        if (signal?.aborted) signal.throwIfAborted();
        throw new ModelProviderError(
          "codex",
          "provider_network_error",
          "Não foi possível alcançar o GPT Image da assinatura ChatGPT.",
        );
      }
      if (!response.ok) throw await httpProviderError("codex", response);
      return codexImageResponse(response);
    },
  };
}
