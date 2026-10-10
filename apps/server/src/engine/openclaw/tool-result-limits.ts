// Adapted from OpenClaw da979df299e88c3711f6ee2cd3c7443dd045584b (MIT).
// Copyright (c) 2026 OpenClaw Foundation. See third_party/openclaw/LICENSE.
// Portable cap functions only; byte-based admission remains in ContextBudget.
/** Automatic live tool-result caps derived from the effective model context. */

const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3;

export const DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS = 16_000;
const LIVE_TOOL_RESULT_CONTEXT_SHARE = 0.08;

export function resolveAutoLiveToolResultMaxChars(contextWindowTokens: number): number {
  if (!Number.isFinite(contextWindowTokens)) {
    return DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS;
  }
  return Math.max(
    DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
    Math.floor(contextWindowTokens * LIVE_TOOL_RESULT_CONTEXT_SHARE * 4),
  );
}

export function calculateMaxToolResultCharsWithCap(
  contextWindowTokens: number,
  hardCapChars: number,
): number {
  const maxTokens = Math.floor(contextWindowTokens * MAX_TOOL_RESULT_CONTEXT_SHARE);
  const maxChars = maxTokens * 4;
  return Math.min(maxChars, Math.max(1, hardCapChars));
}

export function resolveLiveToolResultMaxChars(params: { contextWindowTokens: number }): number {
  return calculateMaxToolResultCharsWithCap(
    params.contextWindowTokens,
    resolveAutoLiveToolResultMaxChars(params.contextWindowTokens),
  );
}
