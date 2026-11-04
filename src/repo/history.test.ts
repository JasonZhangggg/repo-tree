import { afterEach, describe, expect, test, vi } from 'vitest';
import { fetchHistory, parseHistory, MAX_WAIT_MS, type History } from './history';
import { parseRepoRef, type RepoRef } from './ref';

const ref = parseRepoRef('vitejs/vite') as RepoRef;
const BASE = 'https://history.example';

const history: History = {
  v: 1,
  repo: 'vitejs/vite',
  branch: 'main',
  head: 'a'.repeat(40),
  computedAt: 5,
  gaps: [],
  recent: { since: 3, commits: 1 },
  snapshots: [{ sha: 'a'.repeat(40), at: 4 }],
  files: { path: ['a.ts'], changed: [4], born: [1], churn: [0], commits: [1] },
  folders: { path: [''], changed: [4], born: [1], churn: [0], commits: [1] },
  gone: [],
  owners: [{ folder: '', authors: [{ name: 'ada', commits: 1, weight: 0 }], codeowners: [] }],
};

function serve(...bodies: unknown[]) {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(bodies.shift()));
    }),
  );
  return urls;
}

const clock = () => {
  const t = { now: 0, slept: [] as number[] };
  return {
    t,
    now: () => t.now,
    sleep: async (ms: number) => {
      t.slept.push(ms);
      t.now += ms;
    },
  };
};

afterEach(() => vi.unstubAllGlobals());

describe('fetchHistory', () => {
  test('is off without a server URL', async () => {
    const urls = serve();
    expect(await fetchHistory(ref, 'main', { base: '' })).toBeNull();
    expect(urls).toEqual([]);
  });

  test('polls while pending, reporting progress, with growing waits that honor retryAfter', async () => {
    const urls = serve(
      { status: 'pending', progress: 0.1, retryAfter: 2 },
      { status: 'pending', progress: 0.5, retryAfter: 2 },
      { status: 'pending', progress: 0.6, retryAfter: 10 },
      { status: 'ready', history, stale: false },
    );
    const c = clock();
    const progress: number[] = [];
    const got = await fetchHistory(ref, 'feat/x', {
      base: `${BASE}/`,
      onProgress: (p) => progress.push(p),
      ...c,
    });
    expect(got).toEqual({ status: 'ready', history });
    expect(progress).toEqual([0.1, 0.5, 0.6]);
    expect(c.t.slept).toEqual([2000, 3000, 10000]);
    expect(urls[0]).toBe(`${BASE}/v1/history/vitejs/vite?branch=feat%2Fx`);
  });

  test('fails soft on errors, malformed replies and the network', async () => {
    serve({ status: 'error', error: 'not-found' });
    expect(await fetchHistory(ref, 'main', { base: BASE })).toBeNull();
    serve({ status: 'ready', history: { ...history, files: { ...history.files, born: [] } } });
    expect(await fetchHistory(ref, 'main', { base: BASE })).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    expect(await fetchHistory(ref, 'main', { base: BASE })).toBeNull();
  });

  test('waits out a rate limit, but gives up past the deadline', async () => {
    serve({ status: 'error', error: 'rate-limited', retryAfter: 30 }, { status: 'ready', history });
    expect(await fetchHistory(ref, 'main', { base: BASE, ...clock() })).toEqual({
      status: 'ready',
      history,
    });
    serve({ status: 'pending', progress: 0, retryAfter: MAX_WAIT_MS / 1000 + 1 });
    expect(await fetchHistory(ref, 'main', { base: BASE, ...clock() })).toBeNull();
  });

  test('rejects on abort', async () => {
    serve({ status: 'pending', progress: 0, retryAfter: 2 });
    const abort = new AbortController();
    const done = fetchHistory(ref, 'main', { base: BASE, signal: abort.signal });
    abort.abort();
    await expect(done).rejects.toBeDefined();
  });
});

describe('sign-in', () => {
  test('sends the token and reports a needed or refused sign-in', async () => {
    serve({ status: 'needs-auth' });
    expect(await fetchHistory(ref, 'main', { base: BASE })).toEqual({
      status: 'needs-auth',
      rejected: false,
    });
    serve({ status: 'error', error: 'unauthorized' });
    expect(await fetchHistory(ref, 'main', { base: BASE, token: 'gho_x' })).toEqual({
      status: 'needs-auth',
      rejected: true,
    });
    const calls = vi.mocked(fetch).mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![1].headers).toEqual({ Authorization: 'Bearer gho_x' });
  });
});

describe('parseHistory', () => {
  test('accepts a well-formed history and refuses other versions', () => {
    expect(parseHistory(history)).toEqual(history);
    expect(parseHistory({ ...history, v: 2 })).toBeNull();
    expect(parseHistory({ ...history, folders: { ...history.folders, churn: ['x'] } })).toBeNull();
  });
});
