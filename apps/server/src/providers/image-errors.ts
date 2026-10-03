/** The image request was never sent; credential preparation can be retried after reconnecting. */
export class ImageNotDispatchedError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : "Image provider could not be prepared", {
      cause: error,
    });
    this.name = "ImageNotDispatchedError";
  }
}
