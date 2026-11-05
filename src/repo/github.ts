import { MAX_INFLATED_BYTES } from '../../server/src/shape';
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
    const snapshot = toSnapshot(ref, branch, await res.json());
    if ('kind' in snapshot || !snapshot.truncated) return snapshot;
    // GitHub cuts one recursive listing at 100,000 entries, signed in or not. A tree past that
    // comes whole a folder at a time: each top-level folder's own recursive listing, and a
    // folder still too big one level down, and so on.
    const whole = await readInParts(get, snapshot.sha);
    return whole ? { ...snapshot, truncated: false, files: whole } : snapshot;
  } catch (error) {
    if (signal?.aborted) throw error;
    return NETWORK;
  }
}

/** Most requests a truncated tree may spend coming whole, and how many run at once. */
const PART_BUDGET = 200;
const PART_WORKERS = 6;

type TreeEntry = { path: string; type: string; sha: string; size?: number };

/**
 * Every file of the tree `sha`, read folder by folder: a recursive listing of each folder, and
 * where that is cut short too, a plain listing and its subfolders in turn. Null when a request
 * fails or the budget runs out, so the caller keeps the partial tree it has.
 */
async function readInParts(
  get: (path: string) => Promise<Response>,
  sha: string,
): Promise<FileEntry[] | null> {
  let spent = 0;
  const list = async (treeSha: string, recursive: boolean) => {
    if (++spent > PART_BUDGET) return null;
    const res = await get(`/git/trees/${treeSha}${recursive ? '?recursive=1' : ''}`);
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!isRecord(body) || !Array.isArray(body.tree) || typeof body.truncated !== 'boolean') {
      return null;
    }
    return { truncated: body.truncated, tree: body.tree as TreeEntry[] };
  };
  const files: FileEntry[] = [];
  // Folders still to read whole, as [sha, path prefix].
  const queue: [string, string][] = [];
  const root = await list(sha, false);
  if (!root) return null;
  const take = (entries: TreeEntry[], prefix: string, folders: boolean) => {
    for (const e of entries) {
      if (e.type === 'blob' && typeof e.size === 'number') {
        files.push({ path: prefix + e.path, size: e.size });
      } else if (folders && e.type === 'tree') queue.push([e.sha, `${prefix}${e.path}/`]);
    }
  };
  take(root.tree, '', true);
  let failed = false;
  const work = async () => {
    while (queue.length && !failed) {
      const [treeSha, prefix] = queue.shift()!;
      const whole = await list(treeSha, true);
      if (!whole) return void (failed = true);
      if (!whole.truncated) {
        take(whole.tree, prefix, false);
        continue;
      }
      const own = await list(treeSha, false);
      if (!own) return void (failed = true);
      take(own.tree, prefix, true);
    }
  };
  // Workers pick folders up as they go; one finishing early leaves the rest to the others.
  while (queue.length && !failed) {
    await Promise.all(Array.from({ length: PART_WORKERS }, work));
  }
  if (failed) return null;
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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
