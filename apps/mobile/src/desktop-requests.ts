/** Only reads can be superseded. Native input retains its original single request. */
export async function readDesktop<T>(
  request: (signal: AbortSignal) => Promise<T>,
  timeout = 12_000,
  superseded?: AbortSignal,
): Promise<T> {
  const interrupted = () => new Error("Desktop preview interrupted");
  // React Native's AbortSignal implements aborted/events, but may lack
  // throwIfAborted and reason. Keep our cancellation reason independently.
  if (superseded?.aborted) throw superseded.reason ?? interrupted();
  const controller = new AbortController();
  let abortReason: unknown;
  const abort = (reason: unknown) => {
    abortReason = reason;
    controller.abort(reason);
  };
  const cancel = () => abort(superseded?.reason ?? interrupted());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectCancelled = () => {};
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancelled = () => reject(abortReason);
      controller.signal.addEventListener("abort", rejectCancelled);
    });
    superseded?.addEventListener("abort", cancel);
    timer = setTimeout(
      () => abort(new Error("Desktop preview timed out. Retrying the connection…")),
      timeout,
    );
    return await Promise.race([request(controller.signal), cancelled]);
  } finally {
    if (timer) clearTimeout(timer);
    superseded?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", rejectCancelled);
  }
}
