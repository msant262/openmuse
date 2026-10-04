import type { Message } from "@ag-ui/core";
import { convertSchemaToJsonSchema, type ModelMessage, type SchemaInput } from "@tanstack/ai";
import { z } from "zod";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { browserImageMessage, browserImageReference } from "../providers/browser-images.ts";

export const contextModelSchema = z
  .object({
    id: z.string().min(1),
    contextTokens: z.number().int().min(256).max(4000000),
    outputReserveTokens: z.number().int().min(0).max(1000000).optional(),
    imageContextTokens: z.number().int().min(0).max(1000000).optional(),
  })
  .strict();
export type ContextModel = z.infer<typeof contextModelSchema>;
export type ContextObservation = {
  messageId: string;
  observedAt: string;
  artifactId: string;
  operationIds?: readonly string[];
};
export type ContextOptions = {
  model: ContextModel;
  requiredOperationIds?: readonly string[];
  systemPrompts?: readonly unknown[];
  tools?: readonly unknown[];
  outputSchema?: unknown;
  observations?: readonly ContextObservation[];
  now?: number;
};
export type ContextModelResolver = (requirements: {
  tools: boolean;
  vision: boolean;
  structuredOutput: boolean;
  contextTokens?: number;
}) => ContextModel | undefined;

/** Conservative UTF-8 JSON bound shared with M5 admission; never divide characters by four.
 * Only provider context is trimmed. Canonical transcripts, journal receipts and audit assets remain. */
