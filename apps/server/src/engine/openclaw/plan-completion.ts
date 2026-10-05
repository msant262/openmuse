// Adapted from OpenClaw b56ae70a5e7e302dc2165c96b60214e84e19c7b1,
// embedded-agent-runner/run/attempt-stream-prepare.ts and terminal-retry-state.ts.
// MIT; see third_party/openclaw/LICENSE. Host stop/lease checks remain in model.ts.
export type EmbeddedRunCompletionCheck = { unfinishedPlan: boolean; checked: boolean };
export const PLAN_COMPLETION_FOLLOWUP =
  "This run’s latest successfully saved plan still has unfinished steps. Before ending, check whether those steps remain required and authorized under the latest user instructions. Continue feasible work from the current transcript; do not repeat completed actions, and reconcile uncertain effects before retrying. If work is complete, reconcile the plan. If user input, approval, an external dependency, or an explicit pause prevents further work, report that concrete limitation. Do not invent completion or new authority.";

/** One same-prompt follow-up, consumed across retries; never rewind the transcript. */
export function consumePlanCompletionCheck(check: EmbeddedRunCompletionCheck) {
  if (!check.unfinishedPlan || check.checked) return undefined;
  check.checked = true;
  return PLAN_COMPLETION_FOLLOWUP;
}
