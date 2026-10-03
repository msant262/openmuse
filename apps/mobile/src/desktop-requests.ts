/** A missing observation cannot leave the viewer waiting forever. This deadline
 * applies only to reads/permit renewal; input keeps its original single request. */
export async function readDesktop<T>(request: () => Promise<T>, timeout = 12_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Desktop preview timed out. Retrying the connection…")),
          timeout,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
