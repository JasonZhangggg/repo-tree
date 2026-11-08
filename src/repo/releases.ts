import type { RepoRef } from './ref';

/** A published release, or a plain tag where the repo publishes none: its tag and when. */
export type Release = { tag: string; /** ms */ at: number };

const API = 'https://api.github.com';
/** GitHub's largest page, for releases and for tags. */
const PER_PAGE = 100;
/**
 * Pages read. Signed out, GitHub allows 60 requests an hour shared with the tree, CI, PRs and
 * history, so one: the newest 100 releases. Signed in it allows 5,000, so enough to reach back
 * years on a monorepo that releases every package.
 */
export const PAGES = { signedOut: 1, signedIn: 10 } as const;

const parseTime = (value: unknown) => (typeof value === 'string' ? Date.parse(value) : NaN);

/**
 * Reads a `GET /repos/{o}/{r}/releases` body. Drafts and prereleases are left out, and so are
 * malformed entries; a release dates from when it was published. Null when it is not a list.
 */
export function parseReleases(body: unknown): Release[] | null {
  if (!Array.isArray(body)) return null;
  const releases: Release[] = [];
  for (const item of body as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const { tag_name, published_at, created_at, draft, prerelease } = item as Record<
      string,
      unknown
    >;
    const at = parseTime(published_at ?? created_at);
    if (typeof tag_name !== 'string' || !tag_name || draft === true || prerelease === true)
      continue;
    if (Number.isNaN(at)) continue;
    releases.push({ tag: tag_name, at });
  }
  return releases;
}

/** Reads a bundled sample's `[{ tag, at }]` (at: ISO time or ms). Null when it is not a list. */
export function parseTags(body: unknown): Release[] | null {
  if (!Array.isArray(body)) return null;
  const tags: Release[] = [];
  for (const item of body as unknown[]) {
    const { tag, at } = (item ?? {}) as { tag?: unknown; at?: unknown };
    const ms = typeof at === 'number' ? at : parseTime(at);
    if (typeof tag === 'string' && tag && Number.isFinite(ms)) tags.push({ tag, at: ms });
  }
  return tags;
}

type TagPage = { tags: Release[]; next: string | null };

/** Reads one page of the GraphQL tag query below; null when the body is not that. */
export function parseTagRefs(body: unknown): TagPage | null {
  const refs = (body as { data?: { repository?: { refs?: unknown } | null } } | null)?.data
    ?.repository?.refs as
    { nodes?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } } | undefined;
  if (!refs || !Array.isArray(refs.nodes)) return null;
  const tags: Release[] = [];
  for (const node of refs.nodes as unknown[]) {
    const { name, target } = (node ?? {}) as { name?: unknown; target?: Record<string, unknown> };
    if (typeof name !== 'string' || !name || !target) continue;
    // An annotated tag dates from its tagger, a plain one from its commit.
    const tagger = (target.tagger as { date?: unknown } | undefined)?.date;
    const peeled = (target.target as { committedDate?: unknown } | undefined)?.committedDate;
    const at = parseTime(tagger ?? target.committedDate ?? peeled);
    if (!Number.isNaN(at)) tags.push({ tag: name, at });
  }
  const { hasNextPage, endCursor } = refs.pageInfo ?? {};
  return { tags, next: hasNextPage === true && typeof endCursor === 'string' ? endCursor : null };
}

const TAGS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/tags/", first: ${PER_PAGE}, after: $after,
         orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { name target {
        ... on Commit { committedDate }
        ... on Tag { tagger { date } target { ... on Commit { committedDate } } }
      } }
    }
  }
}`;

/** The `rel="next"` URL of a Link header, if any. */
const nextLink = (link: string | null) => link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;

/**
 * A repo's releases, newest first as GitHub lists them: one request signed out, a few pages
 * signed in. A repo that publishes no releases falls back, signed in, to its tags through
 * GitHub's GraphQL API (which needs a token), so a repo like Linux that only tags still shows
 * its versions. An empty list when there are none or GitHub has no such repo (404). Null for
 * anything else, a rate limit or the network included: release marks are a nicety, so the
 * timeline shows none rather than an error. `api` is GitHub's API (a fake in e2e runs).
 * Rejects only on abort.
 */
export async function fetchReleases(
  ref: RepoRef,
  token?: string,
  signal?: AbortSignal,
  api: string = API,
): Promise<Release[] | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const pages = token ? PAGES.signedIn : PAGES.signedOut;
  try {
    const releases: Release[] = [];
    let url: string | null = `${api}/repos/${ref.owner}/${ref.repo}/releases?per_page=${PER_PAGE}`;
    for (let page = 0; url && page < pages; page++) {
      const res: Response = await fetch(url, { headers, signal });
      if (res.status === 404) return releases;
      if (!res.ok) return page ? releases : null;
      const listed = parseReleases(await res.json());
      if (!listed) return page ? releases : null;
      releases.push(...listed);
      url = nextLink(res.headers.get('Link'));
    }
    if (releases.length || !token) return releases;
    return await fetchTags(ref, headers, pages, api, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

async function fetchTags(
  ref: RepoRef,
  headers: Record<string, string>,
  pages: number,
  api: string,
  signal?: AbortSignal,
): Promise<Release[] | null> {
  const tags: Release[] = [];
  let after: string | null = null;
  for (let page = 0; page < pages; page++) {
    const res = await fetch(`${api}/graphql`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: TAGS_QUERY,
        variables: { owner: ref.owner, name: ref.repo, after },
      }),
      signal,
    });
    if (!res.ok) return page ? tags : null;
    const read = parseTagRefs(await res.json());
    if (!read) return page ? tags : null;
    tags.push(...read.tags);
    if (!read.next) break;
    after = read.next;
  }
  return tags;
}

/** The tags bundled beside a sample (`<base>samples/<id>.releases.json`, scripts/make-releases.mjs). */
export async function loadSampleReleases(
  id: string,
  base: string = import.meta.env.BASE_URL,
): Promise<Release[] | null> {
  try {
    const res = await fetch(`${base}samples/${id}.releases.json`);
    return res.ok ? parseTags(await res.json()) : null;
  } catch {
    return null;
  }
}

/** What releases are cached and stored under: one repo, whatever branch is on show. */
export const releasesKey = (ref: { owner: string; repo: string }) =>
  `${ref.owner}/${ref.repo}`.toLowerCase();
