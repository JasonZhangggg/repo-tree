import { cacheHistory, cachedHistory } from '../load/cache';
import type { History, HistoryReply, PathTable } from '../../server/src/shape';
import { HISTORY_VERSION } from '../../server/src/shape';
import { decode } from './github';
import type { RepoRef } from './ref';

export type { History, PathTable } from '../../server/src/shape';

/** The history server's base URL, or undefined when this build has none (history features off). */
export const HISTORY_URL: string | undefined = import.meta.env.VITE_HISTORY_URL || undefined;

/** Polling gives up after this long; the server keeps working and the next visit picks it up. */
export const MAX_WAIT_MS = 10 * 60 * 1000;
const FIRST_DELAY_MS = 2000;
const MAX_DELAY_MS = 30_000;

export type HistoryOptions = {
  /** Defaults to HISTORY_URL. */
  base?: string;
  /** The signed-in visitor's GitHub token (repo/auth.ts). Without it only cached history comes back. */
  token?: string | null;
  signal?: AbortSignal;
  /** 0 to 1 while the server computes. */
  onProgress?: (progress: number) => void;
  /** Injected for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
};

/**
 * What came back: a history, or a request to sign in because the repo is not cached and growing
 * it takes the visitor's token (`rejected`: the token sent was refused, so sign out first).
 * Null when history is off, the server refused or failed, or it took longer than MAX_WAIT_MS:
 * history is a nicety, so callers show none rather than an error.
 */
export type HistoryResult =
  { status: 'ready'; history: History } | { status: 'needs-auth'; rejected: boolean } | null;

/**
 * The commit history of a repo's branch from the history server, polling with backoff while it
 * computes. Rejects only on abort.
 */
export async function fetchHistory(
  ref: RepoRef,
  branch: string,
  options: HistoryOptions = {},
): Promise<HistoryResult> {
  const base = options.base ?? HISTORY_URL;
  if (!base) return null;
  const { signal, sleep = wait, now = Date.now, token } = options;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const url = `${base.replace(/\/$/, '')}/v1/history/${ref.owner}/${ref.repo}?branch=${encodeURIComponent(branch)}`;
  const deadline = now() + MAX_WAIT_MS;
  let delay = FIRST_DELAY_MS;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const res = await fetch(url, { signal, headers });
      const reply = parseReply(await res.json().catch(() => null));
      if (!reply) return null;
      if (reply.status === 'ready') return { status: 'ready', history: reply.history };
      if (reply.status === 'needs-auth') return { status: 'needs-auth', rejected: false };
      if (reply.status === 'error' && reply.error === 'unauthorized') {
        return { status: 'needs-auth', rejected: true };
      }
      if (reply.status === 'error' && reply.error !== 'rate-limited') return null;
      if (reply.status === 'pending') options.onProgress?.(reply.progress);
      const ms = Math.max(delay, (reply.retryAfter ?? 0) * 1000);
      if (now() + ms > deadline) return null;
      await sleep(ms, signal);
      delay = Math.min(MAX_DELAY_MS, delay * 1.5);
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

/** fetchHistory behind the IndexedDB cache (six hours, keyed like CI runs). */
export async function loadHistory(
  ref: RepoRef,
  branch: string,
  options: HistoryOptions & { fresh?: boolean } = {},
): Promise<HistoryResult> {
  const key = historyKey(ref, branch);
  if (!options.fresh) {
    const hit = await cachedHistory(key);
    if (hit) return { status: 'ready', history: hit };
  }
  const result = await fetchHistory(ref, branch, options);
  if (result?.status === 'ready') await cacheHistory(key, result.history);
  return result;
}

/** The history bundled beside a sample (`<base>samples/<id>.history.json.gz`). */
export async function loadSampleHistory(
  id: string,
  base: string = import.meta.env.BASE_URL,
): Promise<History | null> {
  try {
    const res = await fetch(`${base}samples/${id}.history.json.gz`);
    return res.ok ? parseHistory(JSON.parse(await decode(await res.arrayBuffer()))) : null;
  } catch {
    return null;
  }
}

export const historyKey = (ref: { owner: string; repo: string }, branch: string) =>
  `${ref.owner}/${ref.repo}@${branch}`.toLowerCase();

export function parseReply(body: unknown): HistoryReply | null {
  if (!isRecord(body)) return null;
  const retryAfter = typeof body.retryAfter === 'number' ? body.retryAfter : undefined;
  switch (body.status) {
    case 'ready': {
      const history = parseHistory(body.history);
      return history ? { status: 'ready', history, stale: body.stale === true } : null;
    }
    case 'pending':
      return typeof body.progress === 'number'
        ? { status: 'pending', progress: body.progress, retryAfter: retryAfter ?? 2 }
        : null;
    case 'needs-auth':
      return { status: 'needs-auth' };
    case 'error':
      return typeof body.error === 'string'
        ? ({ status: 'error', error: body.error, retryAfter } as HistoryReply)
        : null;
    default:
      return null;
  }
}

/** Checks a history from the network or a sample file: the version, and every column aligned. */
export function parseHistory(body: unknown): History | null {
  if (!isRecord(body) || body.v !== HISTORY_VERSION) return null;
  const { repo, branch, head, computedAt, gaps, recent, snapshots, files, folders, gone, owners } =
    body;
  if (
    typeof repo !== 'string' ||
    typeof branch !== 'string' ||
    typeof head !== 'string' ||
    typeof computedAt !== 'number' ||
    !strings(gaps) ||
    !isRecord(recent) ||
    typeof recent.since !== 'number' ||
    typeof recent.commits !== 'number' ||
    !Array.isArray(snapshots) ||
    !snapshots.every((s) => isRecord(s) && typeof s.sha === 'string' && typeof s.at === 'number') ||
    !isTable(files) ||
    !isTable(folders) ||
    !Array.isArray(gone) ||
    !gone.every((g) => isRecord(g) && typeof g.path === 'string' && typeof g.gone === 'number') ||
    !Array.isArray(owners) ||
    !owners.every((o) => isRecord(o) && typeof o.folder === 'string' && Array.isArray(o.authors))
  ) {
    return null;
  }
  return body as History;
}

const COLUMNS = ['changed', 'born', 'churn', 'commits'] as const;

function isTable(value: unknown): value is PathTable {
  if (!isRecord(value) || !strings(value.path)) return false;
  const n = value.path.length;
  return COLUMNS.every((c) => {
    const col = value[c];
    return Array.isArray(col) && col.length === n && col.every((x) => typeof x === 'number');
  });
}

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((x) => typeof x === 'string');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
