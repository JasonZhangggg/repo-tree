import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createRepoSuggester,
  matchLocal,
  repoQuery,
  searchRepos,
  type RepoSearchResult,
} from './repo-search';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('repoQuery', () => {
  test('searches names for a bare word of two or more letters', () => {
    expect(repoQuery('  thre ')).toEqual({ q: 'thre in:name', byStars: false });
    expect(repoQuery('t')).toBeNull();
    expect(repoQuery('')).toBeNull();
    expect(repoQuery('two words')).toBeNull();
  });

  test("lists an owner's repos by stars, narrowed by what follows the slash", () => {
    expect(repoQuery('vitejs/')).toEqual({ q: 'user:vitejs', byStars: true });
    expect(repoQuery('vitejs/vi')).toEqual({ q: 'vi in:name user:vitejs', byStars: true });
    expect(repoQuery('/vite')).toBeNull();
    expect(repoQuery('bad owner/x')).toBeNull();
  });

  test('reads a GitHub URL as its path', () => {
    expect(repoQuery('https://github.com/vitejs/vi')).toEqual({
      q: 'vi in:name user:vitejs',
      byStars: true,
    });
    expect(repoQuery('github.com/vitejs/vite/tree/main')).toEqual({
      q: 'vite in:name user:vitejs',
      byStars: true,
    });
  });
});

describe('searchRepos', () => {
  const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers }));

  test('asks for six repos, by stars for an owner, with the token', async () => {
    const fetch = reply({
      items: [
        { full_name: 'vitejs/vite', description: 'Fast.', stargazers_count: 83767 },
        { full_name: 'vitejs/devtools', description: null, stargazers_count: 1211 },
        { nope: true },
      ],
    });
    vi.stubGlobal('fetch', fetch);
    expect(await searchRepos({ q: 'user:vitejs', byStars: true }, 'gho_x')).toEqual({
      kind: 'ok',
      hits: [
        { name: 'vitejs/vite', description: 'Fast.', stars: 83767 },
        { name: 'vitejs/devtools', description: '', stars: 1211 },
      ],
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const params = new URL(url).searchParams;
    expect(params.get('q')).toBe('user:vitejs');
    expect(params.get('per_page')).toBe('6');
    expect(params.get('sort')).toBe('stars');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gho_x');
  });

  test('a spent budget says when it comes back', async () => {
    vi.stubGlobal(
      'fetch',
      reply({}, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1793955810' }),
    );
    expect(await searchRepos({ q: 'x', byStars: false })).toEqual({
      kind: 'rate-limited',
      resetAt: 1793955810_000,
    });
  });

  test('an unknown owner has no repos; other failures are errors', async () => {
    vi.stubGlobal('fetch', reply({ message: 'Validation Failed' }, 422));
    expect(await searchRepos({ q: 'user:zz', byStars: true })).toEqual({ kind: 'ok', hits: [] });
    vi.stubGlobal('fetch', reply({ message: 'Bad credentials' }, 403));
    expect(await searchRepos({ q: 'x', byStars: false })).toEqual({ kind: 'error' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('offline'))),
    );
    expect(await searchRepos({ q: 'x', byStars: false })).toEqual({ kind: 'error' });
  });
});

describe('createRepoSuggester', () => {
  const setup = (result: RepoSearchResult = { kind: 'ok', hits: [] }) => {
    vi.useFakeTimers();
    const search = vi.fn(async () => result);
    const heard: [string, RepoSearchResult | null][] = [];
    const suggester = createRepoSuggester({
      search,
      token: () => 'tok',
      onResult: (input, r) => heard.push([input, r]),
      now: () => Date.now(),
    });
    return { search, heard, suggester };
  };

  test('searches once typing pauses, for the last input only', async () => {
    const { search, heard, suggester } = setup();
    suggester.update('th');
    suggester.update('thr');
    suggester.update('thre');
    await vi.advanceTimersByTimeAsync(299);
    expect(search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(search).toHaveBeenCalledOnce();
    expect(search.mock.calls[0]?.slice(0, 2)).toEqual([
      { q: 'thre in:name', byStars: false },
      'tok',
    ]);
    expect(heard).toEqual([['thre', { kind: 'ok', hits: [] }]]);
  });

  test('answers a repeated query from memory and nothing for too little', async () => {
    const { search, heard, suggester } = setup();
    suggester.update('vite');
    await vi.advanceTimersByTimeAsync(300);
    suggester.update(' vite ');
    suggester.update('v');
    expect(search).toHaveBeenCalledOnce();
    expect(heard.slice(1)).toEqual([
      [' vite ', { kind: 'ok', hits: [] }],
      ['v', null],
    ]);
  });

  test('a newer keystroke aborts a search in flight', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const heard: string[] = [];
    const suggester = createRepoSuggester({
      search: (_q, _t, s) => {
        signal = s;
        return new Promise(() => {});
      },
      onResult: (input) => heard.push(input),
    });
    suggester.update('vite');
    await vi.advanceTimersByTimeAsync(300);
    suggester.update('vitest');
    expect(signal?.aborted).toBe(true);
  });

  test('asks nothing while the budget rests', async () => {
    const resetAt = Date.now() + 40_000;
    const { search, heard, suggester } = setup({ kind: 'rate-limited', resetAt });
    suggester.update('vite');
    await vi.advanceTimersByTimeAsync(300);
    suggester.update('react');
    await vi.advanceTimersByTimeAsync(300);
    expect(search).toHaveBeenCalledOnce();
    expect(heard[1]).toEqual(['react', { kind: 'rate-limited', resetAt }]);
  });
});

describe('matchLocal', () => {
  const names = ['vitejs/vite', 'torvalds/linux', 'mathiasbynens/dotfiles'];
  test('keeps the names that hold the input, ignoring case and a URL prefix', () => {
    expect(matchLocal('LIN', names)).toEqual(['torvalds/linux']);
    expect(matchLocal('https://github.com/vitejs/', names)).toEqual(['vitejs/vite']);
    expect(matchLocal('  ', names)).toEqual(names);
  });
});
