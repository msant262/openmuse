import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";

type HostTool = {
  name: string;
  description: string;
  parameters: unknown;
  execute: (id: string, input: unknown, fullResult?: boolean) => Promise<unknown>;
};
export type PythonExecutionRuntime = {
  execute(input: {
    code: string;
    reset: boolean;
    wallClockMs: number;
    maxToolCalls: number;
    tools: HostTool[];
    signal: AbortSignal;
    shouldContinue: () => boolean;
  }): Promise<unknown>;
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
  /^(search_(web|saved_files|drive|gmail|calendar|past_threads|google_workspace_tools|app_tools)|read_|get_|list_|skills_(list|search|read)$|web_(fetch|extract)$|computer_status$|browser_get_images$)/;

export function codeExecutionTool(options: {
  runtime: CodeExecutionRuntime;
  pythonRuntime?: PythonExecutionRuntime;
  tools: () => HostTool[];
  allowEffects?: boolean;
  runId: string;
  sessionId: string;
  signal: AbortSignal;
  shouldContinue: () => boolean;
}) {
  const parameters = z.object({
    code: z.string().min(1).max(200_000),
    language: (options.pythonRuntime
      ? z.enum(["javascript", "python"])
      : z.literal("javascript")
    ).default("javascript"),
    resetPython: z.boolean().default(false),
    wallClockMs: z.number().int().min(100).max(900_000).default(300_000),
    maxToolCalls: z.number().int().min(1).max(200).default(100),
  });
  return defineTool({
    name: "execute_code",
    description: `Execute code to batch authorized tools and calculate over their actual results. JavaScript is isolated: call a discovered tool as await tool_name(args); API.list() and API.read(name) expose only this run's catalog. Return the calculated value; text(value) emits output. ${options.pythonRuntime ? "Python runs persistently on the owner's native computer: use language=python, normal imports and print; import hermes_tools; hermes_tools.list() lists this cell's tools and hermes_tools.call(name, args) calls one synchronously; from hermes_tools import tool_name also works as tool_name(args). Python globals persist in this conversation; resetPython discards them. The native workspace is /workspace. A review/input pause stops the interpreter and loses its globals; resume from host receipts with a new cell, never replay pending effects. " : ""}${options.allowEffects ? "Task actions use their ordinary approval policy; code never supplies approval. When a tool pauses for review/input, stop and return its receipt." : "Only read tools are exposed; use direct tools for all writes/approvals."} Use direct tools for simple lookups. JavaScript has no imports, server filesystem, process or credentials. No recursive execute_code. Every child call gets its own ordinary dispatch receipt. A script result alone does not attach a document or finish a task; finish the task after the cell returns.`,
    parameters,
    execute: async (input) => {
      // The copied host calls execute directly; it does not apply Zod defaults.
      // Normalize before a native dispatch can acquire a physical intention.
      const { code, language, resetPython, wallClockMs, maxToolCalls } = parameters.parse(input);
      const entries = options
        .tools()
        .filter(
          (tool) =>
            tool.name !== "execute_code" &&
            (language !== "python" || tool.name !== "finish_task") &&
            (options.allowEffects || readTool.test(tool.name)),
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
      if (language === "python") {
        if (!options.pythonRuntime)
          throw new Error("Native Python is unavailable on this executor.");
        return options.pythonRuntime.execute({
          code,
          reset: resetPython,
          wallClockMs,
          maxToolCalls,
          tools: entries.map((entry) => entry.tool),
          signal: options.signal,
          shouldContinue: options.shouldContinue,
        });
      }
      if (resetPython) throw new Error("resetPython applies only to language=python.");
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
