/** A minimal GitHub REST client that counts its requests against a per-invocation limit. */

export type UpstreamKind = 'not-found' | 'empty' | 'unauthorized' | 'rate-limited' | 'upstream';

export class UpstreamError extends Error {
  constructor(
    readonly kind: UpstreamKind,
    readonly resetAt = 0,
  ) {
    super(`github: ${kind}`);
  }
}

/** Thrown when the invocation has spent its subrequest allowance. Callers retry next step. */
export class OutOfRequests extends Error {
  constructor() {
    super('out of requests for this step');
  }
}

export type GitHubOptions = {
  fetch: typeof fetch;
  /** e.g. https://api.github.com */
  api: string;
  token?: string;
  /** Requests this invocation may make. */
  limit: number;
};

export type GitHub = {
  readonly used: number;
  readonly left: number;
  /** x-ratelimit-remaining from the latest response, or null before any. */
  readonly remaining: number | null;
  readonly resetAt: number;
  json(path: string): Promise<{ body: unknown; link: string | null }>;
  /** The body as text, for a custom Accept such as `application/vnd.github.sha`. */
  text(path: string, accept: string): Promise<string>;
};

export function gitHub(options: GitHubOptions): GitHub {
  let used = 0;
  let remaining: number | null = null;
  let resetAt = 0;

  async function request(path: string, accept: string): Promise<Response> {
    if (used >= options.limit) throw new OutOfRequests();
    used++;
    const headers: Record<string, string> = {
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'repo-tree-history',
    };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    let res: Response;
    try {
      res = await options.fetch(`${options.api}${path}`, { headers });
    } catch {
      throw new UpstreamError('upstream');
    }
    const left = res.headers.get('x-ratelimit-remaining');
    if (left !== null) remaining = Number(left);
    const reset = res.headers.get('x-ratelimit-reset');
    if (reset !== null) resetAt = Number(reset) * 1000;
    if (res.ok) return res;
    if (res.status === 401) throw new UpstreamError('unauthorized');
    if (res.status === 404) throw new UpstreamError('not-found');
    if (res.status === 409) throw new UpstreamError('empty');
    if ((res.status === 403 || res.status === 429) && remaining === 0) {
      throw new UpstreamError('rate-limited', resetAt);
    }
    throw new UpstreamError('upstream');
  }

  return {
    get used() {
      return used;
    },
    get left() {
      return options.limit - used;
    },
    get remaining() {
      return remaining;
    },
    get resetAt() {
      return resetAt;
    },
    async json(path) {
      const res = await request(path, 'application/vnd.github+json');
      try {
        return { body: await res.json(), link: res.headers.get('link') };
      } catch {
        throw new UpstreamError('upstream');
      }
    },
    async text(path, accept) {
      return (await request(path, accept)).text();
    },
  };
}

/** The page number of rel="last" in a Link header, or null. */
export function lastPage(link: string | null): number | null {
  const match = link && /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link);
  return match ? Number(match[1]) : null;
}

export type CommitSummary = {
  sha: string;
  at: number;
  tree: string;
  author: string;
  merge: boolean;
};

/** Reads one entry of a /commits list. Null when malformed. */
export function toCommit(value: unknown): CommitSummary | null {
  if (!isRecord(value) || typeof value.sha !== 'string' || !isRecord(value.commit)) return null;
  const { commit, author, parents } = value;
  const committer = isRecord(commit.committer) ? commit.committer : undefined;
  const at = typeof committer?.date === 'string' ? Date.parse(committer.date) : NaN;
  const tree = isRecord(commit.tree) && typeof commit.tree.sha === 'string' ? commit.tree.sha : '';
  if (Number.isNaN(at) || !tree) return null;
  const login = isRecord(author) && typeof author.login === 'string' ? author.login : undefined;
  const raw = isRecord(commit.author) ? commit.author.name : undefined;
  const name = login ?? (typeof raw === 'string' ? raw : 'unknown');
  const merge = Array.isArray(parents) && parents.length > 1;
  return { sha: value.sha, at, tree, author: name, merge };
}

export function toCommits(body: unknown): CommitSummary[] {
  if (!Array.isArray(body)) throw new UpstreamError('upstream');
  return body.map(toCommit).filter((c): c is CommitSummary => c !== null);
}

export type TreeEntry = { path: string; type: 'blob' | 'tree'; sha: string };
export type Tree = { entries: TreeEntry[]; truncated: boolean };

/** Reads a /git/trees body. Submodules ('commit' entries) are left out. */
export function toTree(body: unknown): Tree {
  if (!isRecord(body) || !Array.isArray(body.tree)) throw new UpstreamError('upstream');
  const entries: TreeEntry[] = [];
  for (const e of body.tree as unknown[]) {
    if (!isRecord(e) || typeof e.path !== 'string' || typeof e.sha !== 'string') continue;
    if (e.type === 'blob' || e.type === 'tree')
      entries.push({ path: e.path, type: e.type, sha: e.sha });
  }
  return { entries, truncated: body.truncated === true };
}

export type FileChange = { path: string; status: string; from?: string };

/** The changed files of a /commits/{sha} body. */
export function toChanges(body: unknown): FileChange[] {
  if (!isRecord(body) || !Array.isArray(body.files)) throw new UpstreamError('upstream');
  const changes: FileChange[] = [];
  for (const f of body.files as unknown[]) {
    if (!isRecord(f) || typeof f.filename !== 'string' || typeof f.status !== 'string') continue;
    const from = typeof f.previous_filename === 'string' ? f.previous_filename : undefined;
    changes.push(
      from ? { path: f.filename, status: f.status, from } : { path: f.filename, status: f.status },
    );
  }
  return changes;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
