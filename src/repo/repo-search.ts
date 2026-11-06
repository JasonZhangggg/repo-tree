/**
 * Repo suggestions from GitHub's repository search, for the repo field. Search has its own budget,
 * apart from the core one trees load from: 10 requests a minute without a token, 30 with one.
 */

export type RepoHit = {
  /** owner/repo, as GitHub spells it. */
  name: string;
  description: string;
  stars: number;
};

export type RepoSearchResult =
  | { kind: 'ok'; hits: RepoHit[] }
  /** The minute's budget is spent until `resetAt` (ms since the epoch). */
  | { kind: 'rate-limited'; resetAt: number }
  | { kind: 'error' };

/** What to ask GitHub for: the `q` string, and whether to rank by stars over best match. */
export type RepoQuery = { q: string; byStars: boolean };

const API = 'https://api.github.com';
const URL_PREFIX = /^(?:https?:\/\/)?(?:www\.)?github\.com\//i;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const PARTIAL = /^[A-Za-z0-9._-]{0,100}$/;
/** A name fragment worth searching; one letter matches half of GitHub. */
const MIN_CHARS = 2;
export const HIT_LIMIT = 6;

/**
 * The search for what is typed in the field, or null when it isn't worth one. `vite` searches repo
 * names; `vitejs/` lists that owner's repos by stars and `vitejs/vi` narrows them. A GitHub URL
 * counts as its owner/repo path.
 */
export function repoQuery(input: string): RepoQuery | null {
  let text = input.trim();
  const prefix = URL_PREFIX.exec(text);
  if (prefix) text = text.slice(prefix[0].length).split(/[?#]/)[0] ?? '';
  const slash = text.indexOf('/');
  if (slash < 0) {
    if (text.length < MIN_CHARS || !PARTIAL.test(text)) return null;
    return { q: `${text} in:name`, byStars: false };
  }
  const owner = text.slice(0, slash);
  const rest = text.slice(slash + 1).replace(/\/.*$/, '');
  if (!OWNER.test(owner) || !PARTIAL.test(rest)) return null;
  return { q: rest ? `${rest} in:name user:${owner}` : `user:${owner}`, byStars: true };
}

/** Asks GitHub's repository search; never throws, and an abort reads as an error. */
export async function searchRepos(
  query: RepoQuery,
  token?: string,
  signal?: AbortSignal,
): Promise<RepoSearchResult> {
  const url = new URL(`${API}/search/repositories`);
  url.searchParams.set('q', query.q);
  url.searchParams.set('per_page', String(HIT_LIMIT));
  if (query.byStars) url.searchParams.set('sort', 'stars');
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(url.href, { headers, signal });
    const spent =
      res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after');
    if ((res.status === 403 || res.status === 429) && spent) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const retry = Number(res.headers.get('retry-after'));
      const resetAt = reset ? reset * 1000 : Date.now() + (retry || 60) * 1000;
      return { kind: 'rate-limited', resetAt };
    }
    // An owner that doesn't exist is a 422, and simply has no repos to offer.
    if (res.status === 422) return { kind: 'ok', hits: [] };
    if (!res.ok) return { kind: 'error' };
    const body = (await res.json()) as { items?: unknown };
    if (!Array.isArray(body.items)) return { kind: 'error' };
    const hits = body.items.flatMap((item: Record<string, unknown>): RepoHit[] =>
      typeof item?.full_name === 'string'
        ? [
            {
              name: item.full_name,
              description: typeof item.description === 'string' ? item.description : '',
              stars: typeof item.stargazers_count === 'number' ? item.stargazers_count : 0,
            },
          ]
        : [],
    );
    return { kind: 'ok', hits };
  } catch {
    return { kind: 'error' };
  }
}

export type RepoSuggester = {
  /** Call on every keystroke; `onResult` hears back once typing pauses (or at once from cache). */
  update(input: string): void;
  /** Drops any pending search, as when the field closes. */
  cancel(): void;
};

/**
 * Debounces the field's keystrokes into searches: waits `delay` ms after the last one, aborts a
 * search a newer keystroke replaces, answers a repeated query from memory, and asks nothing more
 * while the budget is spent. `onResult` gets the input it answers and null when there is nothing
 * to search, so the list can show just its local rows.
 */
export function createRepoSuggester(options: {
  onResult: (input: string, result: RepoSearchResult | null) => void;
  token?: () => string | undefined;
  search?: typeof searchRepos;
  delay?: number;
  now?: () => number;
}): RepoSuggester {
  const { onResult, token = () => undefined, search = searchRepos, delay = 300 } = options;
  const now = options.now ?? Date.now;
  const cache = new Map<string, RepoHit[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: AbortController | undefined;
  let restingUntil = 0;

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    inflight?.abort();
    inflight = undefined;
  };

  return {
    cancel,
    update(input) {
      cancel();
      const query = repoQuery(input);
      if (!query) return onResult(input, null);
      const key = `${query.q}|${query.byStars}`;
      const known = cache.get(key);
      if (known) return onResult(input, { kind: 'ok', hits: known });
      if (now() < restingUntil)
        return onResult(input, { kind: 'rate-limited', resetAt: restingUntil });
      timer = setTimeout(async () => {
        const controller = new AbortController();
        inflight = controller;
        const result = await search(query, token(), controller.signal);
        if (controller.signal.aborted) return;
        inflight = undefined;
        if (result.kind === 'ok') cache.set(key, result.hits);
        if (result.kind === 'rate-limited') restingUntil = result.resetAt;
        onResult(input, result);
      }, delay);
    },
  };
}

/** Recent repos and samples whose name holds what is typed, for the list's instant rows. */
export function matchLocal(input: string, names: readonly string[]): string[] {
  const text = input.trim().replace(URL_PREFIX, '').toLowerCase();
  if (!text) return [...names];
  return names.filter((name) => name.toLowerCase().includes(text));
}
