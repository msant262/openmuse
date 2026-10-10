import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type { CompletionCriterion } from "../../../../packages/domain/src/runtime.ts";

export const PYTHON_SESSION_CRITERION = "requested-python-session";

/** Qualify an explicit interpreter instruction, not a topic or quoted code.
 * Undefined leaves the current request intact; false is an explicit refusal. */
function instruction(text: string): boolean | undefined {
  const unquoted = text.replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|'[^'\n]*'|`[^`\n]*`/g, " ");
  let requested: boolean | undefined;
  for (const clause of unquoted.split(/[.!?;\n]/)) {
    if (/^\s*(?:explique|explain|descreva|describe|traduza|translate)\b/i.test(clause)) continue;
    const session = /\b(?:sess[aã]o\s+(?:de\s+)?python\w*|python\w*\s+(?:session|kernel))\b/i.test(
      clause,
    );
    for (const verb of clause.matchAll(
      /\b(?:use|usar|usa|utilize|utilizar|utiliza|using|usando|continue|calcule|calculate|compute|execute|run|rode|rodar|guarde|salve|save|store|keep)\b/gi,
    )) {
      const position = verb.index;
      const before = clause.slice(0, position);
      const after = clause.slice(position, position + 160);
      if (!/\bpython\w*\b/i.test(after) && !(session && /\bpython\w*\b/i.test(before.slice(-160))))
        continue;
      if (
        /^(?:execute|run|rode|rodar)$/i.test(verb[0]) &&
        !session &&
        !/\b(?:function|fun[çc][aã]o)\b/i.test(after)
      )
        continue;
      if (/^(?:guarde|salve|save|store|keep)$/i.test(verb[0]) && !session) continue;
      if (/\b(?:how\s+to|como)\s*$/i.test(before)) continue;
      requested = !/(?:n[aã]o|never|not|don't|do not|without|sem)(?:\s+\S+){0,3}\s*$/i.test(before);
    }
  }
  return requested;
}

export function requestedPythonSession(
  task: Pick<AgentTask, "prompt"> & { state?: AgentTask["state"] },
) {
  let requested = instruction(task.prompt);
  const directions = task.state?.directives;
  if (Array.isArray(directions))
    for (const direction of directions) {
      if (!direction || typeof direction !== "object" || typeof direction.text !== "string")
        continue;
      const next = instruction(direction.text);
      if (next !== undefined) requested = next;
    }
  return requested;
}

export function pythonTaskCriteria(
  task: Pick<AgentTask, "prompt"> & { state?: AgentTask["state"] },
  criteria: CompletionCriterion[],
): CompletionCriterion[] {
  const requested = requestedPythonSession(task);
  if (requested === undefined) return criteria;
  const retained = criteria.filter((c) => c.id !== PYTHON_SESSION_CRITERION);
  if (requested) {
    return [
      ...retained.filter((c) => c.id !== "observed-result"),
      {
        id: PYTHON_SESSION_CRITERION,
        kind: "receipt",
        effect: "command",
        description:
          "Execute the requested persistent Python session and retain its actual results. A direct tool call, ordinary shell command, JavaScript result or source-code example does not prove execution in that session.",
        requiredItems: [],
      },
    ];
  }
  return retained.length
    ? retained
    : [
        {
          id: "observed-result",
          kind: "observation",
          requiredItems: [],
          description: "The requested outcome has current observed evidence",
        },
      ];
}

export function pythonRequestContext(
  task: Pick<AgentTask, "prompt"> & { state?: AgentTask["state"] },
  available: boolean,
) {
  if (!requestedPythonSession(task)) return "";
  return available
    ? "\nThe requested Python session is available through execute_code(language=python). Use its retained namespace for the requested work and store the actual returned results there. import hermes_tools; hermes_tools.list() shows this cell's tools; hermes_tools.call(name, args) invokes their ordinary host dispatcher, including Google tool discovery and execution. Use these callbacks for the requested tool work instead of merely preparing payloads in Python and silently switching to direct tools. Respect ordinary approvals. If a review stops the kernel, its state is lost; continue from the host receipts in a fresh cell. Reuse already confirmed effects and store their observed results; never repeat them to satisfy this runtime requirement. Report actual session variables/results, not a promise to retain them.\n"
    : "\nThe requested Python session is unavailable on the connected executor. The current execute_code schema cannot run that interpreter. Report this concrete limitation as a partial result; do not silently replace the requested session with JavaScript, an ordinary shell process or a claimed stored result.\n";
}
