/** A minimal GitHub REST client that counts its requests against a per-invocation limit. */

export type UpstreamKind = 'not-found' | 'empty' | 'unauthorized' | 'rate-limited' | 'upstream';

export class UpstreamError extends Error {
  readonly kind: UpstreamKind;
  readonly resetAt: number;
  constructor(kind: UpstreamKind, resetAt = 0) {
    super(`github: ${kind}`);
    this.kind = kind;
    this.resetAt = resetAt;
  }
}

/** Thrown when the invocation has spent its subrequest allowance. Callers retry next step. */
export class OutOfRequests extends Error {
  constructor() {
    super('out of requests for this step');
  }
}

export type RetryPolicy = {
  /** Retries after the first try; 0 turns retrying off. */
  attempts: number;
  /** The longest single wait; a longer one (a spent hourly budget) fails as rate-limited. */
  maxWaitMs: number;
  /** Injected for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
};

/** For a host that can wait: a browser tab. A Worker step keeps the default, no retries. */
export const PATIENT: RetryPolicy = { attempts: 4, maxWaitMs: 90_000 };

export type GitHubOptions = {
  fetch: typeof fetch;
  /** e.g. https://api.github.com */
  api: string;
  token?: string;
  /** Requests this invocation may make (Infinity for no cap). */
  limit: number;
  /** Aborts requests in flight; they then reject with the signal's reason. */
  signal?: AbortSignal;
  /**
   * Network errors, 5xx and secondary rate limits (403 or 429 with Retry-After, or a spent
   * budget that resets within maxWaitMs) are retried with backoff. Default: no retries.
   */
  retry?: RetryPolicy;
};

/** A GraphQL reply with errors and no data, or one GitHub cut short. */
export class GraphQLError extends Error {
  readonly types: string[];
  constructor(messages: string[], types: string[]) {
    super(`github graphql: ${messages.join('; ')}`);
    this.types = types;
  }
}

export type GitHub = {
  readonly used: number;
  readonly left: number;
  /** x-ratelimit-remaining from the latest response, or null before any. */
  readonly remaining: number | null;
  readonly resetAt: number;
  /** Requests retried so far. */
  readonly retried: number;
  json(path: string): Promise<{ body: unknown; link: string | null }>;
  /** The body as text, for a custom Accept such as `application/vnd.github.sha`. */
  text(path: string, accept: string): Promise<string>;
  /** POST /graphql. Resolves with `data`; rejects with GraphQLError when GitHub returned none. */
  graphql(query: string): Promise<Record<string, unknown>>;
};

const sleeper = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
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

export function gitHub(options: GitHubOptions): GitHub {
  let used = 0;
  let retried = 0;
  let remaining: number | null = null;
  let resetAt = 0;
  const policy = options.retry ?? { attempts: 0, maxWaitMs: 0 };
  const sleep = policy.sleep ?? sleeper;
  const now = policy.now ?? Date.now;

  async function once(
    url: string,
    init: RequestInit,
  ): Promise<{ res?: Response; wait?: number; error?: UpstreamError }> {
    const { signal } = options;
    let res: Response;
    try {
      res = await options.fetch(url, signal ? { ...init, signal } : init);
    } catch {
      if (signal?.aborted) throw signal.reason;
      return { wait: -1, error: new UpstreamError('upstream') };
    }
    const left = res.headers.get('x-ratelimit-remaining');
    if (left !== null) remaining = Number(left);
    const reset = res.headers.get('x-ratelimit-reset');
    if (reset !== null) resetAt = Number(reset) * 1000;
    if (res.ok) return { res };
    if (res.status === 401) throw new UpstreamError('unauthorized');
    if (res.status === 404) throw new UpstreamError('not-found');
    if (res.status === 409) throw new UpstreamError('empty');
    if (res.status >= 500) return { wait: -1, error: new UpstreamError('upstream') };
    if (res.status === 403 || res.status === 429) {
      const after = Number(res.headers.get('retry-after'));
      const text = await res.text().catch(() => '');
      if (after > 0) return { wait: after * 1000, error: limited(after * 1000) };
      if (remaining === 0) {
        const wait = Math.max(1000, resetAt - now() + 1000);
        return { wait, error: limited(wait) };
      }
      // A secondary limit without Retry-After: GitHub asks for at least a minute.
      if (/secondary rate limit|abuse/i.test(text)) return { wait: 60_000, error: limited(60_000) };
    }
    throw new UpstreamError('upstream');
  }

  const limited = (wait: number) => new UpstreamError('rate-limited', now() + wait);

  async function request(path: string, accept: string, init: RequestInit = {}): Promise<Response> {
    const { signal } = options;
    signal?.throwIfAborted();
    if (used >= options.limit) throw new OutOfRequests();
    used++;
    const headers: Record<string, string> = {
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      // GitHub refuses requests without one; browsers send their own and ignore this.
      'User-Agent': 'repo-tree-history',
    };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    for (let attempt = 0; ; attempt++) {
      const { res, wait, error } = await once(`${options.api}${path}`, { ...init, headers });
      if (res) return res;
      // wait -1: a transient failure, backed off 1 s, 2 s, 4 s ... with jitter.
      const ms = wait === -1 ? 1000 * 2 ** attempt * (0.75 + Math.random() / 2) : wait!;
      if (attempt >= policy.attempts || ms > policy.maxWaitMs) throw error!;
      retried++;
      await sleep(ms, signal);
    }
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
    get retried() {
      return retried;
    },
    async json(path) {
      const res = await request(path, 'application/vnd.github+json');
      try {
        return { body: await res.json(), link: res.headers.get('link') };
      } catch {
        if (options.signal?.aborted) throw options.signal.reason;
        throw new UpstreamError('upstream');
      }
    },
    async text(path, accept) {
      return (await request(path, accept)).text();
    },
    async graphql(query) {
      const res = await request('/graphql', 'application/json', {
        method: 'POST',
        body: JSON.stringify({ query }),
      });
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        if (options.signal?.aborted) throw options.signal.reason;
        throw new GraphQLError(['unreadable reply'], []);
      }
      const errors = isRecord(body) && Array.isArray(body.errors) ? body.errors : [];
      const data = isRecord(body) && isRecord(body.data) ? body.data : null;
      if (!data || errors.length > 0) {
        const list = errors.filter(isRecord);
        throw new GraphQLError(
          list.map((e) => String(e.message ?? 'error')),
          list.map((e) => String(e.type ?? '')),
        );
      }
      return data;
    },
  };
}

/** The page number of rel="next" in a Link header, or null. */
export function nextPage(link: string | null): number | null {
  const match = link && /[?&]page=(\d+)[^>]*>;\s*rel="next"/.exec(link);
  return match ? Number(match[1]) : null;
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
  /** The committer's email: one person or bot commits a repo's mainline, often. */
  committer: string;
  /** Parent shas, the first parent first. */
  parents: string[];
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
  const shas = Array.isArray(parents)
    ? parents.flatMap((p) => (isRecord(p) && typeof p.sha === 'string' ? [p.sha] : []))
    : [];
  const email = typeof committer?.email === 'string' ? committer.email : '';
  return {
    sha: value.sha,
    at,
    tree,
    author: name,
    merge: shas.length > 1,
    committer: email,
    parents: shas,
  };
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
