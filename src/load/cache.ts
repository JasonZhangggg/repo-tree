import type { Snapshot } from '../repo/github';

const DB = 'repo-tree';
const STORE = 'snapshots';
const FRESH_MS = 60 * 60 * 1000;

let opened: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return opened;
}

function run<T>(mode: IDBTransactionMode, use: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const request = use(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error);
      }),
  );
}

/** A snapshot fetched within the last hour, or undefined. Storage failures count as a miss. */
export async function cachedSnapshot(key: string): Promise<Snapshot | undefined> {
  try {
    const hit = await run<Snapshot | undefined>('readonly', (store) => store.get(key));
    return hit && Date.now() - hit.fetchedAt < FRESH_MS ? hit : undefined;
  } catch {
    return undefined;
  }
}

export async function cacheSnapshot(key: string, snapshot: Snapshot): Promise<void> {
  try {
    await run('readwrite', (store) => store.put(snapshot, key));
  } catch {
    // A full or blocked store only costs the next visit a fetch.
  }
}
