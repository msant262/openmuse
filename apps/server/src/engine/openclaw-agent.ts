import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/core";
import { convertInputToTanStackAI, defineTool, type ToolDefinition } from "@copilotkit/runtime/v2";
import {
  type ContentPart,
  convertSchemaToJsonSchema,
  fromSpecTokenUsage,
  type ModelMessage,
  type SchemaInput,
} from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { Observable } from "rxjs";
import { z } from "zod";
import type { ModelRequirements, WorkClass } from "../../../../packages/domain/src/runtime.ts";
import type { Store } from "../db.ts";
import type { BrowserImageLoader } from "../providers/browser-images.ts";
import type { ModelProviderConfig } from "../providers/config.ts";
import type { ModelRouter } from "../providers/model-router.ts";
import type { ModelSelection, ProviderContinuationCheckpoint } from "../providers/models.ts";
import { continuationMessages, modelAdapter } from "../providers/models.ts";
import type { ContextModelResolver } from "./context-budget.ts";
import { harnessToolCatalog } from "./harness-tool-catalog.ts";
import { resolveLiveToolResultMaxChars } from "./openclaw/tool-result-limits.ts";
import { publicJournalValue } from "./task-history.ts";
import { ToolOutputStore } from "./tool-output.ts";

// This is a host boundary, not another agent loop. The copied OpenClaw
// runEmbeddedAgent owns inference, tools, recovery, terminal checks and compaction.
type Options = {
  dataDir: string;
  model: string;
  fallbacks?: readonly string[];
  providers?: ModelProviderConfig;
  tools: ToolDefinition[];
  /** Small foreground conversations need their interaction schemas immediately. */
  toolSearch?: boolean;
  prompt: string;
  /** Startup preflight ends locally before any model transport or host tool. */
  initializeOnly?: boolean;
  promptContext?: () => Promise<string>;
  contextModel?: ContextModelResolver;
  /** Storage for the original session tree; the app transcript remains authoritative. */
  compaction?: { db: Store; owner: string; scope: string };
  requiredOperationIds?: () => Promise<readonly string[]>;
  trackTool?: (execute: () => Promise<unknown>) => Promise<unknown>;
  executeTool?: (
    call: { id: string; toolCallId: string; name: string; args: unknown },
    execute: () => Promise<unknown>,
  ) => Promise<unknown>;
  onMessages?: (messages: ModelMessage[], phase: string) => Promise<void>;
  onText?: (delta: string) => void;
  shouldContinue?: () => boolean;
  finalResponseWhen?: () => boolean;
  finalResponseTools?: () => readonly string[];
  finalResponseContext?: () => Promise<
    { systemPrompts: string[]; messages: ModelMessage[] } | undefined
  >;
  loadBrowserImage?: BrowserImageLoader;
  loadFileImage?: BrowserImageLoader;
  onFileImageObserved?: (fileId: string) => Promise<void>;
  onModelSelected?: (model: ModelSelection) => void;
  workClass?: WorkClass;
  requirements?: Partial<ModelRequirements>;
  modelRouter?: ModelRouter;
  onProviderInterrupted?: (checkpoint: ProviderContinuationCheckpoint) => Promise<void> | void;
  onProviderRecovered?: () => Promise<void>;
};
type NativeMessage = {
  role: string;
  content:
    | string
    | Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        arguments?: unknown;
        data?: string;
        mimeType?: string;
      }>;
  toolCallId?: string;
  toolName?: string;
  timestamp?: number;
  [key: string]: unknown;
};
type NativeContext = {
  systemPrompt?: string;
  messages: NativeMessage[];
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
};
type NativeStream = { push(event: Record<string, unknown>): void; end(): void };
type WorkingSession = {
  appendMessageAsync(message: NativeMessage): Promise<unknown>;
  getHeader(): unknown;
  getEntries(): unknown[];
  buildSessionContext(): { messages: NativeMessage[] };
};
type SavedSession = {
  id: string;
  model: string;
  hashes: string[];
  entries: unknown[];
  receipts?: Array<[string, DispatchReceipt]>;
};
const messageHash = (message: ModelMessage) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        role: message.role,
        text:
          typeof message.content === "string"
            ? message.content
            : (message.content ?? [])
                .map((part) => (part.type === "text" ? part.content : JSON.stringify(part)))
                .join("\n"),
        calls: message.toolCalls ?? [],
        toolCallId: message.toolCallId,
      }),
    )
    .digest("hex");
