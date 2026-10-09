import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";

type HostTool = {
  name: string;
  description: string;
  parameters: unknown;
  execute: (id: string, input: unknown, fullResult?: boolean) => Promise<unknown>;
};
export type CodeExecutionRuntime = {
  runCodeModeScriptHeadless(params: {
    ctx: {
      sessionId: string;
      runId: string;
      abortSignal: AbortSignal;
      catalogRef: {
        current: {
          entries: Array<{
            id: string;
            source: "openclaw";
            name: string;
            description: string;
            parameters: unknown;
            tool: HostTool;
          }>;
          counterScope: string;
          searchCount: number;
          describeCount: number;
          callCount: number;
        };
      };
    };
    code: string;
    signal: AbortSignal;
    wallClockMs: number;
    maxToolCalls: number;
  }): Promise<unknown>;
};

// Foreground code has a read catalog. Authorized task code may use the task's
// ordinary tools too: each call retains host dispatch, ownership and approval.
// Neither mode receives server fs/process, raw credentials or recursive code.
const readTool =
  /^(search_(web|saved_files|drive|gmail|calendar|past_threads|google_workspace_tools|app_tools)|read_|get_|list_|skills_(list|search|read)$|web_(fetch|extract)$|computer_status$)/;

export function codeExecutionTool(options: {
  runtime: CodeExecutionRuntime;
  tools: () => HostTool[];
  allowEffects?: boolean;
  runId: string;
  sessionId: string;
  signal: AbortSignal;
  shouldContinue: () => boolean;
}) {
  return defineTool({
    name: "execute_code",
    description: `Execute isolated JavaScript to batch authorized tools and calculate over their actual results. Call a discovered tool as await tool_name(args); API.list() and API.read(name) expose only this run's catalog. Return the calculated value; text(value) emits output. ${options.allowEffects ? "Task actions use their ordinary approval policy; code never supplies approval. When a tool pauses for review/input, stop and return its receipt." : "Only read tools are exposed; use direct tools for all writes/approvals."} Use direct tools for simple lookups. No imports, server filesystem, process, credentials, or recursive execute_code. Shell work is available only through the owner's ordinary computer tools when listed. Every child call gets its own ordinary dispatch receipt. A script result alone does not attach a document or finish a task.`,
    parameters: z.object({
      code: z.string().min(1).max(200_000),
      wallClockMs: z.number().int().min(100).max(900_000).default(300_000),
      maxToolCalls: z.number().int().min(1).max(200).default(100),
    }),
    execute: async ({ code, wallClockMs, maxToolCalls }) => {
      const entries = options
        .tools()
        .filter(
          (tool) =>
            tool.name !== "execute_code" && (options.allowEffects || readTool.test(tool.name)),
        )
        .map((tool) => ({
          id: tool.name,
          source: "openclaw" as const,
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          tool: {
            ...tool,
            execute: async (id: string, input: unknown) => {
              options.signal.throwIfAborted();
              if (!options.shouldContinue())
                throw new Error(
                  "The task has paused or finished; no further child calls are allowed.",
                );
              return tool.execute(id, input, true);
            },
          },
        }));
      return options.runtime.runCodeModeScriptHeadless({
        ctx: {
          sessionId: options.sessionId,
          runId: options.runId,
          abortSignal: options.signal,
          catalogRef: {
            current: {
              entries,
              counterScope: options.runId,
              searchCount: 0,
              describeCount: 0,
              callCount: 0,
            },
          },
        },
        code,
        wallClockMs,
        maxToolCalls,
        signal: options.signal,
      });
    },
  });
}
