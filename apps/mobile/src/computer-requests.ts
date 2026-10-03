import { ApiError } from "./api-errors";
import type { MessageStorage } from "./message-storage";

type Intent = { id: string; taskId?: string };
type Result = { pending?: boolean; taskId?: string; result?: unknown; status?: string };
export class ComputerPendingError extends ApiError {
  constructor(readonly taskId: string) {
    super(
      `Pedido recebido; tarefa ${taskId} continua na fila ou em execução. Consulte Tarefas ou tente atualizar.`,
      202,
      "COMPUTER_PENDING",
    );
  }
}
const mutations = new Set([
  "/start",
  "/stop",
  "/commands",
  "/files/read",
  "/files/write",
  "/files/mkdir",
  "/files/import",
  "/files/export",
  "/transcribe",
  "/transcribe-attachment",
  "/preview",
  "/file-versions/capture",
  "/file-versions/trash",
  "/file-versions/restore",
]);
export function durableComputerPath(path: string): boolean {
  return (
    path.startsWith("/api/computer/") &&
    (mutations.has(path.slice("/api/computer".length)) || path.startsWith("/api/computer/files?"))
  );
}

/** Persist the intention before dispatch; reconnect never invents another native effect. */
export class ComputerRequests {
  private active = new Map<string, Promise<unknown>>();
  constructor(
    private readonly storage: MessageStorage,
    private readonly digest: (value: string) => Promise<string>,
    private readonly uuid: () => string,
  ) {}

  async request<T>(
    scope: string,
    path: string,
    body: unknown,
    send: (path: string, body?: unknown, requestId?: string) => Promise<unknown>,
  ): Promise<T> {
    const key = `computer-request:${await this.digest(JSON.stringify([scope, path, body ?? null]))}`;
    const existing = this.active.get(key);
    if (existing) return existing as Promise<T>;
    const operation = this.perform(key, path, body, send);
    this.active.set(key, operation);
    try {
      return (await operation) as T;
    } finally {
      if (this.active.get(key) === operation) this.active.delete(key);
    }
  }
  private async perform(
    key: string,
    path: string,
    body: unknown,
    send: (path: string, body?: unknown, requestId?: string) => Promise<unknown>,
  ) {
    const stored = await this.storage.update(key, (previous) => {
      const value: Intent | null = previous ? JSON.parse(previous) : null;
      return JSON.stringify(value ?? { id: this.uuid() });
    });
    const intent: Intent = JSON.parse(stored);
    const response = await send(
      intent.taskId ? `/api/computer/requests/${encodeURIComponent(intent.taskId)}` : path,
      intent.taskId ? undefined : body,
      intent.id,
    );
    const value = response as Result | null;
    if (value?.pending && typeof value.taskId === "string") {
      await this.storage.write(key, JSON.stringify({ ...intent, taskId: value.taskId }));
      throw new ComputerPendingError(value.taskId);
    }
    await this.storage.write(key, "null");
    return intent.taskId && value?.status !== "error" ? value?.result : response;
  }
}
