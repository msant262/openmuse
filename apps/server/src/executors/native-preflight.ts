import { z } from "zod";
import { currentTaskScope } from "../engine/task-journal.ts";
import { AppError, NativePreflightRejection } from "../errors.ts";

/** Only synchronous host-side preparation belongs here. Native enqueue, tool
 * execution, receipt decoding and context/authority callbacks stay outside:
 * their exceptions cannot prove that no native effect was dispatched. */
export function nativePreflight<T>(owner: string, prepare: () => T): T {
  try {
    return prepare();
  } catch (error) {
    const scope = currentTaskScope();
    if (
      !(error instanceof NativePreflightRejection) &&
      (error instanceof AppError || error instanceof z.ZodError) &&
      scope?.owner === owner &&
      scope.primitive?.parentOperationId === scope.operation.id
    )
      throw new NativePreflightRejection(error.message, scope.operation.id, scope.primitive.id, {
        status: error instanceof AppError ? error.status : 422,
        code:
          error instanceof AppError
            ? (error.code ?? "NATIVE_PREFLIGHT_REJECTED")
            : "NATIVE_INPUT_INVALID",
      });
    throw error;
  }
}
