import type { Server } from "node:http";

/** Joins server tool promises even when canceling their observable ends the model run first. */
export class OperationDrain {
  private readonly pending = new Set<Promise<unknown>>();
  private closing = false;
  private drainFailed = false;
  /** Production uses explicit Store write state, so recorded domain errors stay ordinary. */
  constructor(private readonly unconfirmed?: () => boolean) {}
  run<T>(execute: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Server is shutting down"));
    const operation = Promise.resolve().then(execute);
    this.pending.add(operation);
    void operation
      .catch(() => {
        if (!this.unconfirmed || this.unconfirmed()) this.drainFailed = true;
      })
      .finally(() => this.pending.delete(operation));
    return operation;
  }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.pending]);
    if (this.drainFailed || this.unconfirmed?.())
      throw new Error("Tool drain could not confirm completion");
  }
}

/** Tracks complete REST handlers, including native writes that outlive client disconnect. */
export class RequestDrain {
  private readonly pending = new Set<Promise<unknown>>();
  private closing = false;
  fetch(handle: (request: Request) => Response | Promise<Response>, request: Request) {
    if (this.closing)
      return Promise.resolve(new Response("Server is shutting down", { status: 503 }));
    const operation = Promise.resolve().then(() => handle(request));
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => {});
    return operation;
  }
  seal() {
    this.closing = true;
  }
  async close() {
    await Promise.allSettled([...this.pending]);
  }
}

/** Failures/deadlines leave exit nonzero; a backup may only trust confirmed exit zero. */
export async function shutdownServer(
  server: Server,
  requests: RequestDrain,
  stopWork: () => Promise<unknown>,
  closeDatabase: () => Promise<void>,
) {
  requests.seal();
  const httpClosed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  // Abort chat/task transports before waiting for HTTP streams to finish.
  await stopWork();
  await requests.close();
  // Work and receipts are durable now; discard idle/unfinished network connections.
  server.closeAllConnections();
  await httpClosed;
  await closeDatabase();
}
