import { randomUUID } from "node:crypto";
import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/core";
import {
  BuiltInAgent,
  convertInputToTanStackAI,
  defineTool,
  type ToolDefinition,
} from "@copilotkit/runtime/v2";
import {
  type ChatMiddleware,
  type ChatMiddlewareConfig,
  type ChatMiddlewareContext,
  chat,
  type ModelMessage,
  maxIterations,
  type SchemaInput,
  toolDefinition,
} from "@tanstack/ai";
import { finalize, map, mergeMap, type Observable } from "rxjs";
import { z } from "zod";
import type { ModelRequirements, WorkClass } from "../../../../packages/domain/src/runtime.ts";
import { modelAdmission } from "../providers/admission-diagnostics.ts";
import type { BrowserImageLoader } from "../providers/browser-images.ts";
import type { ModelProviderConfig } from "../providers/config.ts";
import { ModelUnavailableError } from "../providers/errors.ts";
import { type ModelRouter, sharedModelRouter } from "../providers/model-router.ts";
import type { ModelSelection, ProviderContinuationCheckpoint } from "../providers/models.ts";
import { continuationMessages, modelAdapter } from "../providers/models.ts";
import { ContextBudget, type ContextModelResolver } from "./context-budget.ts";
import { harnessToolCatalog } from "./harness-tool-catalog.ts";
import { ToolDiscovery } from "./tool-discovery.ts";
import { ToolOutputStore } from "./tool-output.ts";
import { ToolProgress } from "./tool-progress.ts";

export { unknownProvider } from "../providers/models.ts";

// The classic BuiltInAgent always offers these two state tools. The converter turns their
// results into STATE_SNAPSHOT / STATE_DELTA events.
const stateTools = [
  defineTool({
    ...harnessToolCatalog[1],
    parameters: z.object({ snapshot: z.any().describe("The complete new state object") }),
    execute: async ({ snapshot }) => ({ success: true, snapshot }),
  }),
  defineTool({
    ...harnessToolCatalog[2],
    parameters: z.object({
      delta: z
        .array(
          z.object({
            op: z.enum(["add", "replace", "remove"]).describe("The operation to perform"),
            path: z.string().describe("JSON Pointer path (e.g., '/foo/bar')"),
            value: z
              .any()
              .optional()
              .describe(
                "The value to set. Required for 'add' and 'replace' operations, ignored for 'remove'.",
              ),
          }),
        )
        .describe("Array of JSON Patch operations"),
    }),
    execute: async ({ delta }) => ({ success: true, delta }),
  }),
];

