import type { CiRun } from '../repo/ci';
import type { Snapshot } from '../repo/github';
import type { History } from '../repo/history';

const DB = 'repo-tree';
const STORE = 'snapshots';
const FRESH_MS = 60 * 60 * 1000;
const RUNS_FRESH_MS = 10 * 60 * 1000;
const HISTORY_FRESH_MS = 6 * 60 * 60 * 1000;

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

/** What was stored under `key` within the last `maxAge` ms, or undefined. Storage failures count as a miss. */
async function cached<T extends { fetchedAt: number }>(
  key: string,
  maxAge: number,
): Promise<T | undefined> {
  try {
    const hit = await run<T | undefined>('readonly', (store) => store.get(key));
    return hit && Date.now() - hit.fetchedAt < maxAge ? hit : undefined;
  } catch {
    return undefined;
  }
}

async function cache<T extends { fetchedAt: number }>(key: string, value: T): Promise<void> {
  try {
    await run('readwrite', (store) => store.put(value, key));
  } catch {
    // A full or blocked store only costs the next visit a fetch.
  }
}

/** A snapshot fetched within the last hour, or undefined. */
export const cachedSnapshot = (key: string) => cached<Snapshot>(key, FRESH_MS);
export const cacheSnapshot = (key: string, snapshot: Snapshot) => cache(key, snapshot);

type StoredRuns = { runs: CiRun[]; fetchedAt: number };
/** Actions runs fetched within the last ten minutes: CI moves faster than the file tree. */
export const cachedRuns = async (key: string) =>
  (await cached<StoredRuns>(`runs:${key}`, RUNS_FRESH_MS))?.runs;
export const cacheRuns = (key: string, runs: CiRun[]) =>
  cache<StoredRuns>(`runs:${key}`, { runs, fetchedAt: Date.now() });

type StoredHistory = { history: History; fetchedAt: number };
/** A history fetched within six hours, the time the server trusts a branch head for. */
export const cachedHistory = async (key: string) =>
  (await cached<StoredHistory>(`history:${key}`, HISTORY_FRESH_MS))?.history;
export const cacheHistory = (key: string, history: History) =>
  cache<StoredHistory>(`history:${key}`, { history, fetchedAt: Date.now() });
