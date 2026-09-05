/**
 * The on-the-go outbox (0119) — what was done without signal, until it syncs.
 *
 * Client-safe: this is IndexedDB, read by the page and (in plain JS, in
 * public/sw.js) by the service worker's Background Sync handler. The two must
 * agree on the database name, the store name and the record shape — change
 * one and change the other.
 *
 * Every item is replayed through /api/go/sync, which calls the same server
 * actions a tap would have used, so nothing here bypasses a gate. An item is
 * removed only once the server has acknowledged it by id.
 */

export const GO_DB = "arc-go";
export const GO_STORE = "outbox";
export const GO_SYNC_TAG = "go-outbox";

export type GoOutboxKind = "log_time" | "advance_stage";

export type GoOutboxItem = {
  id: string;
  kind: GoOutboxKind;
  payload: Record<string, unknown>;
  /** What to call it in the pending list. */
  label: string;
  createdAt: string;
  /** The last refusal from the server, when it was tried and turned down. */
  error?: string | null;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available."));
      return;
    }
    const req = indexedDB.open(GO_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(GO_STORE)) {
        db.createObjectStore(GO_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Could not open the outbox."));
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(GO_STORE, mode);
        const store = t.objectStore(GO_STORE);
        const req = run(store);
        t.oncomplete = () => {
          db.close();
          resolve((req ? req.result : undefined) as T);
        };
        t.onerror = () => {
          db.close();
          reject(t.error ?? new Error("Outbox transaction failed."));
        };
      }),
  );
}

export async function listOutbox(): Promise<GoOutboxItem[]> {
  const items = await tx<GoOutboxItem[]>("readonly", (s) => s.getAll());
  return (items ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function enqueueOutbox(
  item: Omit<GoOutboxItem, "id" | "createdAt">,
): Promise<GoOutboxItem> {
  const full: GoOutboxItem = {
    ...item,
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    createdAt: new Date().toISOString(),
  };
  await tx("readwrite", (s) => s.put(full));
  await requestBackgroundSync();
  return full;
}

export async function removeFromOutbox(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await tx("readwrite", (s) => {
    for (const id of ids) s.delete(id);
  });
}

export async function markOutboxError(id: string, error: string): Promise<void> {
  const items = await listOutbox();
  const item = items.find((i) => i.id === id);
  if (!item) return;
  await tx("readwrite", (s) => s.put({ ...item, error }));
}

/** Ask the browser to replay when it next has a connection (Chrome/Android). */
async function requestBackgroundSync(): Promise<void> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    const sync = (reg as ServiceWorkerRegistration & {
      sync?: { register: (tag: string) => Promise<void> };
    }).sync;
    if (sync) await sync.register(GO_SYNC_TAG);
  } catch {
    // Not supported (Safari) — the page replays on its own when online.
  }
}

export type SyncOutcome = { synced: number; refused: number; pending: number };

/**
 * Replay the outbox from the page. Safe to call any time: with nothing
 * queued or no connection it does nothing. Items the server refused stay,
 * with the reason, for the person to read and clear.
 */
export async function syncOutbox(): Promise<SyncOutcome> {
  const items = await listOutbox();
  if (!items.length) return { synced: 0, refused: 0, pending: 0 };
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { synced: 0, refused: 0, pending: items.length };
  }

  const res = await fetch("/api/go/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      items: items.map(({ id, kind, payload }) => ({ id, kind, payload })),
    }),
  });
  if (!res.ok) return { synced: 0, refused: 0, pending: items.length };

  const data = (await res.json()) as {
    results?: { id: string; ok: boolean; error?: string }[];
  };
  const done: string[] = [];
  let refused = 0;
  for (const r of data.results ?? []) {
    if (r.ok) done.push(r.id);
    else {
      refused += 1;
      await markOutboxError(r.id, r.error ?? "Refused.");
    }
  }
  await removeFromOutbox(done);
  return { synced: done.length, refused, pending: items.length - done.length };
}
