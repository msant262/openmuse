export interface MessageStorage {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  /** The callback reads and replaces one persisted record inside the writer's transaction. */
  update(key: string, change: (previous: string | null) => string): Promise<string>;
}
/** A single IndexedDB transaction stores the queue, draft, event cache and cursor together. */
export const messageStorage: MessageStorage = {
  async read(key) {
    return transact("readonly", (store) => store.get(key));
  },
  async write(key, value) {
    await transact("readwrite", (store) => store.put(value, key));
  },
  async update(key, change) {
    const value = await transact("readwrite", (store) => store.get(key), { key, change });
    if (value === null) throw new Error("Could not confirm saved messages");
    return value;
  },
};
async function transact(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest,
  mutation?: { key: string; change: (previous: string | null) => string },
): Promise<string | null> {
  if (typeof indexedDB === "undefined")
    throw new Error("Durable local message storage is unavailable");
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("openmuse-messages", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("conversations");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  try {
    return await new Promise<string | null>((resolve, reject) => {
      const transaction = db.transaction("conversations", mode);
      const store = transaction.objectStore("conversations");
      const request = action(store);
      let changed: string | undefined;
      let failure: unknown;
      if (mutation)
        request.onsuccess = () => {
          try {
            changed = mutation.change(typeof request.result === "string" ? request.result : null);
            store.put(changed, mutation.key);
          } catch (error) {
            failure = error;
            transaction.abort();
          }
        };
      transaction.oncomplete = () =>
        resolve(changed ?? (typeof request.result === "string" ? request.result : null));
      transaction.onerror = transaction.onabort = () =>
        reject(failure ?? transaction.error ?? new Error("Could not persist messages"));
    });
  } finally {
    db.close();
  }
}

/** Remove a confirmed deleted conversation after its chat component has unmounted. */
export async function removeConversationCache(key: string) {
  await transact("readwrite", (store) => store.delete(key));
}