/** A BuiltInAgent in TanStack factory mode with the options of the classic AI SDK mode. */
export function tanstackAgent(options: {
  model: string;
  fallbacks?: readonly string[];
  providers?: ModelProviderConfig;
  maxSteps: number;
  /** Reserve the last allowed model turn for a chat answer without any tools. */
  finalResponseOnStepLimit?: boolean;
  /** A successful handoff finishes the foreground turn without polling its worker. */
  finalResponseWhen?: () => boolean;
  finalResponsePrompt?: () => string | undefined;
  /** Compose a receipt-backed reply with a bounded context, retaining the canonical journal. */
  finalResponseContext?: () => Promise<
    { systemPrompts: string[]; messages: ModelMessage[] } | undefined
  >;
  /** Reserve the preceding turn for handing unfinished work to a durable worker. */
  handoffBeforeFinalResponse?: {
    tools: () => readonly string[];
    prompt: string;
  };
  tools: ToolDefinition[];
  prompt: string;
  /** Re-read trusted profile/steering at each model safe point without restarting work. */
  promptContext?: () => Promise<string>;
  /** M5 supplies actual compatible/fallback capacity; never choose another provider here. */
  contextModel?: ContextModelResolver;
  requiredOperationIds?: () => Promise<readonly string[]>;
  /** The process owner joins tool receipts after an observable is canceled. */
  trackTool?: (execute: () => Promise<unknown>) => Promise<unknown>;
  executeTool?: (
    call: { id: string; toolCallId: string; name: string; args: unknown },
    execute: () => Promise<unknown>,
  ) => Promise<unknown>;
  onMessages?: (messages: ModelMessage[], phase: string) => Promise<void>;
  /** Observe accepted model text before downstream stream buffering and the next loop decision. */
  onText?: (delta: string) => void;
  shouldContinue?: () => boolean;
  onStepLimit?: () => void;
  loadBrowserImage?: BrowserImageLoader;
  loadFileImage?: BrowserImageLoader;
  onFileImageObserved?: (fileId: string) => Promise<void>;
  onModelSelected?: (model: ModelSelection) => void;
  /** Said when the step limit, not the model, ends a run; otherwise the reply just stops. */
  stepLimitNote?: string;
  workClass?: WorkClass;
  requirements?: Partial<ModelRequirements>;
  modelRouter?: ModelRouter;
  onProviderInterrupted?: (checkpoint: ProviderContinuationCheckpoint) => Promise<void> | void;
}) {
  // Runtime 1.70's TanStack converter drops CUSTOM chunks; relay provider attribution here.
  const modelNotices = new Map<string, BaseEvent[]>();
  const agent = new BuiltInAgent({
    type: "tanstack",
    factory: ({ input, abortController }) => {
      const converted = convertInputToTanStackAI(input);
      const discovery = new ToolDiscovery(options.tools);
      const discoveryTools = discovery.tools();
      let canonicalMessages = converted.messages;
      const outputStore = new ToolOutputStore();
      const progress = new ToolProgress();
      const progressWarnings = new Set<string>();
      const outputTool = defineTool({
        ...harnessToolCatalog[0],
        parameters: z.object({
          toolCallId: z.string().min(1).max(500),
          part: z.enum(["result", "arguments"]).default("result"),
          offset: z.number().int().nonnegative().default(0),
          limit: z.number().int().min(2).max(8000).default(4000),
        }),
        execute: async (args) => outputStore.read(args),
      });
      // Build the system prompt like the classic mode. It does not forward system messages.
      let system = `Current UTC date and time: ${new Date().toISOString()}\n${options.prompt}`;
      if (input.context.length) {
        system += "\n## Context from the application\n";
        for (const ctx of input.context) system += `${ctx.description}:\n${ctx.value}\n`;
      }
      if (
        input.state !== undefined &&
        input.state !== null &&
        !(typeof input.state === "object" && Object.keys(input.state).length === 0)
      )
        system += `\n## Application State\nThis is state from the application that you can edit by calling AGUISendStateSnapshot or AGUISendStateDelta.\n\`\`\`json\n${JSON.stringify(input.state, null, 2)}\n\`\`\`\n`;
      return chat({
        // Errors surface through AG-UI; SDK debug logging can include raw provider payloads.
        debug: false,
        adapter: modelAdapter(
          options.model,
          options.fallbacks,
          options.providers,
          (model) => {
            options.onModelSelected?.(model);
            if (model.fallback)
              modelNotices.set(input.runId, [
                ...(modelNotices.get(input.runId) ?? []),
                {
                  type: EventType.CUSTOM,
                  name: "openmuse.model",
                  value: model,
                },
              ]);
          },
          options.loadBrowserImage,
          options.loadFileImage,
          {
            projectTools: (tools) => discovery.select(tools),
            workClass: options.workClass,
            requirements: options.requirements,
            router: options.modelRouter,
            // The adapter sees a bounded provider view. Persist canonical tool
            // arguments so a new process can page superseded document sources.
            onInterrupted: (checkpoint) =>
              options.onProviderInterrupted?.({
                ...checkpoint,
                messages: continuationMessages(canonicalMessages),
              }),
            onFileImageObserved: options.onFileImageObserved,
          },
        ),
        messages: converted.messages,
        systemPrompts: system ? [system] : [],
        middleware: [
          {
            name: "openmuse-context",
            onChunk: (_ctx, chunk) => {
              if (chunk.type === "TEXT_MESSAGE_CONTENT") options.onText?.(chunk.delta);
            },
            onConfig: async (ctx: ChatMiddlewareContext, config: ChatMiddlewareConfig) => {
              canonicalMessages = config.messages;
              await options.onMessages?.(config.messages, ctx.phase);
              outputStore.observe(config.messages);
              progress.observe(config.messages);
              discovery.restore(config.messages);
              let systemPrompts = [system];
              if (progressWarnings.size) {
                systemPrompts.push([...progressWarnings].join("\n"));
                progressWarnings.clear();
              }
              const finalResponse =
                Boolean(options.finalResponseWhen?.()) ||
                (options.finalResponseOnStepLimit && ctx.iteration >= options.maxSteps - 1);
              const handoff =
                options.finalResponseOnStepLimit &&
                !finalResponse &&
                ctx.iteration >= options.maxSteps - 2
                  ? options.handoffBeforeFinalResponse
                  : undefined;
              const handoffTools = handoff?.tools();
              const dispatchTools = finalResponse
                ? []
                : handoffTools
                  ? config.tools.filter((tool) => handoffTools.includes(tool.name))
                  : config.tools;
              const tools = discovery.select(dispatchTools);
              if (handoff) systemPrompts.push(handoff.prompt);
              if (finalResponse)
                systemPrompts.push(
                  options.finalResponsePrompt?.() ??
                    "This is the final response for this chat run. Tools are unavailable. Answer the user's request now using the observations already returned. Cite source URLs for verified details and prices. If research is incomplete, give the useful verified results and briefly explain what could not be verified. Do not invent findings or claim that pending delegated work has finished. Do not ask more questions or ask the user to say continue, restart, or repeat the request.",
                );
              const promptContext = await options.promptContext?.();
              if (promptContext) systemPrompts.push(promptContext);
              const responseContext = finalResponse
                ? await options.finalResponseContext?.()
                : undefined;
              if (responseContext) systemPrompts = responseContext.systemPrompts;
              const requiredOperationIds = (await options.requiredOperationIds?.()) ?? [];
              const projected = outputStore.project(
                responseContext?.messages ?? config.messages,
                requiredOperationIds,
              );
              const toolDependencies = outputStore.dependencies();
              const observations = ContextBudget.observations(projected);
              const imageContextTokens = options.providers?.routing?.imageContextTokens ?? 8192;
              const requirements = options.contextModel
                ? {
                    tools: Boolean(tools.length),
                    vision: ContextBudget.currentVision(projected, observations),
                    structuredOutput: false,
                    contextTokens: ContextBudget.minimumTokens(projected, {
                      systemPrompts,
                      tools,
                      requiredOperationIds,
                      toolDependencies,
                      observations,
                      imageContextTokens,
                    }),
                  }
                : undefined;
              let model: ReturnType<ContextModelResolver>;
              try {
                model = requirements ? options.contextModel?.(requirements) : undefined;
              } catch (error) {
                if (error instanceof ModelUnavailableError)
                  await options.onProviderInterrupted?.({
                    version: 1,
                    messages: continuationMessages(config.messages),
                    partialText: "",
                    rejectedModel: options.model,
                    accepted: false,
                    code: error.code,
                    admission:
                      requirements &&
                      modelAdmission(
                        "context_projection",
                        requirements,
                        [options.model, ...(options.fallbacks ?? [])],
                        options.modelRouter ??
                          (options.providers && sharedModelRouter(options.providers)),
                        undefined,
                        ContextBudget.minimumDiagnostics(projected, {
                          systemPrompts,
                          tools,
                          requiredOperationIds,
                          toolDependencies,
                          observations,
                          imageContextTokens,
                        }),
                      ),
                  });
                throw error;
              }
              return {
                systemPrompts,
                tools: dispatchTools,
                providerMessages: model
                  ? ContextBudget.limit(projected, {
                      model,
                      systemPrompts,
                      tools,
                      requiredOperationIds,
                      toolDependencies,
                      observations,
                    })
                  : projected,
              };
            },
          },
        ] as ChatMiddleware[],
        tools: [
          ...converted.tools,
          ...[...options.tools, ...discoveryTools, outputTool, ...stateTools].map((tool) =>
            toolDefinition({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.parameters as SchemaInput,
            }).server((args, context) => {
              const execute = () => (tool.execute as (args: unknown) => Promise<unknown>)(args);
              const dispatch = async () => {
                abortController.signal.throwIfAborted();
                const observation = progress.check(tool.name, args);
                if (observation?.blocked) {
                  const veto = {
                    skipped: true,
                    dispatched: false,
                    code: "TOOL_NO_PROGRESS",
                    message: observation.message,
                  };
                  progress.record(tool.name, args, veto);
                  return veto;
                }
                if (observation) progressWarnings.add(observation.message);
                const result = await (options.executeTool
                  ? options.executeTool(
                      {
                        id: `${input.runId}:${context?.toolCallId ?? randomUUID()}`,
                        toolCallId: context?.toolCallId ?? randomUUID(),
                        name: tool.name,
                        args,
                      },
                      execute,
                    )
                  : execute());
                progress.record(tool.name, args, result);
                return result;
              };
              const admitted = () => progress.exclusive(tool.name, args, dispatch);
              return options.trackTool ? options.trackTool(admitted) : admitted();
            }),
          ),
        ],
        agentLoopStrategy: (state) => {
          if (!(options.shouldContinue?.() ?? true)) return false;
          const allowed = maxIterations(options.maxSteps)(state);
          if (!allowed) options.onStepLimit?.();
          return allowed;
        },
        abortController,
      });
    },
  });
  const run = agent.run.bind(agent);
  agent.run = (input: RunAgentInput) => {
    const attributed = run(input).pipe(
      mergeMap((event): BaseEvent[] => {
        const notices = modelNotices.get(input.runId) ?? [];
        modelNotices.delete(input.runId);
        return [...notices, event];
      }),
      finalize(() => modelNotices.delete(input.runId)),
    );
    const events = splitTextAtToolCalls(attributed);
    return options.stepLimitNote && !options.finalResponseOnStepLimit
      ? reportStepLimit(events, options.maxSteps, options.stepLimitNote)
      : events;
  };
  return agent;
}

