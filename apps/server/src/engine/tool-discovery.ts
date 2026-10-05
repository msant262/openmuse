import { defineTool, type ToolDefinition } from "@copilotkit/runtime/v2";
import { convertSchemaToJsonSchema, type ModelMessage, type SchemaInput } from "@tanstack/ai";
import { z } from "zod";
import { AppError } from "../errors.ts";
import {
  buildLexicalIndex,
  readParameterText,
  scoreLexical,
  tokenizeDocument,
  tokenizeQuery,
} from "./openclaw/tool-search-ranking.ts";

// Hermes tool_search progressive disclosure, adapted to native TanStack tool identity.
// Schemas are deferred; permissions/execution remain with the existing dispatcher.
const eager = new Set([
  "search_tools",
  "describe_tools",
  "ask_user",
  "finish_task",
  "delegate_task",
  "continue_task",
  "todo_list",
  "react_to_message",
  "send_sticker",
  "send_gif",
  "search_gifs",
  "search_web",
  "web_fetch",
  "read_web_data",
  "web_extract",
  "reply_to_message",
  "wait_for_children",
  "read_tool_output",
  "read_task_evidence",
  "skills_search",
  "skills_read",
  "read_runtime",
  "search_app_tools",
  "execute_app_tool",
  "AGUISendStateSnapshot",
  "AGUISendStateDelta",
]);
const maxLoadedBytes = 24000;
const maxLoaded = 12;
const normalize = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "");

/** A run-local schema view of the actual authorized tool catalog. Never a second executor. */
export class ToolDiscovery {
  private readonly catalog: Map<string, ToolDefinition>;
  private readonly loaded = new Map<string, number>();
  private readonly schemas = new Map<string, unknown>();
  private readonly index: ReturnType<typeof buildLexicalIndex<string>>;
  readonly enabled: boolean;

  constructor(tools: readonly ToolDefinition[]) {
    this.catalog = new Map(tools.map((tool) => [tool.name, tool]));
    // Small specialized agents (learning/heartbeat) already have a compact surface.
    this.enabled = tools.length > 12;
    this.index = buildLexicalIndex(
      tools.map((tool) => {
        const schema = convertSchemaToJsonSchema(tool.parameters as SchemaInput);
        this.schemas.set(tool.name, schema);
        return {
          value: tool.name,
          terms: tokenizeDocument(
            normalize(`${tool.name} ${tool.description} ${readParameterText(schema)}`),
          ),
        };
      }),
    );
  }

  private load(name: string) {
    if (!this.catalog.has(name)) throw new AppError(`Unknown or unavailable tool: ${name}`, 404);
    this.loaded.delete(name);
    this.loaded.set(name, Buffer.byteLength(JSON.stringify(this.schemas.get(name))));
    while (
      this.loaded.size > 1 &&
      (this.loaded.size > maxLoaded ||
        [...this.loaded.values()].reduce((a, b) => a + b, 0) > maxLoadedBytes)
    )
      this.loaded.delete(this.loaded.keys().next().value!);
  }

  select<T extends { name: string }>(tools: readonly T[]): T[] {
    return tools.filter(
      (tool) =>
        !this.enabled ||
        eager.has(tool.name) ||
        !this.catalog.has(tool.name) ||
        this.loaded.has(tool.name),
    );
  }

  /** History is authoritative only for visibility. It never grants an unavailable capability. */
  restore(messages: readonly ModelMessage[]) {
    this.loaded.clear();
    const calls = new Map(
      messages.flatMap((m) =>
        (m.toolCalls ?? []).map((call) => [call.id, call.function.name] as const),
      ),
    );
    for (const message of messages) {
      for (const call of message.toolCalls ?? [])
        if (this.catalog.has(call.function.name)) this.load(call.function.name);
      if (message.role !== "tool" || calls.get(message.toolCallId ?? "") !== "describe_tools")
        continue;
      try {
        const result = JSON.parse(String(message.content));
        if (Array.isArray(result.loaded))
          for (const name of result.loaded)
            if (typeof name === "string" && this.catalog.has(name)) this.load(name);
      } catch {
        /* A failed/truncated description does not declare loaded tools. */
      }
    }
  }

  search(query: string, limit = 6) {
    const exact = this.catalog.has(query.trim()) ? query.trim() : undefined;
    const ranked = scoreLexical(this.index, tokenizeQuery(normalize(query)))
      .sort(
        (a, b) =>
          Number(b.value === exact) - Number(a.value === exact) ||
          Number(b.matchedLiteral) - Number(a.matchedLiteral) ||
          b.score - a.score ||
          a.value.localeCompare(b.value),
      )
      .map((hit) => hit.value);
    const names = [...new Set([...(exact ? [exact] : []), ...ranked])].slice(
      0,
      Math.min(12, Math.max(1, limit)),
    );
    return {
      tools: names.map((name) => ({
        name,
        description: this.catalog.get(name)!.description?.slice(0, 300) ?? "",
      })),
      nextStep: "Use describe_tools for schemas, then call the native tool by its exact name.",
    };
  }

  describe(names: string[]) {
    const distinct = [...new Set(names)];
    const tools = distinct.map((name) => {
      const tool = this.catalog.get(name);
      if (!tool) throw new AppError(`Unknown or unavailable tool: ${name}`, 404);
      return { name, description: tool.description, parameters: this.schemas.get(name) };
    });
    for (const name of distinct) this.load(name);
    return {
      tools,
      loaded: distinct,
      nextStep:
        "Call the native tool with this schema. Existing permissions and current user scope still apply.",
    };
  }

  tools(): ToolDefinition[] {
    if (!this.enabled) return [];
    let manifest = "";
    for (const name of this.catalog.keys()) {
      if (manifest.length + name.length > 6000) break;
      manifest += `${manifest ? ", " : ""}${name}`;
    }
    return [
      defineTool({
        name: "search_tools",
        description: `Search ${this.catalog.size} available capabilities using action/object keywords. Full schemas load on demand. Search before saying a capability is unavailable. Known names (skip search if exact name is known): ${manifest}`,
        parameters: z
          .object({
            query: z.string().trim().min(1).max(500),
            limit: z.number().int().min(1).max(12).default(6),
          })
          .strict(),
        execute: async ({ query, limit }) => this.search(query, limit),
      }),
      defineTool({
        name: "describe_tools",
        description:
          "Load schemas for up to four exact available tool names. Then invoke those native tools normally. This loads information, not new permissions.",
        parameters: z.object({ names: z.array(z.string().min(1).max(200)).min(1).max(4) }).strict(),
        execute: async ({ names }) => this.describe(names),
      }),
    ];
  }
}
