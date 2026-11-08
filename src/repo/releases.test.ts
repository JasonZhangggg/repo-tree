import { afterEach, describe, expect, test, vi } from 'vitest';
import { parseRepoRef, type RepoRef } from './ref';
import { fetchReleases, PAGES, parseReleases, parseTagRefs, parseTags } from './releases';

const ref = parseRepoRef('o/r') as RepoRef;
const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers });

describe('parseReleases', () => {
  test('reads published releases and leaves out drafts, prereleases and malformed ones', () => {
    const at = '2021-02-16T22:48:47Z';
    expect(
      parseReleases([
        { tag_name: 'v2.0.0', published_at: at },
        { tag_name: 'v2.1.0-beta.0', published_at: at, prerelease: true },
        { tag_name: 'v3.0.0', published_at: null, draft: true },
        { tag_name: '', published_at: at },
        { tag_name: 'v1.0.0', published_at: 'soon' },
        null,
      ]),
    ).toEqual([{ tag: 'v2.0.0', at: Date.parse(at) }]);
    expect(parseReleases({ message: 'Not Found' })).toBeNull();
  });
});

describe('parseTags', () => {
  test('reads a bundled sample’s tags, ISO or ms', () => {
    expect(
      parseTags([
        { tag: 'v1', at: '2020-01-01T00:00:00.000Z' },
        { tag: 'v2', at: 5 },
        { tag: 'v3' },
      ]),
    ).toEqual([
      { tag: 'v1', at: Date.UTC(2020, 0, 1) },
      { tag: 'v2', at: 5 },
    ]);
  });
});

describe('parseTagRefs', () => {
  test('dates an annotated tag by its tagger and a plain one by its commit', () => {
    const page = parseTagRefs({
      data: {
        repository: {
          refs: {
            pageInfo: { hasNextPage: true, endCursor: 'c1' },
            nodes: [
              { name: 'v6.0', target: { tagger: { date: '2022-10-02T22:00:00Z' } } },
              { name: 'v5.0', target: { committedDate: '2019-03-03T23:00:00Z' } },
              { name: 'tree', target: {} },
            ],
          },
        },
      },
    });
    expect(page).toEqual({
      tags: [
        { tag: 'v6.0', at: Date.parse('2022-10-02T22:00:00Z') },
        { tag: 'v5.0', at: Date.parse('2019-03-03T23:00:00Z') },
      ],
      next: 'c1',
    });
    expect(parseTagRefs({ errors: [{ message: 'x' }] })).toBeNull();
  });
});

describe('fetchReleases', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('signed out, reads one page of releases', async () => {
    const fetch = vi.fn(async () =>
      json([{ tag_name: 'v1.0.0', published_at: '2020-01-01T00:00:00Z' }], {
        Link: '<https://api.github.com/repos/o/r/releases?page=2>; rel="next"',
      }),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await fetchReleases(ref)).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(PAGES.signedOut);
  });

  test('signed in, follows the next page', async () => {
    const pages = [
      json([{ tag_name: 'v2.0.0', published_at: '2021-01-01T00:00:00Z' }], {
        Link: '<https://api.github.com/repos/o/r/releases?page=2>; rel="next"',
      }),
      json([{ tag_name: 'v1.0.0', published_at: '2020-01-01T00:00:00Z' }]),
    ];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer t');
      return pages.shift()!;
    });
    vi.stubGlobal('fetch', fetch);
    expect((await fetchReleases(ref, 't'))!.map((r) => r.tag)).toEqual(['v2.0.0', 'v1.0.0']);
    expect(fetch.mock.calls[1]![0]).toBe('https://api.github.com/repos/o/r/releases?page=2');
  });

  test('signed in, a repo with no releases falls back to its tags', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('/graphql')
        ? json({
            data: {
              repository: {
                refs: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{ name: 'v6.0', target: { committedDate: '2022-10-02T22:00:00Z' } }],
                },
              },
            },
          })
        : json([]),
    );
    vi.stubGlobal('fetch', fetch);
    expect((await fetchReleases(ref, 't'))!.map((r) => r.tag)).toEqual(['v6.0']);
    // Signed out the GraphQL API is closed, so no releases is no marks.
    expect(await fetchReleases(ref)).toEqual([]);
  });

  test('a 404 is no releases; a rate limit or the network is null', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
    expect(await fetchReleases(ref)).toEqual([]);
    vi.stubGlobal('fetch', async () => new Response('', { status: 403 }));
    expect(await fetchReleases(ref)).toBeNull();
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });
    expect(await fetchReleases(ref)).toBeNull();
  });
});
