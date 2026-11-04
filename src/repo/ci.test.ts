import { afterEach, describe, expect, test, vi } from 'vitest';
import { actionsUrl, ciHealth, fetchRuns, parseRuns, type CiRun } from './ci';
import { parseRepoRef, type RepoRef } from './ref';

/** Runs newest first from a string like 'xx...' : x failed, . passed. */
const runs = (pattern: string): CiRun[] =>
  [...pattern].map((c, i) => ({ passed: c === '.', at: 1_000_000 - i * 1000 }));

describe('ciHealth', () => {
  test.each([
    ['', 'clear'],
    ['.', 'sunny'],
    ['....................', 'sunny'],
    ['...................x', 'cloudy'],
    ['.x.x................', 'cloudy'],
    ['.x.x.x', 'rain'],
    ['..xx..xx..xx', 'rain'],
    ['.xx', 'cloudy'],
    ['x...................', 'rain'],
    ['xx..................', 'rain'],
    ['xxx.................', 'storm'],
    ['x', 'rain'],
    ['xxx', 'storm'],
  ])('%j is %s', (pattern, sky) => {
    expect(ciHealth(runs(pattern)).sky).toBe(sky);
  });

  test('counts passes, the failure streak and the newest run among the last 20 only', () => {
    const health = ciHealth(runs(`xx${'.'.repeat(18)}xxxxx`));
    expect(health).toEqual({
      sky: 'rain',
      runs: 20,
      passed: 18,
      streak: 2,
      latest: { passed: false, at: 1_000_000 },
    });
  });

  test('only failures in a row from the newest make a storm, not failures scattered', () => {
    expect(ciHealth(runs('.xxxxxxxx')).sky).toBe('rain');
    expect(ciHealth(runs('xxxxxxxx.')).sky).toBe('storm');
  });
});

const run = (over: Record<string, unknown> = {}) => ({
  id: 1,
  name: 'CI',
  head_branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  updated_at: '2026-11-01T10:00:00Z',
  ...over,
});

describe('parseRuns', () => {
  test('keeps finished passes and failures on the branch, newest first', () => {
    const body = {
      total_count: 7,
      workflow_runs: [
        run({ updated_at: '2026-11-01T09:00:00Z' }),
        run({ conclusion: 'failure', updated_at: '2026-11-01T11:00:00Z' }),
        run({ conclusion: 'timed_out', updated_at: '2026-11-01T08:00:00Z' }),
        run({ conclusion: 'cancelled' }),
        run({ conclusion: 'skipped' }),
        run({ status: 'in_progress', conclusion: null }),
        run({ head_branch: 'feature' }),
      ],
    };
    expect(parseRuns(body, 'main')).toEqual([
      { passed: false, at: Date.parse('2026-11-01T11:00:00Z') },
      { passed: true, at: Date.parse('2026-11-01T09:00:00Z') },
      { passed: false, at: Date.parse('2026-11-01T08:00:00Z') },
    ]);
  });

  test('skips malformed runs and rejects a body without a run list', () => {
    expect(parseRuns({ workflow_runs: [null, 7, run({ updated_at: 'soon' })] }, 'main')).toEqual(
      [],
    );
    expect(parseRuns({ total_count: 0, workflow_runs: [] }, 'main')).toEqual([]);
    expect(parseRuns({ message: 'API rate limit exceeded' }, 'main')).toBeNull();
    expect(parseRuns(null, 'main')).toBeNull();
  });
});

const ref = (input: string) => parseRepoRef(input) as RepoRef;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: { url: string; headers: Headers }[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: new Headers(init?.headers) });
    return respond();
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchRuns', () => {
  test('asks for the last 20 finished runs on the branch, with the token if there is one', async () => {
    const calls = fakeFetch(() => json({ workflow_runs: [run({ head_branch: 'release/2' })] }));

    const result = await fetchRuns(ref('octo/demo'), 'release/2', 'ghp_x');

    expect(calls.map((c) => c.url)).toEqual([
      'https://api.github.com/repos/octo/demo/actions/runs?branch=release%2F2&status=completed&per_page=20',
    ]);
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer ghp_x');
    expect(result).toEqual([{ passed: true, at: Date.parse('2026-11-01T10:00:00Z') }]);
  });

  test('reads a 404 as no CI', async () => {
    fakeFetch(() => json({ message: 'Not Found' }, 404));
    expect(await fetchRuns(ref('octo/demo'), 'main')).toEqual([]);
  });

  test.each([403, 429, 500])('fails soft on %i', async (status) => {
    fakeFetch(() => json({ message: 'nope' }, status));
    expect(await fetchRuns(ref('octo/demo'), 'main')).toBeNull();
  });

  test('fails soft when the network does, and rejects only on abort', async () => {
    fakeFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(await fetchRuns(ref('octo/demo'), 'main')).toBeNull();

    const abort = new AbortController();
    abort.abort();
    fakeFetch(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    await expect(fetchRuns(ref('octo/demo'), 'main', undefined, abort.signal)).rejects.toThrow();
  });
});

test('links to the Actions page filtered to the branch', () => {
  expect(actionsUrl({ owner: 'vitejs', repo: 'vite' }, 'main')).toBe(
    'https://github.com/vitejs/vite/actions?query=branch%3Amain',
  );
});
