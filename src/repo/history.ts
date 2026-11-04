import { cacheHistory, cachedHistory } from '../load/cache';
import type {
  History,
  HistoryError,
  PathTable,
  StoredManifest,
  UploadManifest,
} from '../../server/src/shape';
import { HISTORY_VERSION, snapshotDigest } from '../../server/src/shape';
import { decode } from './github';
import { parseRepoRef, type RepoRef } from './ref';

export type { History, PathTable } from '../../server/src/shape';

/** The history server's base URL, or undefined when this build has none (history features off). */
export const HISTORY_URL: string | undefined = import.meta.env.VITE_HISTORY_URL || undefined;

export type HistoryOptions = {
  /** Defaults to HISTORY_URL. */
  base?: string;
  signal?: AbortSignal;
};

/**
 * What the history server has for a branch: a history (checked against the manifest the server
 * verified with GitHub), or `missing`: nobody computed it yet, so a signed-in visitor may.
 * Null when history is off, the server failed, or what it sent does not hold together:
 * history is a nicety, so callers show none rather than an error.
 */
export type HistoryResult = { status: 'ready'; history: History } | { status: 'missing' } | null;

const historyUrl = (base: string, ref: RepoRef, branch: string) =>
  `${base.replace(/\/$/, '')}/v1/history/${ref.owner}/${ref.repo}?branch=${encodeURIComponent(branch)}`;

/** The stored history of a repo's branch. Rejects only on abort. */
export async function fetchHistory(
  ref: RepoRef,
  branch: string,
  options: HistoryOptions = {},
): Promise<HistoryResult> {
  const base = options.base ?? HISTORY_URL;
  if (!base) return null;
  const { signal } = options;
  try {
    const res = await fetch(historyUrl(base, ref, branch), { signal });
    if (res.status === 404) {
      const body: unknown = await res.json().catch(() => null);
      return isRecord(body) && body.status === 'missing' ? { status: 'missing' } : null;
    }
    if (!res.ok) return null;
    const manifest = parseStoredManifest(res.headers.get('X-History-Manifest'));
    const history = parseHistory(JSON.parse(await decode(await res.arrayBuffer())));
    if (!manifest || !history || !(await agrees(history, manifest, ref, branch))) return null;
    return { status: 'ready', history };
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

/**
 * Whether a stored body is the history the server checked: the same repo, branch and head, and
 * the very snapshots whose trees it spot-checked with GitHub (by digest).
 */
export async function agrees(
  history: History,
  manifest: StoredManifest,
  ref: RepoRef,
  branch: string,
): Promise<boolean> {
  return (
    history.repo.toLowerCase() === `${ref.owner}/${ref.repo}`.toLowerCase() &&
    history.repo.toLowerCase() === manifest.repo.toLowerCase() &&
    history.branch === branch &&
    manifest.branch === branch &&
    history.head === manifest.head &&
    history.snapshots.length === manifest.snapshots &&
    (await snapshotDigest(history.snapshots)) === manifest.digest
  );
}

function parseStoredManifest(raw: string | null): StoredManifest | null {
  if (!raw) return null;
  try {
    const m: unknown = JSON.parse(raw);
    return isRecord(m) &&
      typeof m.repo === 'string' &&
      typeof m.branch === 'string' &&
      typeof m.head === 'string' &&
      typeof m.digest === 'string' &&
      typeof m.snapshots === 'number'
      ? (m as StoredManifest)
      : null;
  } catch {
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

/** Why an upload was not stored, or `stored`. */
export type UploadResult = 'stored' | HistoryError | 'network';

/**
 * Shares a history this browser computed: the gzipped JSON, with the manifest the server checks
 * against GitHub using the visitor's token (sent only here and to GitHub).
 */
export async function uploadHistory(
  history: History,
  snapshots: readonly { sha: string; at: number; tree: string }[],
  token: string,
  options: HistoryOptions = {},
): Promise<UploadResult> {
  const base = options.base ?? HISTORY_URL;
  const ref = parseRepoRef(history.repo);
  if (!base || 'kind' in ref) return 'invalid';
  try {
    const body = await gzip(JSON.stringify(history));
    const manifest: UploadManifest = {
      v: HISTORY_VERSION,
      repo: history.repo,
      branch: history.branch,
      head: history.head,
      computedAt: history.computedAt,
      snapshots: snapshots.map(({ sha, at, tree }) => ({ sha, at, tree })),
      bytes: body.byteLength,
    };
    const res = await fetch(historyUrl(base, ref, history.branch), {
      method: 'PUT',
      body,
      signal: options.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/gzip',
        'X-History-Manifest': JSON.stringify(manifest),
      },
    });
    const reply: unknown = await res.json().catch(() => null);
    if (isRecord(reply) && reply.status === 'stored') return 'stored';
    return isRecord(reply) && reply.status === 'error' && typeof reply.error === 'string'
      ? (reply.error as HistoryError)
      : 'network';
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return 'network';
  }
}

async function gzip(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
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

/** Keeps a history this browser computed, as if it had come from the server. */
export const cacheComputed = (ref: RepoRef, branch: string, history: History) =>
  cacheHistory(historyKey(ref, branch), history);
