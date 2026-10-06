// Copied/adapted from OpenClaw b56ae70a5e7e302dc2165c96b60214e84e19c7b1 (MIT).
// Copyright (c) 2026 OpenClaw Foundation. See third_party/openclaw/LICENSE.
// Portable dependency adapters; retain upstream normalization and set ordering.
export function localeLowercasePreservingWhitespace(value: string): string {
  return value.toLocaleLowerCase();
}
export function normalizeLowercaseStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
export function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set(values)];
}
