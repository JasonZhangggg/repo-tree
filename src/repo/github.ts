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
    return toSnapshot(ref, branch, await res.json());
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

/** A body as text, gunzipped when it starts with the gzip magic bytes. */
export async function decode(buffer: ArrayBuffer): Promise<string> {
  const [b0, b1] = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
  if (b0 !== 0x1f || b1 !== 0x8b) return new TextDecoder().decode(buffer);
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasDefaultBranch(value: unknown): value is Record<string, unknown> & {
  default_branch: string;
} {
  return isRecord(value) && typeof value.default_branch === 'string';
}
