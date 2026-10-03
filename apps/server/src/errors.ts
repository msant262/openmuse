export class AppError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503 = 400,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Trusted registry rejection before native authority/envelope/delivery creation. */
export class NativePreflightRejection extends AppError {
  constructor(
    message: string,
    readonly parentOperationId?: string,
    readonly primitiveOperationId?: string,
  ) {
    super(message, 409, "NATIVE_CAPABILITY_UNAVAILABLE");
    this.name = "NativePreflightRejection";
  }
}