type Runtime = {
  sanitizeToolCallIdsForCloudCodeAssist(messages: NativeMessage[]): NativeMessage[];
  estimateMessagesTokens(messages: NativeMessage[]): number;
  resolveAgentMaxConcurrent(config?: unknown): number;
  setCommandLaneConcurrency(lane: string, concurrency: number): void;
  disposeAllSessionMcpRuntimes(): Promise<void>;
  closeOpenClawAgentDatabasesAsync(): Promise<void>;
  closeOpenClawStateDatabaseAsync(): Promise<void>;
  runEmbeddedAgent(params: Record<string, unknown>): Promise<{
    meta: {
      error?: { message?: string };
      aborted?: boolean;
      agentMeta?: { agentHarnessId?: string };
    };
    payloads?: Array<{ text?: string }>;
  }>;
  prepareSystemAgentRunAdmission(
    config: unknown,
    runId: string,
    agentId: string,
    boundary: string,
    guard?: () => void,
  ): { close(): void };
  GatewayScheduler: new () => { stop(): Promise<void> };
  setSessionMcpRuntimeScheduler(scheduler: unknown): Promise<void>;
  createAssistantMessageEventStream(): NativeStream;
  SessionManager: {
    inMemory(cwd: string): WorkingSession;
    fromEntries(entries: unknown[], cwd: string): WorkingSession;
  };
};
type Host = {
  tools: Array<Record<string, unknown>>;
  stream(
    model: Record<string, unknown>,
    context: NativeContext,
    options: { signal?: AbortSignal },
  ): NativeStream;
};
const runs = new Map<string, Host>();
const hostKey = "__okamiCopiedHarnessHost";
Object.defineProperty(globalThis, hostKey, {
  configurable: false,
  value: {
    tools(bindings?: Record<string, unknown>) {
      return runs.get(String(bindings?.okamiRunId))?.tools ?? [];
    },
    provider(context: {
      config?: { plugins?: { entries?: Record<string, { config?: { runId?: string } }> } };
    }) {
      const id = context.config?.plugins?.entries?.["okami-host"]?.config?.runId;
      const host = id ? runs.get(id) : undefined;
      if (!host) throw new Error("The copied harness has no admitted model owner");
      return host.stream;
    },
  },
});
let runtime: Promise<Runtime> | undefined;
const warmed = new Map<string, Promise<void>>();
let scheduler: InstanceType<Runtime["GatewayScheduler"]> | undefined;
const active = new Map<
  string,
  { dataDir: string; abort: AbortController; completion: Promise<void> }
>();
export async function stopOpenclawHarness(dataDir: string) {
  warmed.delete(dataDir);
  const pending = [...active.values()].filter((run) => run.dataDir === dataDir);
  for (const run of pending) run.abort.abort();
  await Promise.allSettled(pending.map((run) => run.completion));
  if (active.size || !runtime) return;
  const copied = await runtime;
  await copied.disposeAllSessionMcpRuntimes();
  await scheduler?.stop();
  await copied.closeOpenClawAgentDatabasesAsync();
  await copied.closeOpenClawStateDatabaseAsync();
  runtime = undefined;
  scheduler = undefined;
}
async function loadRuntime(dataDir: string): Promise<Runtime> {
  runtime ??= (async () => {
    process.env.OPENCLAW_STATE_DIR ??= join(dataDir, "harness", "state");
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    const copied = (await import(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "../../../../dist/openclaw-harness/entry.js"
          : "../../../../openclaw-harness/entry.js",
        import.meta.url,
      ).href
    )) as Runtime;
    scheduler = new copied.GatewayScheduler();
    await copied.setSessionMcpRuntimeScheduler(scheduler);
    copied.setCommandLaneConcurrency("main", copied.resolveAgentMaxConcurrent());
    return copied;
  })();
  return runtime;
}
/** Import and initialize the copied runtime before accepting chat requests. */
export async function warmOpenclawHarness(dataDir: string): Promise<void> {
  let pending = warmed.get(dataDir);
  if (!pending) {
    pending = (async () => {
      await loadRuntime(dataDir);
      // Initialize the original plugin loader and attempt executor too. The
      // host's owned-terminal boundary returns NO_REPLY before model transport;
      // this preflight has no credentials, tools, application journal or effects.
      await new Promise<void>((resolve, reject) => {
        let failure: Error | undefined;
        openclawAgent({
          dataDir,
          model: "openai/unconfigured",
          tools: [],
          prompt: "Runtime initialization.",
          initializeOnly: true,
          shouldContinue: () => false,
        })
          .run({
            threadId: randomUUID(),
            runId: randomUUID(),
            messages: [{ id: randomUUID(), role: "user", content: "Initialize the executor." }],
            tools: [],
            context: [],
            state: {},
          })
          .subscribe({
            next: (event) => {
              if (event.type === EventType.RUN_ERROR) failure = new Error(String(event.message));
            },
            error: reject,
            complete: () => (failure ? reject(failure) : resolve()),
          });
      });
    })();
    warmed.set(dataDir, pending);
    pending.catch(() => {
      warmed.delete(dataDir);
    });
  }
  await pending;
}
const controls = new Set(["tool_search", "tool_describe", "tool_call"]);
// Use the original executor's direct tool surface for frequent operations.
// Hiding these makes even an ordinary lookup depend on lexical discovery.
const directTools = new Set([
  "search_web",
  "web_fetch",
  "web_extract",
  "read_web_data",
  "generate_image",
  "image_generation_status",
  "finish_task",
  "todo_list",
  "read_tool_output",
]);
const nativeName = (name: string) => (controls.has(name) ? name : `okami_${name}`);
const publicName = (name: string) => name.replace(/^okami_/, "");
type ToolSchema = {
  type?: string | string[];
  anyOf?: ToolSchema[];
  oneOf?: ToolSchema[];
  properties?: Record<string, ToolSchema>;
  required?: string[];
  items?: ToolSchema;
};
const nullableSchema = (schema: ToolSchema): boolean =>
  schema.type === "null" ||
  (Array.isArray(schema.type) && schema.type.includes("null")) ||
  Boolean((schema.anyOf ?? schema.oneOf)?.some(nullableSchema));
