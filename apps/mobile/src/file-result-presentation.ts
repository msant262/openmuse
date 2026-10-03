/** Exit failures remain visible even when the tool returned useful attachments. */
export function fileResultPresentation(
  value: Record<string, unknown> | undefined,
  loading: boolean,
) {
  const text = (entry: unknown) => (typeof entry === "string" ? entry : "");
  const exitCode =
    typeof value?.exitCode === "number"
      ? value.exitCode
      : typeof value?.exit_code === "number"
        ? value.exit_code
        : undefined;
  const failure = Boolean(
    text(value?.error) ||
      value?.status === "failed" ||
      value?.success === false ||
      (exitCode !== undefined && exitCode !== 0),
  );
  return {
    failure,
    title: loading
      ? "Working on your computer…"
      : value?.disabled
        ? "Tool unavailable"
        : failure
          ? "Needs attention"
          : value?.status === "running"
            ? "Job running"
            : "Computer result",
    message: text(value?.error) || text(value?.message),
    stdout: text(value?.stdout),
    stderr: text(value?.stderr),
    command: text(value?.command),
    exitCode,
  };
}
