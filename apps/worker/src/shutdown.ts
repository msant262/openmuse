// Worker-owned signal handling keeps Playwright alive until profiles have flushed.
export function installShutdownHandlers(close: () => Promise<void>, timeoutMs = 30_000) {
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => {
      console.error("Browser worker shutdown timed out before profiles could be saved.");
      process.exit(1);
    }, timeoutMs);
    try {
      await close();
      clearTimeout(deadline);
      process.exit(0);
    } catch {
      clearTimeout(deadline);
      console.error("Browser worker shutdown failed; profiles may not be fully saved.");
      process.exit(1);
    }
  }
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
    process.on(signal, () => void stop());
}