/** Responses strict schemas encode absent optional fields as null. Restore
 * omission against the ORIGINAL host schema before native validation. Explicit
 * nullable fields (including clears) and required fields retain their value. */
function hostArguments(value: unknown, schema?: ToolSchema): unknown {
  if (!schema || !value || typeof value !== "object") return value;
  schema =
    (schema.anyOf ?? schema.oneOf)?.find((branch) => branch.properties || branch.items) ?? schema;
  if (Array.isArray(value)) return value.map((item) => hostArguments(item, schema.items));
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const field = schema.properties?.[key];
      if (item === null && field && !schema.required?.includes(key) && !nullableSchema(field))
        return [];
      return [[key, hostArguments(item, field)]];
    }),
  );
}
const textContent = (message: NativeMessage) =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");
type DispatchReceipt = { id: string; name: string; args: unknown };
function hostMessages(
  messages: NativeMessage[],
  receipts: Map<string, DispatchReceipt>,
): ModelMessage[] {
  return messages.flatMap((message): ModelMessage[] => {
    if (message.role === "user")
      return [
        {
          role: "user",
          content:
            typeof message.content === "string"
              ? message.content
              : (message.content.map((part) =>
                  part.type === "image"
                    ? {
                        type: "image",
                        source: {
                          type: "data",
                          value: String(part.data),
                          mimeType: String(part.mimeType),
                        },
                      }
                    : { type: "text", content: part.text ?? "" },
                ) as ContentPart[]),
        },
      ];
    if (message.role === "toolResult") {
      let content = textContent(message);
      if (message.toolName === "tool_call") {
        try {
          const wrapper = JSON.parse(content);
          if (Array.isArray(wrapper.result?.content))
            content = wrapper.result.content
              .filter((part: { type: string }) => part.type === "text")
              .map((part: { text?: string }) => part.text ?? "")
              .join("\n");
        } catch {
          /* Native dispatcher error text remains visible. */
        }
      }
      return [
        {
          role: "tool",
          toolCallId: receipts.get(message.toolCallId ?? "")?.id ?? message.toolCallId ?? "missing",
          content,
        },
      ];
    }
    if (message.role !== "assistant") return [];
    const calls =
      typeof message.content === "string"
        ? []
        : message.content.filter((part) => part.type === "toolCall");
    return [
      {
        role: "assistant",
        content: textContent(message),
        ...(calls.length
          ? {
              toolCalls: calls.map((call) => ({
                id: receipts.get(call.id ?? "")?.id ?? call.id ?? "missing",
                type: "function" as const,
                function: {
                  name: receipts.get(call.id ?? "")?.name ?? publicName(call.name ?? "unknown"),
                  arguments: JSON.stringify(receipts.get(call.id ?? "")?.args ?? call.arguments),
                },
              })),
            }
          : {}),
      },
    ];
  });
}
const zeroUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
function nativeMessages(messages: ModelMessage[]): NativeMessage[] {
  const toolNames = new Map(
    messages.flatMap((message) =>
      (message.toolCalls ?? []).map((call) => [call.id, call.function.name] as const),
    ),
  );
  return messages.map((message) => {
    const text =
      typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
    if (message.role === "tool")
      return {
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: nativeName(toolNames.get(message.toolCallId ?? "") ?? "tool"),
        content: [{ type: "text", text }],
        isError: false,
        timestamp: Date.now(),
      };
    if (message.role === "assistant")
      return {
        role: "assistant",
        content: [
          ...(text ? [{ type: "text", text }] : []),
          ...(message.toolCalls ?? []).map((call) => ({
            type: "toolCall",
            id: call.id,
            name: nativeName(call.function.name),
            arguments:
              typeof call.function.arguments === "string"
                ? JSON.parse(call.function.arguments)
                : call.function.arguments,
          })),
        ],
        api: "openai-completions",
        provider: "okami",
        model: "configured",
        usage: zeroUsage(),
        stopReason: message.toolCalls?.length ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
    return {
      role: "user",
      content:
        typeof message.content === "string"
          ? [{ type: "text", text }]
          : (message.content ?? []).map((part) =>
              part.type === "image" && part.source.type === "data"
                ? { type: "image", data: part.source.value, mimeType: part.source.mimeType }
                : {
                    type: "text",
                    text: part.type === "text" ? part.content : JSON.stringify(part),
                  },
            ),
      timestamp: Date.now(),
    };
  });
}

async function pluginDirectory(dataDir: string, names: string[]) {
  const digest = createHash("sha256")
    .update(JSON.stringify([...names].sort()))
    .digest("hex")
    .slice(0, 16);
  const directory = join(dataDir, "harness", "plugins", digest);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "okami-harness-host",
      version: "1.0.0",
      openclaw: { extensions: ["./index.cjs"] },
    }),
  );
  await writeFile(
    join(directory, "openclaw.plugin.json"),
    JSON.stringify({
      id: "okami-host",
      providers: ["okami"],
      contracts: { tools: names },
      configSchema: { type: "object" },
    }),
  );
  await writeFile(
    join(directory, "index.cjs"),
    `module.exports={id:"okami-host",register(api){const host=globalThis.${hostKey};api.registerProvider({id:"okami",label:"Okami model transport",auth:[],createStreamFn:ctx=>host.provider(ctx),wrapStreamFn:ctx=>host.provider(ctx)});api.registerTool(ctx=>host.tools(ctx.toolBindings),{names:${JSON.stringify(names)}});}};`,
  );
  return directory;
}

