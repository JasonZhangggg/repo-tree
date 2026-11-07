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

/**
 * Waits before each new try of a read that failed in passing: a dropped connection, a 5xx, or
 * GitHub's secondary rate limit. A page opened cold sends many reads at once, and one of them
 * failing so used to leave an empty page and an error that a second try would not have shown.
 */
export const RETRY_MS = [1000, 3000];
/** The longest `retry-after` waited out before reporting a rate limit instead. */
const RETRY_AFTER_MAX_MS = 10_000;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

/** How long to wait before trying a response's read again, or undefined when it should not be. */
function retryDelay(res: Response, fallback: number): number | undefined {
  if (res.status >= 500) return fallback;
  if (res.status !== 403 && res.status !== 429) return undefined;
  // The primary limit is used up until its reset, so trying again sooner only fails again.
  if (res.headers.get('x-ratelimit-remaining') === '0') return undefined;
  const after = Number(res.headers.get('retry-after'));
  if (Number.isFinite(after) && after > 0) {
    return after * 1000 <= RETRY_AFTER_MAX_MS ? after * 1000 : undefined;
  }
  return undefined;
}

/** `retryMs`: the waits before each new try of a read that failed in passing (tests pass zeros). */
export async function fetchSnapshot(
  ref: RepoRef,
  token?: string,
  signal?: AbortSignal,
  onBranch?: (branch: string) => void,
  retryMs: readonly number[] = RETRY_MS,
): Promise<Snapshot | LoadError> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const url = (path: string) => `${API}/repos/${ref.owner}/${ref.repo}${path}`;
  /** One read, tried again after each of `retryMs` while it fails in passing. */
  const get = async (path: string): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      const wait = retryMs[attempt];
      let res: Response;
      try {
        res = await fetch(url(path), { headers, signal });
      } catch (error) {
        if (signal?.aborted || wait === undefined) throw error;
        await sleep(wait, signal);
        continue;
      }
      const delay = wait === undefined ? undefined : retryDelay(res, wait);
      if (delay === undefined) return res;
      await sleep(delay, signal);
    }
  };

  try {
    let branch = ref.ref;
    if (branch === undefined) {
      const res = await get('');
      if (!res.ok) return httpError(res, !!token);
      const repo: unknown = await res.json();
      if (!hasDefaultBranch(repo)) return NETWORK;
      branch = repo.default_branch;
    }
    const treeOf = (name: string) =>
      get(`/git/trees/${name.split('/').map(encodeURIComponent).join('/')}?recursive=1`);
    let res = await treeOf(branch);
    // A pasted link to a folder (`tree/main/src/lib`) names the branch and then the folder,
    // and only GitHub knows where one ends: try the shorter names until one is a branch.
    const missing = (r: Response) => r.status === 404 || r.status === 422;
    for (
      let cut = branch, tries = 0;
      missing(res) && cut.includes('/') && tries < MAX_CUTS;
      tries++
    ) {
      cut = cut.slice(0, cut.lastIndexOf('/'));
      const next = await treeOf(cut);
      if (missing(next)) continue;
      res = next;
      if (next.ok) branch = cut;
      break;
    }
    onBranch?.(branch);
    if (!res.ok) return httpError(res, !!token);
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
        // Once: a folder that fails is read again by the next visit, and the tree shows without it.
        const next = await fetch(url(`/git/trees/${sha}${recursive ? '?recursive=1' : ''}`), {
          headers,
          signal,
        });
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

/** `sentToken`: whether the read carried a token, the only thing GitHub can reject as bad. */
function httpError(res: Response, sentToken: boolean): LoadError {
  const { status, headers } = res;
  if (status === 404) return { kind: 'not-found' };
  if (status === 409) return { kind: 'empty' };
  if ((status === 403 || status === 429) && headers.get('x-ratelimit-remaining') === '0') {
    return { kind: 'rate-limited', resetAt: Number(headers.get('x-ratelimit-reset')) * 1000 };
  }
  const after = Number(headers.get('retry-after'));
  if ((status === 403 || status === 429) && Number.isFinite(after) && after > 0) {
    // The secondary limit, still on after the waits: it lifts after `retry-after` seconds.
    return { kind: 'rate-limited', resetAt: Date.now() + after * 1000 };
  }
  if (sentToken && (status === 401 || status === 403)) return { kind: 'unauthorized' };
  return NETWORK;
}

/** How many shorter branch names a pasted folder link tries, so a typo costs few reads. */
const MAX_CUTS = 6;

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
