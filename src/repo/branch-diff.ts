import type { RepoRef } from './ref';

/** A file a compared branch or tag touches, against the branch on show. */
export type DiffFile = { path: string; status: 'added' | 'modified' | 'removed' };
/** What `GET /compare/<base>...<head>` says the head did to the base. */
export type BranchDiff = {
  base: string;
  head: string;
  /** Commits the head has that the base lacks, and the other way round. */
  ahead: number;
  behind: number;
  /** A rename is its old path removed and its new one added. */
  files: DiffFile[];
  /** GitHub lists at most 300 files: a bigger diff shows only those. */
  capped: boolean;
};
export type DiffError =
  { kind: 'not-found' } | { kind: 'rate-limited'; resetAt: number } | { kind: 'network' };
/** The branches and tags a repo has, to pick one to compare. */
export type Refs = { branches: string[]; tags: string[] };

/** GitHub's cap on the files one comparison lists. */
export const MAX_DIFF_FILES = 300;
const API = 'https://api.github.com';
const PER_PAGE = 100;

const headersFor = (token?: string) => {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
};

/** A ref in a URL path: each part escaped, its slashes kept (`feature/x`). */
const refPath = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');

/** Reads a compare body. Null when it is not one. */
export function parseCompare(body: unknown, base: string, head: string): BranchDiff | null {
  if (typeof body !== 'object' || body === null) return null;
  const { ahead_by, behind_by, files } = body as Record<string, unknown>;
  if (typeof ahead_by !== 'number' || typeof behind_by !== 'number') return null;
  const out: DiffFile[] = [];
  const listed = Array.isArray(files) ? (files as unknown[]) : [];
  for (const item of listed) {
    if (typeof item !== 'object' || item === null) continue;
    const { filename, status, previous_filename } = item as Record<string, unknown>;
    if (typeof filename !== 'string' || !filename) continue;
    if (status === 'removed') out.push({ path: filename, status: 'removed' });
    else if (status === 'added' || status === 'copied')
      out.push({ path: filename, status: 'added' });
    else if (status === 'renamed') {
      if (typeof previous_filename === 'string' && previous_filename) {
        out.push({ path: previous_filename, status: 'removed' });
      }
      out.push({ path: filename, status: 'added' });
    } else if (status !== 'unchanged') out.push({ path: filename, status: 'modified' });
  }
  return {
    base,
    head,
    ahead: ahead_by,
    behind: behind_by,
    files: out,
    capped: listed.length >= MAX_DIFF_FILES,
  };
}

function errorOf(res: Response): DiffError {
  const { status, headers } = res;
  if (status === 404 || status === 422) return { kind: 'not-found' };
  if ((status === 403 || status === 429) && headers.get('x-ratelimit-remaining') === '0') {
    return { kind: 'rate-limited', resetAt: Number(headers.get('x-ratelimit-reset')) * 1000 };
  }
  return { kind: 'network' };
}

/**
 * What `head` (a branch, tag or sha) changes against `base`: one request. A head GitHub can't
 * find, or that shares no history with the base, is 'not-found'. Rejects only on abort.
 */
export async function fetchCompare(
  ref: RepoRef,
  base: string,
  head: string,
  token?: string,
  signal?: AbortSignal,
): Promise<BranchDiff | DiffError> {
  const url = `${API}/repos/${ref.owner}/${ref.repo}/compare/${refPath(base)}...${refPath(head)}`;
  try {
    const res = await fetch(url, { headers: headersFor(token), signal });
    if (!res.ok) return errorOf(res);
    return parseCompare(await res.json(), base, head) ?? { kind: 'network' };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { kind: 'network' };
  }
}

/** The names in a `GET /branches` or `/tags` body. */
export function parseRefNames(body: unknown): string[] | null {
  if (!Array.isArray(body)) return null;
  const names: string[] = [];
  for (const item of body as unknown[]) {
    const name = (item as { name?: unknown } | null)?.name;
    if (typeof name === 'string' && name) names.push(name);
  }
  return names;
}

/**
 * The repo's first hundred branches and tags (two requests, side by side). Null when neither
 * list can be read; a list that fails alone is empty. Rejects only on abort.
 */
export async function fetchRefs(
  ref: RepoRef,
  token?: string,
  signal?: AbortSignal,
): Promise<Refs | DiffError> {
  const repo = `${API}/repos/${ref.owner}/${ref.repo}`;
  const read = async (kind: 'branches' | 'tags') => {
    try {
      const res = await fetch(`${repo}/${kind}?per_page=${PER_PAGE}`, {
        headers: headersFor(token),
        signal,
      });
      if (!res.ok) return errorOf(res);
      return parseRefNames(await res.json()) ?? ({ kind: 'network' } as DiffError);
    } catch (error) {
      if (signal?.aborted) throw error;
      return { kind: 'network' } as DiffError;
    }
  };
  const [branches, tags] = await Promise.all([read('branches'), read('tags')]);
  if (!Array.isArray(branches) && !Array.isArray(tags)) return branches as DiffError;
  return {
    branches: Array.isArray(branches) ? branches : [],
    tags: Array.isArray(tags) ? tags : [],
  };
}

/**
 * Each file's mark for the tree on show (render/diff.ts DIFF: 1 changed, 2 added, 3 removed), by
 * RepoIndex.files id; and how many of the diff's files the tree has no leaf for (hidden folders).
 */
export function diffMarks(
  diff: BranchDiff,
  paths: readonly string[],
): { marks: Uint8Array; counts: Record<DiffFile['status'], number>; off: number } {
  const ids = new Map<string, number>();
  paths.forEach((path, i) => ids.set(path, i));
  const marks = new Uint8Array(paths.length);
  const counts = { added: 0, modified: 0, removed: 0 };
  let off = 0;
  for (const { path, status } of diff.files) {
    counts[status]++;
    const id = ids.get(path);
    if (id === undefined) {
      off++;
      continue;
    }
    marks[id] = status === 'added' ? 2 : status === 'removed' ? 3 : 1;
  }
  return { marks, counts, off };
}

/** The paths the head adds, which the branch on show lacks: grown into its tree as new leaves. */
export const addedPaths = (diff: BranchDiff) =>
  diff.files.filter((f) => f.status === 'added').map((f) => f.path);
