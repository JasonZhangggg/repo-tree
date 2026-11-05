import { MAX_INFLATED_BYTES } from '../../server/src/shape';
import { completeTree, type Listed, type Listing } from './complete-tree';
import { parseRepoRef, type RepoRef } from './ref';

export type FileEntry = { path: string; size: number };
export type Snapshot = {
  ref: RepoRef;
  branch: string;
  sha: string;
  truncated: boolean;
  files: FileEntry[];
  fetchedAt: number;
};
export type LoadError =
  | { kind: 'not-found' }
  | { kind: 'rate-limited'; resetAt: number }
  | { kind: 'unauthorized' }
  | { kind: 'network' }
  | { kind: 'empty' };

const API = 'https://api.github.com';
const NETWORK: LoadError = { kind: 'network' };

export async function fetchSnapshot(
  ref: RepoRef,
  token?: string,
  signal?: AbortSignal,
  onBranch?: (branch: string) => void,
): Promise<Snapshot | LoadError> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const get = (path: string) =>
    fetch(`${API}/repos/${ref.owner}/${ref.repo}${path}`, { headers, signal });

  try {
    let branch = ref.ref;
    if (branch === undefined) {
      const res = await get('');
      if (!res.ok) return httpError(res);
      const repo: unknown = await res.json();
      if (!hasDefaultBranch(repo)) return NETWORK;
      branch = repo.default_branch;
    }
    onBranch?.(branch);
    const path = branch.split('/').map(encodeURIComponent).join('/');
    const res = await get(`/git/trees/${path}?recursive=1`);
    if (!res.ok) return httpError(res);
    const body: unknown = await res.json();
    if (!isRecord(body) || body.truncated !== true || typeof body.sha !== 'string') {
      return toSnapshot(ref, branch, body);
    }
    // GitHub cut the listing short (Linux is past its limit): read the folders it left out.
    const first = listingOf(body);
    if (!first) return NETWORK;
    let remaining = Number(res.headers.get('x-ratelimit-remaining') ?? Infinity);
    const list = async (sha: string, recursive: boolean): Promise<Listing | undefined> => {
      // Leave some of an hour's budget for everything else the app reads.
      if (remaining < RATE_RESERVE) return undefined;
      try {
        const next = await get(`/git/trees/${sha}${recursive ? '?recursive=1' : ''}`);
        remaining = Number(next.headers.get('x-ratelimit-remaining') ?? remaining);
        return next.ok ? listingOf(await next.json()) : undefined;
      } catch (error) {
        if (signal?.aborted) throw error;
        return undefined; // Keep what was read: a partial tree beats an error.
      }
    };
    const done = await completeTree(body.sha, first, list);
    return toSnapshot(ref, branch, {
      sha: body.sha,
      truncated: done.truncated,
      tree: done.entries,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return NETWORK;
  }
}

/** `base` is the URL of the folder that holds `samples/`. */
export async function loadSample(
  id: string,
  base: string = import.meta.env.BASE_URL,
): Promise<Snapshot | LoadError> {
  try {
    const res = await fetch(`${base}samples/${id}.json.gz`);
    if (!res.ok) return NETWORK;
    const fixture: unknown = JSON.parse(await decode(await res.arrayBuffer()));
    if (!isRecord(fixture) || !hasDefaultBranch(fixture.repo)) return NETWORK;
    const { full_name, default_branch } = fixture.repo;
    const ref = typeof full_name === 'string' ? parseRepoRef(full_name) : undefined;
    if (!ref || 'kind' in ref) return NETWORK;
    return toSnapshot(ref, default_branch, fixture.tree);
  } catch {
    return NETWORK;
  }
}

function httpError(res: Response): LoadError {
  const { status, headers } = res;
  if (status === 404) return { kind: 'not-found' };
  if (status === 409) return { kind: 'empty' };
  if ((status === 403 || status === 429) && headers.get('x-ratelimit-remaining') === '0') {
    return { kind: 'rate-limited', resetAt: Number(headers.get('x-ratelimit-reset')) * 1000 };
  }
  if (status === 401 || status === 403) return { kind: 'unauthorized' };
  return NETWORK;
}

/** Reads left unspent when filling in a cut-short tree (signed out, GitHub allows 60 an hour). */
const RATE_RESERVE = 15;

const MODES: Record<string, string> = { blob: '100644', tree: '040000', commit: '160000' };

function listingOf(body: unknown): Listing | undefined {
  if (!isRecord(body) || typeof body.truncated !== 'boolean' || !Array.isArray(body.tree)) {
    return undefined;
  }
  const entries: Listed[] = [];
  for (const e of body.tree as unknown[]) {
    if (!isRecord(e)) return undefined;
    const { path, type, sha, size } = e;
    if (typeof path !== 'string' || typeof type !== 'string' || typeof sha !== 'string') {
      return undefined;
    }
    // A wrong mode only means the folder is not proved whole, and is read again.
    const mode = typeof e.mode === 'string' ? e.mode : (MODES[type] ?? '');
    entries.push(
      typeof size === 'number' ? { path, mode, type, sha, size } : { path, mode, type, sha },
    );
  }
  return { entries, truncated: body.truncated };
}

function toSnapshot(ref: RepoRef, branch: string, body: unknown): Snapshot | LoadError {
  if (
    !isRecord(body) ||
    typeof body.sha !== 'string' ||
    typeof body.truncated !== 'boolean' ||
    !Array.isArray(body.tree)
  ) {
    return NETWORK;
  }
  const files: FileEntry[] = [];
  for (const entry of body.tree as unknown[]) {
    if (!isRecord(entry) || entry.type !== 'blob') continue;
    const { path, size } = entry;
    if (typeof path !== 'string' || typeof size !== 'number') return NETWORK;
    files.push({ path, size });
  }
  if (files.length === 0) return { kind: 'empty' };
  return { ref, branch, sha: body.sha, truncated: body.truncated, files, fetchedAt: Date.now() };
}

/** A body unpacked past this many bytes is refused (a gzip bomb): eight times Linux's history. */
export const MAX_DECODED_BYTES = MAX_INFLATED_BYTES;

/**
 * A body as text, gunzipped when it starts with the gzip magic bytes. Rejects once the text
 * passes `limit` bytes, unpacking no further.
 */
export async function decode(buffer: ArrayBuffer, limit = MAX_DECODED_BYTES): Promise<string> {
  const [b0, b1] = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
  if (b0 !== 0x1f || b1 !== 0x8b) {
    if (buffer.byteLength > limit) throw new RangeError('body too large');
    return new TextDecoder().decode(buffer);
  }
  const reader = new Blob([buffer])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
    .getReader();
  const text = new TextDecoder();
  const parts: string[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new RangeError('body too large');
    }
    parts.push(text.decode(value, { stream: true }));
  }
  parts.push(text.decode());
  return parts.join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasDefaultBranch(value: unknown): value is Record<string, unknown> & {
  default_branch: string;
} {
  return isRecord(value) && typeof value.default_branch === 'string';
}