/**
 * maxIterations ends the loop after the last allowed tool step without a final model reply.
 * When a run ends that way, add a short assistant message so it does not stop silently.
 */
export function reportStepLimit(events: Observable<BaseEvent>, maxSteps: number, note: string) {
  let steps = 0;
  let phase: "text" | "calling" | "results" = "text";
  return events.pipe(
    mergeMap((event): BaseEvent[] => {
      if (event.type === EventType.TOOL_CALL_START) {
        // Parallel calls of one model step arrive together; results end the step.
        if (phase !== "calling") steps++;
        phase = "calling";
      } else if (event.type === EventType.TOOL_CALL_RESULT) phase = "results";
      else if (event.type === EventType.TEXT_MESSAGE_CHUNK) phase = "text";
      else if (event.type === EventType.RUN_FINISHED && phase === "results" && steps >= maxSteps)
        return [
          {
            type: EventType.TEXT_MESSAGE_CHUNK,
            messageId: randomUUID(),
            role: "assistant",
            delta: note,
          } as BaseEvent,
          event,
        ];
      return [event];
    }),
  );
}

// ponytail: the TanStack converter in @copilotkit/runtime 1.70.1 uses one message ID for the
// whole run. Remove this when it starts a new ID for each step, like the classic mode does.
// Text after a tool call gets a new message ID, so each step's text is a separate message.
function splitTextAtToolCalls(events: Observable<BaseEvent>) {
  let messageId: string | undefined;
  let afterToolCall = false;
  return events.pipe(
    map((event) => {
      if (event.type === EventType.TEXT_MESSAGE_CHUNK) {
        if (!messageId || afterToolCall) messageId = randomUUID();
        afterToolCall = false;
        return { ...event, messageId };
      }
      if (event.type === EventType.TOOL_CALL_START) {
        afterToolCall = true;
        return messageId ? { ...event, parentMessageId: messageId } : event;
      }
      if (event.type === EventType.TOOL_CALL_RESULT) afterToolCall = true;
      return event;
    }),
  );
}
