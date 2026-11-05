import { afterEach, describe, expect, test, vi } from 'vitest';
import { fetchPulls, parsePullFiles, parsePulls, perchOf, PERCHED } from './pulls';
import { parseRepoRef, type RepoRef } from './ref';

const FOLDERS = new Set(['src', 'src/app', 'src/app/ui', 'src/render', 'docs', 'docs/guide']);
const has = (f: string) => FOLDERS.has(f);

describe('perchOf', () => {
  test('perches on the deepest folder holding most of the changed files', () => {
    expect(perchOf(['src/app/ui/a.ts', 'src/app/ui/b.ts', 'src/app/c.ts'], has)).toBe('src/app/ui');
    expect(perchOf(['src/app/ui/a.ts', 'src/app/c.ts', 'src/render/d.ts'], has)).toBe('src/app');
    expect(perchOf(['src/app/a.ts', 'docs/c.md', 'docs/d.md'], has)).toBe('docs');
  });

  test('a change spread across the repo perches on the root', () => {
    expect(perchOf(['src/a.ts', 'docs/b.md', 'README.md'], has)).toBe('');
    expect(perchOf(['README.md'], has)).toBe('');
  });

  test('a file in a folder the tree lacks counts in the nearest one above it', () => {
    expect(perchOf(['src/app/new/deep/a.ts', 'src/app/new/b.ts'], has)).toBe('src/app');
    expect(perchOf(['vendor/x/y.c'], has)).toBe('');
  });

  test('two folders with half each perch on the folder holding both', () => {
    expect(perchOf(['src/render/a.ts', 'src/app/b.ts'], has)).toBe('src');
    expect(perchOf(['docs/a.md', 'src/b.ts'], has)).toBe('');
  });

  test('no files, no perch', () => {
    expect(perchOf([], has)).toBeNull();
  });
});

describe('parsePulls', () => {
  const pull = (over: Record<string, unknown> = {}) => ({
    number: 7,
    state: 'open',
    title: 'Fix it',
    user: { login: 'octo' },
    html_url: 'https://github.com/o/r/pull/7',
    draft: false,
    updated_at: '2026-11-01T00:00:00Z',
    base: { ref: 'main' },
    ...over,
  });

  test('reads open PRs newest first, keeping their base branch', () => {
    const parsed = parsePulls([
      pull(),
      pull({ number: 8, updated_at: '2026-11-02T00:00:00Z', draft: true }),
    ]);
    expect(parsed).toEqual([
      expect.objectContaining({ number: 8, draft: true, base: 'main' }),
      expect.objectContaining({ number: 7, author: 'octo', title: 'Fix it', draft: false }),
    ]);
  });

  test('leaves out malformed entries, links off GitHub and closed PRs', () => {
    expect(
      parsePulls([
        pull({ number: '7' }),
        pull({ html_url: 'javascript:alert(1)' }),
        pull({ state: 'closed' }),
        pull({ base: null }),
        pull({ updated_at: 'soon' }),
        null,
      ]),
    ).toEqual([]);
    expect(parsePulls({ message: 'nope' })).toBeNull();
  });

  test('a deleted account reads as ghost', () => {
    expect(parsePulls([pull({ user: null })])![0]!.author).toBe('ghost');
  });

  test('files are their paths', () => {
    expect(parsePullFiles([{ filename: 'a/b.ts' }, { filename: '' }, {}])).toEqual(['a/b.ts']);
    expect(parsePullFiles({})).toBeNull();
  });
});

describe('fetchPulls', () => {
  const ref = parseRepoRef('o/r') as RepoRef;
  afterEach(() => vi.unstubAllGlobals());

  const listed = (n: number, base = 'main') =>
    Array.from({ length: n }, (_, i) => ({
      number: i + 1,
      state: 'open',
      title: `PR ${i + 1}`,
      user: { login: 'u' },
      html_url: `https://github.com/o/r/pull/${i + 1}`,
      updated_at: new Date(Date.UTC(2026, 0, 1) + (n - i) * 1000).toISOString(),
      base: { ref: base },
    }));

  function stub(list: unknown, status = 200, files: (n: number) => Response | null = () => null) {
    const calls: { url: string; auth?: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).Authorization });
      const n = /\/pulls\/(\d+)\/files/.exec(url)?.[1];
      if (n) return files(Number(n)) ?? Response.json([{ filename: `f${n}/a.ts` }]);
      return Response.json(list, { status });
    });
    return calls;
  }

  test('reads files for the newest few into the branch, more when signed in', async () => {
    const calls = stub([...listed(10), ...listed(3, 'next').map((p) => ({ ...p, number: 90 }))]);
    const out = await fetchPulls(ref, 'main');
    expect(out!.total).toBe(10);
    expect(out!.pulls.map((p) => p.number)).toEqual([1, 2, 3, 4, 5, 6].slice(0, PERCHED.signedOut));
    expect(out!.pulls[0]!.files).toEqual(['f1/a.ts']);
    expect(calls[0]!.url).toBe(
      'https://api.github.com/repos/o/r/pulls?state=open&sort=updated&direction=desc&per_page=50',
    );
    expect(calls).toHaveLength(1 + PERCHED.signedOut);

    const signed = stub(listed(30));
    const more = await fetchPulls(ref, 'main', 'tok');
    expect(more!.pulls).toHaveLength(PERCHED.signedIn);
    expect(signed.every((c) => c.auth === 'Bearer tok')).toBe(true);
  });

  test('a PR whose files fail is left out; no PRs and a 404 are empty; errors are null', async () => {
    stub(listed(2), 200, (n) => (n === 1 ? new Response('', { status: 500 }) : null));
    expect((await fetchPulls(ref, 'main'))!.pulls.map((p) => p.number)).toEqual([2]);
    stub([]);
    expect(await fetchPulls(ref, 'main')).toEqual({ pulls: [], total: 0 });
    stub({ message: 'Not Found' }, 404);
    expect(await fetchPulls(ref, 'main')).toEqual({ pulls: [], total: 0 });
    stub({ message: 'rate limited' }, 403);
    expect(await fetchPulls(ref, 'main')).toBeNull();
  });
});
