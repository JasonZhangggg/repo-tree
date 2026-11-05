import type { RepoRef } from './ref';

/** An open pull request into the branch on show, and the files it changes. */
export type OpenPull = {
  number: number;
  title: string;
  author: string;
  url: string;
  draft: boolean;
  /** ms */
  updatedAt: number;
  /** Changed paths, as GitHub lists them; renames count at their new path. */
  files: string[];
};

/**
 * The open pull requests into a branch, most recently updated first. `total` counts every open
 * one GitHub listed into it, and `pulls` holds the ones whose files were read, at most PERCHED.
 */
export type OpenPulls = { pulls: OpenPull[]; total: number };

/** PRs listed per request: the most recently updated this many, across all branches. */
export const LISTED = 50;
/**
 * How many PRs' files are read, one request each. Signed out, GitHub allows 60 requests an hour
 * shared with the tree, CI and history, so few; signed in it allows 5,000.
 */
export const PERCHED = { signedOut: 6, signedIn: 24 } as const;
/** Files read per PR: GitHub's page size. A bigger PR perches on what its first page says. */
const FILES_PER_PULL = 100;
const PARALLEL = 4;
const API = 'https://api.github.com';

type Listed = Omit<OpenPull, 'files'> & { base: string };

/** Reads a `GET /repos/{o}/{r}/pulls` body. Malformed entries are left out; null when it is not a list. */
export function parsePulls(body: unknown): Listed[] | null {
  if (!Array.isArray(body)) return null;
  const pulls: Listed[] = [];
  for (const item of body as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const { number, title, user, html_url, draft, updated_at, base, state } = item as Record<
      string,
      unknown
    >;
    const login = (user as { login?: unknown } | null)?.login;
    const ref = (base as { ref?: unknown } | null)?.ref;
    const updatedAt = typeof updated_at === 'string' ? Date.parse(updated_at) : NaN;
    if (
      typeof number !== 'number' ||
      typeof title !== 'string' ||
      typeof html_url !== 'string' ||
      !html_url.startsWith('https://github.com/') ||
      typeof ref !== 'string' ||
      (state !== undefined && state !== 'open') ||
      Number.isNaN(updatedAt)
    ) {
      continue;
    }
    pulls.push({
      number,
      title,
      author: typeof login === 'string' ? login : 'ghost',
      url: html_url,
      draft: draft === true,
      updatedAt,
      base: ref,
    });
  }
  return pulls.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Reads a `GET /repos/{o}/{r}/pulls/{n}/files` body into paths; null when it is not a list. */
export function parsePullFiles(body: unknown): string[] | null {
  if (!Array.isArray(body)) return null;
  const files: string[] = [];
  for (const item of body as unknown[]) {
    const name = (item as { filename?: unknown } | null)?.filename;
    if (typeof name === 'string' && name) files.push(name);
  }
  return files;
}

/**
 * The folder a PR perches on: the deepest one holding most (over half) of its changed files. Each
 * file counts in its own folder, or the nearest one above it the tree has (`has`), so a new folder
 * or a hidden one perches on what shows. Null when it changes no files. '' is the root.
 */
export function perchOf(files: readonly string[], has: (folder: string) => boolean): string | null {
  if (files.length === 0) return null;
  const inside = new Map<string, number>();
  for (const file of files) {
    let folder = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    while (folder && !has(folder))
      folder = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
    // The file counts in its folder and every folder above it.
    for (let at = folder; ; at = at.slice(0, Math.max(0, at.lastIndexOf('/')))) {
      inside.set(at, (inside.get(at) ?? 0) + 1);
      if (!at) break;
    }
  }
  let perch = '';
  for (;;) {
    let next: string | null = null;
    for (const [folder, n] of inside) {
      const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
      if (!folder || parent !== perch || n * 2 <= files.length) continue;
      next = folder; // Only one child can hold a majority.
    }
    if (next === null) return perch;
    perch = next;
  }
}

/** Runs `work` over `items`, at most `limit` at a time, keeping their order. */
async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}

/**
 * The open pull requests into `branch` and the files each changes. An empty list when the repo
 * has none or GitHub says it has no such list (404). Null for anything else, a rate limit or the
 * network included: birds are a nicety, so callers show none rather than an error. A PR whose
 * files can't be read is left out. Rejects only on abort.
 */
export async function fetchPulls(
  ref: RepoRef,
  branch: string,
  token?: string,
  signal?: AbortSignal,
): Promise<OpenPulls | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const repo = `${API}/repos/${ref.owner}/${ref.repo}`;
  try {
    const query = `state=open&sort=updated&direction=desc&per_page=${LISTED}`;
    const res = await fetch(`${repo}/pulls?${query}`, { headers, signal });
    if (res.status === 404) return { pulls: [], total: 0 };
    if (!res.ok) return null;
    const listed = parsePulls(await res.json());
    if (!listed) return null;
    const into = listed.filter((p) => p.base === branch);
    const read = into.slice(0, token ? PERCHED.signedIn : PERCHED.signedOut);
    const files = await pool(read, PARALLEL, async (pull) => {
      try {
        const r = await fetch(`${repo}/pulls/${pull.number}/files?per_page=${FILES_PER_PULL}`, {
          headers,
          signal,
        });
        return r.ok ? parsePullFiles(await r.json()) : null;
      } catch (error) {
        if (signal?.aborted) throw error;
        return null;
      }
    });
    const pulls: OpenPull[] = [];
    read.forEach(({ number, title, author, url, draft, updatedAt }, i) => {
      const changed = files[i];
      if (changed) pulls.push({ number, title, author, url, draft, updatedAt, files: changed });
    });
    return { pulls, total: into.length };
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

/** What open PRs are cached and stored under: one repo's branch. */
export const pullsKey = (ref: { owner: string; repo: string }, branch: string) =>
  `${ref.owner}/${ref.repo}@${branch}`.toLowerCase();