export class ContextBudget {
  constructor(private readonly db: Store) {}
  /** Only server screenshot tool receipts carry capture freshness. User attachments do not expire. */
  static observations(messages: readonly (Message | ModelMessage)[]): ContextObservation[] {
    const calls = new Map(
      messages.flatMap((message) =>
        ("toolCalls" in message ? (message.toolCalls ?? []) : []).map(
          (call) => [call.id, call.function.name] as const,
        ),
      ),
    );
    return messages.flatMap((message) => {
      if (
        message.role !== "tool" ||
        !["desktop_observe", "connection_challenge"].includes(
          calls.get(message.toolCallId ?? "") ?? "",
        ) ||
        typeof message.content !== "string" ||
        message.content.length > 16000
      )
        return [];
      try {
        const value = JSON.parse(message.content);
        if (
          value?.browserScreenshot !== true ||
          (value?.desktopScreenshot !== true && value?.challengeScreenshot !== true) ||
          typeof value.observedAt !== "string" ||
          !Number.isFinite(Date.parse(value.observedAt)) ||
          typeof value.screenshotId !== "string" ||
          !/^[a-f0-9]{64}$/.test(value.screenshotId)
        )
          return [];
        return [
          {
            messageId: ContextBudget.messageKey(message),
            observedAt: value.observedAt,
            artifactId: value.screenshotId,
            operationIds: message.toolCallId ? [message.toolCallId] : [],
          },
        ];
      } catch {
        return [];
      }
    });
  }
  private static messageKey(message: Message | ModelMessage): string {
    return message.id ?? (message.role === "tool" ? `tool:${message.toolCallId}` : "");
  }
  static currentVision(
    messages: readonly (Message | ModelMessage)[],
    observations = ContextBudget.observations(messages),
    now = Date.now(),
  ): boolean {
    const expired = new Set(
      observations
        .filter((item) => now - Date.parse(item.observedAt) > 5 * 60 * 1000)
        .map((item) => item.messageId),
    );
    return ContextBudget.requiresVision(
      messages.filter((message) => !expired.has(ContextBudget.messageKey(message))),
    );
  }
  async build(owner: string, input: { threadId: string } & ContextOptions): Promise<Message[]> {
    const messages = await this.db.threadContextMessages(
      owner,
      input.threadId,
      input.requiredOperationIds ?? [],
    );
    return ContextBudget.limit(messages, input);
  }
  static requiresVision(value: unknown): boolean {
    if (!value || typeof value !== "object") {
      if (typeof value !== "string" || value.length > 16000) return false;
      try {
        const receipt = JSON.parse(value);
        return receipt?.browserScreenshot === true || receipt?.fileImage === true;
      } catch {
        return false;
      }
    }
    if (Array.isArray(value)) return value.some(ContextBudget.requiresVision);
    const item = value as Record<string, unknown>;
    return (
      ["image", "image_url", "input_image"].includes(String(item.type)) ||
      (item.type === "binary" && String(item.mimeType ?? "").startsWith("image/")) ||
      Object.values(item).some(ContextBudget.requiresVision)
    );
  }
  static cost(messages: readonly unknown[], options: ContextOptions): number {
    let images = 0;
    const reference = browserImageReference(messages);
    // Project exactly the hydrator's repeated text and JSON wrapper before admission.
    // The placeholder image is charged with the configured image allowance below.
    const projected = reference
      ? [
          ...messages,
          browserImageMessage(reference, {
            type: "image",
            source: { type: "url", value: "context-placeholder" },
          }),
        ]
      : messages;
    const input = JSON.stringify(
      {
        messages: projected,
        prompts: options.systemPrompts ?? [],
        // TanStack converts Standard Schema tools before adapter admission. Raw
        // Runtime schema objects can both overcount and omit provider-visible fields.
        tools: (options.tools ?? []).map((tool) => {
          if (!tool || typeof tool !== "object") return tool;
          const value = tool as Record<string, unknown>;
          return {
            ...value,
            ...(value.inputSchema
              ? { inputSchema: convertSchemaToJsonSchema(value.inputSchema as SchemaInput) }
              : {}),
            ...(value.outputSchema
              ? { outputSchema: convertSchemaToJsonSchema(value.outputSchema as SchemaInput) }
              : {}),
          };
        }),
        schema: options.outputSchema,
      },
      (_key, value) => {
        if (
          value &&
          typeof value === "object" &&
          ["image", "image_url", "input_image", "binary"].includes(value.type) &&
          (value.type !== "binary" || String(value.mimeType ?? "").startsWith("image/"))
        ) {
          images++;
          return { type: "image_context" };
        }
        return value;
      },
    );
    return Buffer.byteLength(input ?? "") + images * (options.model.imageContextTokens ?? 8192);
  }
  static limit<T extends Message | ModelMessage>(messages: T[], options: ContextOptions): T[] {
    return ContextBudget.project(messages, options);
  }
  static minimumTokens<T extends Message | ModelMessage>(
    messages: T[],
    options: Omit<ContextOptions, "model"> & { imageContextTokens?: number },
  ): number {
    const budget = {
      ...options,
      model: {
        id: "required-context",
        contextTokens: 4000000,
        outputReserveTokens: 4096,
        imageContextTokens: options.imageContextTokens,
      },
    };
    return ContextBudget.cost(ContextBudget.project(messages, budget, true), budget) + 4096;
  }
  private static project<T extends Message | ModelMessage>(
    messages: T[],
    options: ContextOptions,
    minimumOnly = false,
  ): T[] {
    const model = contextModelSchema.parse(options.model);
    const reserve = model.outputReserveTokens ?? 4096;
    const available = model.contextTokens - reserve;
    if (ContextBudget.cost([], options) > available)
      throw new AppError(
        "CONTEXT_BASE_TOO_LARGE: system prompt, tools and output reserve exceed model capacity",
        422,
      );
    const required = new Set(options.requiredOperationIds ?? []);
    const observations = new Map(
      (options.observations ?? ContextBudget.observations(messages)).map((item) => [
        item.messageId,
        item,
      ]),
    );
    const now = options.now ?? Date.now();
    const completeCalls = new Set(
      messages.flatMap((message) =>
        message.role === "tool" && message.toolCallId ? [message.toolCallId] : [],
      ),
    );
    const called = new Set(
      messages.flatMap(
        (message) =>
          ("toolCalls" in message ? message.toolCalls?.map((call) => call.id) : []) ?? [],
      ),
    );
    if ([...required].some((id) => called.has(id) !== completeCalls.has(id)))
      throw new AppError(
        "CONTEXT_REQUIRED_INCOMPLETE: required operation has no completed call/result pair; retain it for journal reconciliation",
        409,
      );
    const normalized = messages
      .filter((message) => message.role !== "tool" || called.has(message.toolCallId ?? ""))
      .map((message) => {
        if ("toolCalls" in message && message.toolCalls)
          message = {
            ...message,
            toolCalls: message.toolCalls.filter((call) => completeCalls.has(call.id)),
          } as T;
        const observation = observations.get(ContextBudget.messageKey(message));
        if (
          !observation ||
          message.role === "activity" ||
          now - Date.parse(observation.observedAt) <= 5 * 60 * 1000
        )
          return message;
        const text =
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(
                Array.isArray(message.content)
                  ? message.content.filter((part) => part.type === "text")
                  : "",
              );
        return {
          ...message,
          content: `${text ?? ""}\nObsolete observation retained for audit: ${observation.artifactId}. Obtain a fresh observation before acting.`,
        } as T;
      });
    const parent = normalized.map((_, i) => i);
    const find = (i: number): number => {
      if (parent[i] === i) return i;
      parent[i] = find(parent[i]);
      return parent[i];
    };
    const link = (a: number, b: number) => {
      parent[find(b)] = find(a);
    };
    const calls = new Map<string, number>();
    for (const [index, message] of normalized.entries())
      for (const call of ("toolCalls" in message ? message.toolCalls : []) ?? [])
        calls.set(call.id, index);
    for (const [index, message] of normalized.entries()) {
      const caller = message.role === "tool" ? calls.get(message.toolCallId ?? "") : undefined;
      if (caller !== undefined) link(caller, index);
    }
    const groups = new Map<number, number[]>();
    for (const index of parent.keys()) {
      const key = find(index);
      groups.set(key, [...(groups.get(key) ?? []), index]);
    }
    const lastUser = normalized.findLastIndex((message) => message.role === "user");
    const mandatory = new Set<number>();
    const anchored = new Set<string>();
    for (const [index, message] of normalized.entries()) {
      const observation = observations.get(ContextBudget.messageKey(message));
      for (const call of ("toolCalls" in message ? message.toolCalls : []) ?? [])
        anchored.add(call.id);
      if (message.role === "tool" && message.toolCallId) anchored.add(message.toolCallId);
      for (const id of observation?.operationIds ?? []) anchored.add(id);
      if (
        index === lastUser ||
        message.role === "system" ||
        message.role === "developer" ||
        ("toolCalls" in message && message.toolCalls?.some((call) => required.has(call.id))) ||
        (message.role === "tool" && required.has(message.toolCallId ?? "")) ||
        observation?.operationIds?.some((id) => required.has(id))
      )
        mandatory.add(find(index));
    }
    if ([...required].some((id) => !anchored.has(id)))
      throw new AppError(
        "CONTEXT_REQUIRED_MISSING: required journal receipt/operation history is unavailable; no effect may be repeated",
        409,
      );
    const selected = new Set<number>();
    for (const group of mandatory) for (const index of groups.get(group) ?? []) selected.add(index);
    const project = () => normalized.filter((_, index) => selected.has(index));
    if (ContextBudget.cost(project(), options) > available)
      throw new AppError(
        "CONTEXT_REQUIRED_TOO_LARGE: current request and required operation receipts cannot fit; required evidence was retained",
        422,
      );
    if (minimumOnly) return project();
    for (const [group, indexes] of [...groups].sort(
      (a, b) => b[1][b[1].length - 1] - a[1][a[1].length - 1],
    )) {
      if (mandatory.has(group)) continue;
      for (const index of indexes) selected.add(index);
      if (ContextBudget.cost(project(), options) > available)
        for (const index of indexes) selected.delete(index);
    }
    return project();
  }
}