export function openclawAgent(options: Options) {
  let controller: AbortController | undefined;
  return {
    abortRun() {
      controller?.abort();
    },
    run(input: RunAgentInput): Observable<BaseEvent> {
      return new Observable<BaseEvent>((subscriber) => {
        const abort = new AbortController();
        controller = abort;
        const emit = (event: BaseEvent) => {
          if (!subscriber.closed) subscriber.next(event);
        };
        const completion = (async () => {
          const copied = await loadRuntime(options.dataDir);
          abort.signal.throwIfAborted();
          const converted = convertInputToTanStackAI(input);
          const outputs = new ToolOutputStore();
          outputs.observe(converted.messages);
          const modelBudget = options.contextModel?.({
            tools: true,
            vision: false,
            structuredOutput: false,
            contextTokens: 0,
          });
          const contextWindow = modelBudget?.contextTokens ?? 131072;
          const outputBudget = resolveLiveToolResultMaxChars({
            contextWindowTokens: contextWindow,
          });
          const outputArgs = z.object({
            toolCallId: z.string().min(1).max(500),
            part: z.enum(["result", "arguments"]).default("result"),
            offset: z.number().int().nonnegative().default(0),
            pointer: z.string().max(2000).optional(),
            limit: z.number().int().min(2).max(outputBudget).default(Math.min(16000, outputBudget)),
          });
          const tools: ToolDefinition[] = [
            ...options.tools,
            defineTool({
              ...harnessToolCatalog[0],
              parameters: outputArgs,
              execute: async (args) => outputs.read(outputArgs.parse(args), outputBudget),
            }),
          ];
          const names = tools.map((tool) => nativeName(tool.name));
          const schemas = new Map(
            tools.map((tool) => [
              tool.name,
              convertSchemaToJsonSchema(tool.parameters as SchemaInput) as ToolSchema,
            ]),
          );
          const plugin = await pluginDirectory(options.dataDir, names);
          const ownerScope = `${options.compaction?.owner ?? "host"}:${options.compaction?.scope ?? input.threadId}`;
          const agentId = createHash("sha256").update(ownerScope).digest("hex").slice(0, 24);
          const directory = join(options.dataDir, "harness", "owners", agentId);
          const workspace = join(directory, "workspace");
          const agentDir = join(directory, "agent");
          await Promise.all([
            mkdir(workspace, { recursive: true, mode: 0o700 }),
            mkdir(agentDir, { recursive: true, mode: 0o700 }),
          ]);
          const config = {
            agents: {
              entries: { [agentId]: { agentDir, workspace } },
              defaults: { workspace, model: "okami/configured", timeoutSeconds: 21600 },
            },
            models: {
              mode: "replace",
              providers: {
                okami: {
                  api: "openai-completions",
                  apiKey: "host-owned-transport",
                  // The plugin owns transport. This describes its locality to
                  // upstream streaming watchdogs; it is never a dispatch URL.
                  baseUrl: options.model.startsWith("local/")
                    ? (options.providers?.local.baseUrl ?? "http://127.0.0.1:11434")
                    : "https://okami.invalid",
                  models: [
                    {
                      id: "configured",
                      name: options.model,
                      input: ["text", "image"],
                      reasoning: false,
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextWindow,
                      maxTokens: 8192,
                    },
                  ],
                },
              },
            },
            plugins: {
              allow: ["okami-host"],
              load: { paths: [plugin] },
              slots: { memory: "none" },
              entries: { "okami-host": { enabled: true, config: { runId: input.runId } } },
            },
            tools: { allow: names, toolSearch: { enabled: options.toolSearch ?? true } },
            skills: { allowBundled: [], load: { watch: false } },
            logging: { level: "error", consoleLevel: "error" },
          };
          let messageId: string | undefined;
          let acknowledgmentBoundary: string | undefined;
          const receipts = new Map<string, DispatchReceipt>();
          let transportError: unknown;
          let manager: WorkingSession | undefined;
          const persist = async () => {
            if (!manager || !options.compaction) return;
            const saved: SavedSession = {
              id: agentId,
              model: options.model,
              hashes: outputs
                .restore(hostMessages(manager.buildSessionContext().messages, receipts))
                .map(messageHash),
              // fromEntries needs the original versioned header. Without it,
              // upstream treats every restoration as a legacy migration and
              // rebuilds entry identities and the session's branch metadata.
              entries: [manager.getHeader(), ...manager.getEntries()].map((entry) =>
                publicJournalValue(entry, 1_000_000),
              ),
              receipts: [...receipts].map(
                ([id, receipt]) =>
                  [id, publicJournalValue(receipt, 1_000_000)] as [string, DispatchReceipt],
              ),
            };
            await options.compaction.db.put(options.compaction.owner, "harness-sessions", saved);
          };
          const host: Host = {
            tools: tools.map((tool) => ({
              name: nativeName(tool.name),
              ...(directTools.has(tool.name) ? { catalogMode: "direct-only" } : {}),
              label: tool.name,
              description: tool.description,
              parameters: schemas.get(tool.name),
              execute: async (toolCallId: string, raw: unknown) => {
                abort.signal.throwIfAborted();
                const parent = /^tool_call:(.*):okami_[^:]+:\d+$/.exec(toolCallId)?.[1];
                if (parent) {
                  const receipt = { id: toolCallId, name: tool.name, args: raw };
                  receipts.set(parent, receipt);
                  receipts.set(toolCallId, receipt);
                  // Upstream transcript sanitation can rewrite the parent id
                  // after dispatch. Use its own sanitizer to retain the actual
                  // child's receipt identity in the app's canonical journal.
                  const [normalized] = copied.sanitizeToolCallIdsForCloudCodeAssist([
                    {
                      role: "assistant",
                      content: [
                        { type: "toolCall", id: parent, name: "tool_call", arguments: {} },
                        {
                          type: "toolCall",
                          id: toolCallId,
                          name: nativeName(tool.name),
                          arguments: raw,
                        },
                      ],
                    },
                  ]);
                  if (Array.isArray(normalized?.content)) {
                    for (const part of normalized.content)
                      if (part.type === "toolCall" && part.id) receipts.set(part.id, receipt);
                  }
                }
                if (
                  options.finalResponseWhen?.() &&
                  !options.finalResponseTools?.().includes(tool.name)
                )
                  return {
                    content: [
                      {
                        type: "text",
                        text: "The durable task already owns this work. Acknowledge its receipt; remaining conversation actions are available.",
                      },
                    ],
                  };
                emit({
                  type: EventType.TOOL_CALL_START,
                  toolCallId,
                  toolCallName: tool.name,
                  ...(messageId ? { parentMessageId: messageId } : {}),
                });
                emit({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(raw) });
                const execute = () => (tool.execute as (args: unknown) => Promise<unknown>)(raw);
                const dispatch = () =>
                  options.executeTool
                    ? options.executeTool(
                        {
                          id: `${input.runId}:${toolCallId}`,
                          toolCallId,
                          name: tool.name,
                          args: raw,
                        },
                        execute,
                      )
                    : execute();
                let result: unknown;
                try {
                  result = await (options.trackTool ? options.trackTool(dispatch) : dispatch());
                } catch (error) {
                  if (abort.signal.aborted) throw error;
                  result = { error: error instanceof Error ? error.message : String(error) };
                }
                const text = JSON.stringify(result) ?? "null";
                outputs.observe([
                  {
                    role: "assistant",
                    content: "",
                    toolCalls: [
                      {
                        id: toolCallId,
                        type: "function",
                        function: { name: tool.name, arguments: JSON.stringify(raw) },
                      },
                    ],
                  },
                  { role: "tool", toolCallId, content: text },
                ]);
                emit({ type: EventType.TOOL_CALL_END, toolCallId });
                emit({
                  type: EventType.TOOL_CALL_RESULT,
                  messageId: randomUUID(),
                  toolCallId,
                  content: text,
                });
                return {
                  content: [{ type: "text", text: outputs.live(toolCallId, contextWindow) }],
                  details:
                    result && typeof result === "object" && (result as { error?: unknown }).error
                      ? { error: String((result as { error: unknown }).error) }
                      : { status: "succeeded" },
                  isError: Boolean(
                    result &&
                      typeof result === "object" &&
                      ((result as { error?: unknown }).error ||
                        (result as { isError?: boolean }).isError),
                  ),
                  ...(!(options.shouldContinue?.() ?? true) ? { terminate: true } : {}),
                };
              },
            })),
            stream: (model, context, streamOptions) => {
              const stream = copied.createAssistantMessageEventStream();
              const message: NativeMessage = {
                role: "assistant",
                content: [],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: zeroUsage(),
                stopReason: "stop",
                timestamp: Date.now(),
              };
              // A native tool receipt may finish or pause the app workflow. The
              // original finalizer receives its standard silent terminal marker;
              // no further provider call is admitted after that owned outcome.
              if (options.initializeOnly || !(options.shouldContinue?.() ?? true)) {
                message.content = [
                  {
                    type: "text",
                    text: options.initializeOnly ? "Runtime initialized." : "NO_REPLY",
                  },
                ];
                queueMicrotask(() => {
                  stream.push({ type: "done", reason: "stop", message });
                  stream.end();
                });
                return stream;
              }
              void (async () => {
                const messages = hostMessages(context.messages, receipts);
                await options.onMessages?.(outputs.restore(messages), "beforeModel");
                await persist();
                let systemPrompts = [
                  context.systemPrompt ?? "",
                  `Current UTC date and time: ${new Date().toISOString()}`,
                ];
                // extraSystemPrompt already put the host instructions in the
                // native prompt. Duplicating them here bypasses OpenClaw's
                // context accounting and can reject an otherwise admitted turn.
                const latest = await options.promptContext?.();
                if (latest) systemPrompts.push(latest);
                const acknowledged =
                  options.finalResponseWhen?.() && options.finalResponseContext
                    ? await options.finalResponseContext()
                    : undefined;
                let responseMessages = messages;
                if (acknowledged) {
                  acknowledgmentBoundary ??= messages.findLast(
                    (message) => message.role === "tool",
                  )?.toolCallId;
                  const boundary = messages.findLastIndex(
                    (message) =>
                      message.role === "tool" && message.toolCallId === acknowledgmentBoundary,
                  );
                  // Replace the task history once, then retain subsequent tool
                  // receipts and errors so acknowledgment attempts can recover.
                  responseMessages = [...acknowledged.messages, ...messages.slice(boundary + 1)];
                }
                if (acknowledged)
                  systemPrompts = [
                    context.systemPrompt ?? "",
                    ...acknowledged.systemPrompts,
                    "Available host capabilities for this completed handoff: " +
                      JSON.stringify(options.finalResponseTools?.() ?? []),
                  ];
                const available = (context.tools ?? []).map((tool) => ({
                  ...tool,
                  name: publicName(tool.name),
                  inputSchema: tool.parameters,
                }));
                const selected = acknowledged
                  ? available.filter(
                      (tool) =>
                        controls.has(tool.name) ||
                        options.finalResponseTools?.().includes(tool.name),
                    )
                  : available;
                const adapter = modelAdapter(
                  options.model,
                  options.fallbacks,
                  options.providers,
                  options.onModelSelected,
                  options.loadBrowserImage,
                  options.loadFileImage,
                  {
                    harnessDeadlineMs: 21_600_000,
                    contextEstimate: (request) =>
                      Math.ceil(
                        1.2 *
                          (copied.estimateMessagesTokens(nativeMessages(request.messages)) +
                            JSON.stringify({
                              prompts: request.systemPrompts,
                              tools: request.tools,
                              schema: request.outputSchema,
                            }).length /
                              4),
                      ) + 4096,
                    workClass: options.workClass,
                    requirements: options.requirements,
                    router: options.modelRouter,
                    onInterrupted: (checkpoint) =>
                      options.onProviderInterrupted?.({
                        ...checkpoint,
                        messages: continuationMessages(messages),
                      }),
                    onFileImageObserved: options.onFileImageObserved,
                  },
                );
                const signal = AbortSignal.any([
                  abort.signal,
                  ...(streamOptions.signal ? [streamOptions.signal] : []),
                ]);
                stream.push({ type: "start", partial: message });
                const calls = new Map<string, { id: string; name: string; args: string }>();
                let text = "";
                for await (const event of adapter.chatStream({
                  model: options.model,
                  messages: responseMessages,
                  systemPrompts,
                  tools: selected,
                  request: { signal },
                  logger: resolveDebugOption(false),
                })) {
                  signal.throwIfAborted();
                  if (event.type === "RUN_ERROR") throw new Error(event.message);
                  if (event.type === "TEXT_MESSAGE_CONTENT") {
                    const blocks = message.content as Array<Record<string, unknown>>;
                    if (!blocks.length) blocks.push({ type: "text", text: "" });
                    text += event.delta;
                    blocks[0].text = text;
                    options.onText?.(event.delta);
                    stream.push({
                      type: "text_delta",
                      contentIndex: 0,
                      delta: event.delta,
                      partial: message,
                    });
                  } else if (event.type === "RUN_FINISHED" && event.usage) {
                    const usage = Array.isArray(event.usage)
                      ? fromSpecTokenUsage(event.usage)
                      : event.usage;
                    if (usage)
                      message.usage = {
                        ...zeroUsage(),
                        input: usage.promptTokens,
                        output: usage.completionTokens,
                        cacheRead: usage.promptTokensDetails?.cachedTokens ?? 0,
                        cacheWrite: usage.promptTokensDetails?.cacheWriteTokens ?? 0,
                        totalTokens: usage.totalTokens,
                      };
                  } else if (event.type === "CUSTOM") emit({ ...event, type: EventType.CUSTOM });
                  else if (event.type === "TOOL_CALL_START")
                    calls.set(event.toolCallId, {
                      id: event.toolCallId,
                      name: event.toolName ?? "unknown",
                      args: "",
                    });
                  else if (event.type === "TOOL_CALL_ARGS") {
                    const call = calls.get(event.toolCallId);
                    if (call) call.args += event.delta;
                  }
                }
                for (const call of calls.values()) {
                  const name = publicName(call.name);
                  let args = hostArguments(JSON.parse(call.args || "{}"), schemas.get(name));
                  if (name === "tool_call" && args && typeof args === "object") {
                    const wrapper = args as Record<string, unknown>;
                    const target = publicName(String(wrapper.id));
                    const key = Object.hasOwn(wrapper, "args") ? "args" : "input";
                    args = { ...wrapper, [key]: hostArguments(wrapper[key], schemas.get(target)) };
                  }
                  (message.content as Array<Record<string, unknown>>).push({
                    type: "toolCall",
                    id: call.id,
                    name: tools.some((tool) => tool.name === name) ? nativeName(name) : call.name,
                    arguments: args,
                  });
                }
                await options.onProviderRecovered?.();
                transportError = undefined;
                message.stopReason = calls.size ? "toolUse" : "stop";
                stream.push({ type: "done", reason: message.stopReason, message });
                stream.end();
              })().catch((error) => {
                transportError = error;
                message.stopReason = abort.signal.aborted ? "aborted" : "error";
                message.errorMessage = error instanceof Error ? error.message : String(error);
                stream.push({ type: "error", reason: message.stopReason, error: message });
                stream.end();
              });
              return stream;
            },
          };
          runs.set(input.runId, host);
          const admission = copied.prepareSystemAgentRunAdmission(
            config,
            input.runId,
            agentId,
            "okami-agent",
            () => abort.signal.throwIfAborted(),
          );
          try {
            const previous = options.compaction
              ? await options.compaction.db.get<SavedSession>(
                  options.compaction.owner,
                  "harness-sessions",
                  agentId,
                )
              : undefined;
            const hashes = converted.messages.map(messageHash);
            const offset =
              previous?.model === options.model && previous.hashes.length
                ? hashes.findIndex((_, index) =>
                    previous.hashes.every((hash, part) => hashes[index + part] === hash),
                  )
                : -1;
            if (offset >= 0 && previous?.receipts)
              for (const [id, receipt] of previous.receipts) receipts.set(id, receipt);
            manager =
              offset >= 0 && previous
                ? copied.SessionManager.fromEntries(previous.entries, workspace)
                : copied.SessionManager.inMemory(workspace);
            const added =
              offset >= 0 && previous
                ? converted.messages.slice(offset + previous.hashes.length)
                : converted.messages;
            // Reuse the original session/compaction tree only when the authoritative
            // app transcript matches it; changed history is seeded afresh.
            for (const message of nativeMessages(added)) await manager.appendMessageAsync(message);
            emit({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
            emit({
              type: EventType.CUSTOM,
              name: "okami.harness",
              value: { runtime: "openclaw", revision: "b56ae70a5e7e302dc2165c96b60214e84e19c7b1" },
            });
            const result = await copied.runEmbeddedAgent({
              preparedRunAdmission: admission,
              config,
              agentId,
              runId: input.runId,
              sessionId: input.threadId,
              sessionKey: `agent:${agentId}:${input.threadId}`,
              agentDir,
              workspaceDir: workspace,
              sessionManager: manager,
              sessionPersistence: "detached",
              suppressNextUserMessagePersistence: true,
              provider: "okami",
              model: "configured",
              prompt: textContent(
                nativeMessages(converted.messages).findLast(
                  (message) => message.role === "user",
                ) ?? {
                  role: "user",
                  content: "Continue the accepted request from its recorded tool receipts.",
                },
              ),
              extraSystemPrompt: options.prompt,
              timeoutMs: 21600000,
              abortSignal: abort.signal,
              toolBindings: { okamiRunId: input.runId },
              onAgentEvent: (event: { stream: string; data: Record<string, unknown> }) => {
                if (event.stream === "assistant" && typeof event.data.delta === "string") {
                  if (!messageId) {
                    messageId = randomUUID();
                    emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" });
                  }
                  emit({
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId,
                    delta: event.data.delta,
                  });
                }
                if (event.stream === "tool" && event.data.phase === "start" && messageId) {
                  emit({ type: EventType.TEXT_MESSAGE_END, messageId });
                  messageId = undefined;
                }
                if (event.stream === "tool" && controls.has(String(event.data.name)))
                  emit({ type: EventType.CUSTOM, name: "okami.harness.tool", value: event.data });
                if (["compaction", "lifecycle"].includes(event.stream))
                  emit({
                    type: EventType.CUSTOM,
                    name: `okami.harness.${event.stream}`,
                    value: event.data,
                  });
              },
            });
            if (messageId) emit({ type: EventType.TEXT_MESSAGE_END, messageId });
            if (transportError && (options.shouldContinue?.() ?? true)) throw transportError;
            if (result.meta.error && (options.shouldContinue?.() ?? true))
              throw new Error(result.meta.error.message ?? "The copied harness failed");
            if (result.meta.aborted) abort.signal.throwIfAborted();
            await persist();
            emit({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId });
            subscriber.complete();
          } finally {
            admission.close();
            runs.delete(input.runId);
          }
        })().catch((error) => {
          emit({
            type: EventType.RUN_ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          subscriber.complete();
        });
        active.set(input.runId, { dataDir: options.dataDir, abort, completion });
        void completion.finally(() => active.delete(input.runId));
        return () => {
          abort.abort();
          if (controller === abort) controller = undefined;
        };
      });
    },
  };
}
