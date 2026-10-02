import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { verifyBrowserAuthorization } from "../../../packages/domain/src/browser-payment.ts";
import { type AgentPage, browserAction } from "./agent-page.ts";
import { WorkerError } from "./errors.ts";

/** Receipt is persisted before dispatch. A crashed dispatch is never repeated. */
export class ReviewedActions {
  private readonly directory: string;
  private readonly secret: string;
  constructor(directory: string, secret: string) {
    this.directory = directory;
    this.secret = secret;
  }
  async execute(sessionId: string, authorization: unknown, page: AgentPage, guard: () => void) {
    let intent: ReturnType<typeof verifyBrowserAuthorization>;
    try {
      intent = verifyBrowserAuthorization(this.secret, authorization);
    } catch {
      throw new WorkerError("INVALID_APPROVAL", "A valid native approval is required.", 403);
    }
    if (intent.sessionId !== sessionId)
      throw new WorkerError("INVALID_APPROVAL", "Approval belongs to another session.", 403);
    const action = browserAction(intent.binding.action);
    const folder = join(this.directory, sessionId, "reviewed-actions");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const path = join(folder, `${intent.id}.json`);
    type Receipt = {
      id: string;
      status: "executing" | "succeeded" | "failed" | "outcome_unknown";
      binding: string;
    };
    const binding = JSON.stringify(intent.binding);
    let previous: Receipt | undefined;
    try {
      previous = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        throw error;
    }
    if (previous) {
      if (previous.binding !== binding)
        throw new WorkerError("INVALID_APPROVAL", "Approval details changed.", 409);
      if (previous.status === "succeeded")
        return { id: intent.id, status: "succeeded" as const, replayed: true };
      throw new WorkerError(
        previous.status === "failed" ? "APPROVAL_FAILED" : "OUTCOME_UNKNOWN",
        previous.status === "failed"
          ? "This approved action failed; prepare a new review."
          : "This action may have executed. Check the site before preparing another action.",
        409,
      );
    }
    guard();
    const inspected = await page.inspect(action);
    if (JSON.stringify(inspected.binding) !== binding)
      throw new WorkerError(
        "STALE_SNAPSHOT",
        "Reviewed page, form or action changed; prepare a new review.",
        409,
      );
    const save = async (status: Receipt["status"]) => {
      const file = await open(`${path}.tmp`, "w", 0o600);
      try {
        await file.writeFile(JSON.stringify({ id: intent.id, status, binding }));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(`${path}.tmp`, path);
      const directory = await open(folder, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    };
    await save("executing");
    try {
      // Revalidate after receipt IO, immediately before dispatch under the session queue.
      await page.actReviewed(action, intent.binding, guard);
    } catch (error) {
      const status =
        error instanceof WorkerError &&
        ["STALE_SNAPSHOT", "BROWSER_CONTROLLED"].includes(error.code)
          ? "failed"
          : "outcome_unknown";
      await save(status);
      if (status === "failed") throw error;
      throw new WorkerError(
        "OUTCOME_UNKNOWN",
        "The reviewed action may have executed. Check the site before trying again.",
        409,
      );
    }
    try {
      await save("succeeded");
    } catch {
      throw new WorkerError(
        "OUTCOME_UNKNOWN",
        "The action executed but its receipt could not be saved. Check the site before trying again.",
        409,
      );
    }
    return { id: intent.id, status: "succeeded" as const, replayed: false };
  }
}
