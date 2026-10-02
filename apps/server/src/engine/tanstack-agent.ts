import { randomUUID } from "node:crypto";
import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/core";
import {
  BuiltInAgent,
  convertInputToTanStackAI,
  defineTool,
  type ToolDefinition,
} from "@copilotkit/runtime/v2";
import { chat, maxIterations, type SchemaInput, toolDefinition } from "@tanstack/ai";
import { finalize, map, mergeMap, type Observable } from "rxjs";
import { z } from "zod";
import type { BrowserImageLoader } from "../providers/browser-images.ts";
import type { ModelProviderConfig } from "../providers/config.ts";
import type { ModelSelection } from "../providers/models.ts";
import { modelAdapter } from "../providers/models.ts";

export { unknownProvider } from "../providers/models.ts";

// The classic BuiltInAgent always offers these two state tools. The converter turns their
// results into STATE_SNAPSHOT / STATE_DELTA events.
const stateTools = [
  defineTool({
    name: "AGUISendStateSnapshot",
    description: "Replace the entire application state with a new snapshot",
    parameters: z.object({ snapshot: z.any().describe("The complete new state object") }),
    execute: async ({ snapshot }) => ({ success: true, snapshot }),
  }),
  defineTool({
    name: "AGUISendStateDelta",
    description: "Apply incremental updates to application state using JSON Patch operations",
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
  tools: ToolDefinition[];
  prompt: string;
  /** The process owner joins tool receipts after an observable is canceled. */
  trackTool?: (execute: () => Promise<unknown>) => Promise<unknown>;
  loadBrowserImage?: BrowserImageLoader;
  loadFileImage?: BrowserImageLoader;
  onModelSelected?: (model: ModelSelection) => void;
  /** Said when the step limit, not the model, ends a run; otherwise the reply just stops. */
  stepLimitNote?: string;
}) {
  // Runtime 1.70's TanStack converter drops CUSTOM chunks; relay provider attribution here.
  const modelNotices = new Map<string, BaseEvent[]>();
  const agent = new BuiltInAgent({
    type: "tanstack",
    factory: ({ input, abortController }) => {
      const converted = convertInputToTanStackAI(input);
      // Build the system prompt like the classic mode. It does not forward system messages.
      let system = options.prompt;
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
        ),
        messages: converted.messages,
        systemPrompts: system ? [system] : [],
        tools: [
          ...converted.tools,
          ...[...options.tools, ...stateTools].map((tool) =>
            toolDefinition({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.parameters as SchemaInput,
            }).server((args) => {
              const execute = () => (tool.execute as (args: unknown) => Promise<unknown>)(args);
              return options.trackTool ? options.trackTool(execute) : execute();
            }),
          ),
        ],
        agentLoopStrategy: maxIterations(options.maxSteps),
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
    return options.stepLimitNote
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
