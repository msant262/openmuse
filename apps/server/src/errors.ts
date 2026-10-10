export class AppError extends Error {
  constructor(
    message: string,
    public readonly status:
      | 400
      | 401
      | 403
      | 404
      | 409
      | 410
      | 413
      | 422
      | 429
      | 500
      | 502
      | 503 = 400,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Trusted host validation or registry rejection before native dispatch. */
export class NativePreflightRejection extends AppError {
  constructor(
    message: string,
    readonly parentOperationId?: string,
    readonly primitiveOperationId?: string,
    options: { status?: AppError["status"]; code?: string } = {},
  ) {
    super(message, options.status ?? 409, options.code ?? "NATIVE_CAPABILITY_UNAVAILABLE");
    this.name = "NativePreflightRejection";
  }
}
