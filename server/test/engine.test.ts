import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitHubFetch } from '../scripts/fake-github.mjs';
import {
  computeHistory,
  createCheckpoint,
  mainlineCommitter,
  thin,
  type EngineOptions,
  type EngineStats,
} from '../src/core/engine';
import { gitHub, type CommitSummary } from '../src/core/github';
import { blobKey } from '../src/core/store';
import { MODE, TreeStore, graphqlLoader, restReader, type TreeFetch } from '../src/core/trees';
import type { History } from '../src/shape';
import { DAY, makeRepo, type Commit } from './repo';

const HEAD = Date.UTC(2026, 9, 1);
const API = 'https://api.github.test';

// Each commit lands in its own weekly snapshot. Covers a folder renamed (same tree sha under a
// new name), a file deleted and re-added, a folder that comes and goes, and changes deep in an
// otherwise unchanged tree.
const COMMITS: Commit[] = [
  {
    at: HEAD - 40 * DAY,
    author: 'ada',
    files: {
      'a/x.txt': 'x',
      'a/y.txt': 'y',
      'b/z.txt': 'z1',
      'b/deep/er/w.txt': 'w',
      'keep.txt': 'k1',
      'lib/one/1.ts': '1',
      'lib/two/2.ts': '2',
    },
  },
  {
    at: HEAD - 30 * DAY,
    author: 'bob',
    files: { 'a/x.txt': null, 'a/y.txt': null, 'c/x.txt': 'x', 'c/y.txt': 'y', 'keep.txt': null },
  },
  { at: HEAD - 20 * DAY, author: 'cy', files: { 'keep.txt': 'k2', 'm/n.txt': 'n' } },
  {
    at: HEAD - 10 * DAY,
    author: 'bob',
    files: { 'b/z.txt': 'z2', 'd/e/f.txt': 'f', 'lib/two/2.ts': '22' },
  },
  { at: HEAD, author: 'ada', files: { 'd/e/f.txt': null, 'b/deep/er/w.txt': 'w2' } },
];

let repo: ReturnType<typeof makeRepo>;
beforeAll(() => {
  repo = makeRepo(COMMITS);
});
afterAll(() => repo.remove());

const treeOf = (sha: string) =>
  execFileSync('git', ['-C', repo.dir, 'rev-parse', `${sha}^{tree}`], { encoding: 'utf8' }).trim();

function fake(options: { maxEntries?: number } = {}) {
  return gitHubFetch({ 'acme/app': { dir: repo.dir } }, options);
}

function fetchTreeVia(f: ReturnType<typeof fake>, log: string[] = []): TreeFetch {
  const gh = gitHub({ fetch: f as unknown as typeof fetch, api: API, limit: Infinity });
  return async (sha, recursive) => {
    log.push(`${recursive ? 'R' : 'L'} ${sha.slice(0, 7)}`);
    return (await gh.json(`/repos/acme/app/git/trees/${sha}${recursive ? '?recursive=1' : ''}`))
      .body;
  };
}

/** Every path below tree t, with its tree sha (a folder) or blob key (a file), sorted. */
function flatten(store: TreeStore, t: number, prefix = ''): string[] {
  const out: string[] = [];
  for (let i = 0; i < store.length(t); i++) {
    const path = `${prefix}${store.name(t, i)}`;
    if (store.isTree(t, i)) {
      out.push(`${path} ${store.oids[store.ref(t, i)]}`);
      out.push(...flatten(store, store.ref(t, i), `${path}/`));
    } else out.push(`${path} ${store.ref(t, i)}`);
  }
  return prefix ? out : out.sort();
}

function lsTree(commit: string): string[] {
  return execFileSync('git', ['-C', repo.dir, 'ls-tree', '-r', '-t', commit], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => {
      const [meta = '', path = ''] = line.split('\t');
      const [, type, oid = ''] = meta.split(' ');
      return `${path} ${type === 'tree' ? oid : blobKey(oid)}`;
    })
    .sort();
}

const kid = (store: TreeStore, t: number, name: string) => store.ref(t, store.find(t, name, true));

const LEVELS = { requestBytes: 0, entryBytes: 1, prior: 0, priorWeight: 1, firstPrior: 0 };

describe('pruned tree reading', () => {
  it('reads the head whole in one request', async () => {
    const log: string[] = [];
    const store = new TreeStore();
    const reader = restReader(fetchTreeVia(fake(), log), store);
    const head = await reader.read(treeOf(repo.shas[4]!), -1, () => undefined, 0, 0);
    expect(log).toHaveLength(1);
    expect(flatten(store, head)).toEqual(lsTree(repo.shas[4]!));
  });

  it('shares unchanged folders with the newer snapshot and fetches only what changed', async () => {
    const log: string[] = [];
    const store = new TreeStore();
    const reader = restReader(fetchTreeVia(fake(), log), store, LEVELS);
    const newer = await reader.read(treeOf(repo.shas[4]!), -1, () => undefined, 0, 0);
    log.length = 0;
    const older = await reader.read(treeOf(repo.shas[3]!), newer, () => undefined, 0, 1);
    expect(flatten(store, older)).toEqual(lsTree(repo.shas[3]!));
    // lib/, c/ and m/ did not change between these snapshots: the very same trees.
    for (const name of ['lib', 'c', 'm']) {
      expect(kid(store, older, name)).toBe(kid(store, newer, name));
    }
    const deep = (t: number) => kid(store, kid(store, t, 'b'), 'deep');
    expect(deep(older)).not.toBe(deep(newer));
    // The root, b/ and b/deep/ a level at a time; b/deep/er/ (one file, a tie) and d/ (new
    // here, no size to go by) whole.
    expect(log.filter((l) => l.startsWith('L'))).toHaveLength(3);
    expect(log.filter((l) => l.startsWith('R'))).toHaveLength(2);
  });

  it('reuses a renamed folder by its sha instead of fetching it', async () => {
    const log: string[] = [];
    const store = new TreeStore();
    const reader = restReader(fetchTreeVia(fake(), log), store, LEVELS);
    const newer = await reader.read(treeOf(repo.shas[1]!), -1, () => undefined, 0, 0);
    log.length = 0;
    const older = await reader.read(treeOf(repo.shas[0]!), newer, () => undefined, 1, 1);
    expect(log).toHaveLength(1);
    expect(flatten(store, older)).toEqual(lsTree(repo.shas[0]!));
    expect(kid(store, older, 'a')).toBe(kid(store, newer, 'c'));
  });

  it('keeps the complete folders of a truncated listing and reads only the rest', async () => {
    const log: string[] = [];
    const store = new TreeStore();
    const reader = restReader(fetchTreeVia(fake({ maxEntries: 8 }), log), store);
    const head = await reader.read(treeOf(repo.shas[4]!), -1, () => undefined, 0, 0);
    expect(flatten(store, head)).toEqual(lsTree(repo.shas[4]!));
    expect(reader.stats.truncated).toBeGreaterThanOrEqual(1);
    expect(reader.stats.salvaged).toBeGreaterThanOrEqual(1);
    expect(lsTree(repo.shas[4]!).length).toBeGreaterThan(8);
    // Far fewer requests than one per folder.
    expect(log.length).toBeLessThan(store.trees);
  });

  it('reads truncated listings correctly even when no folder can be salvaged', async () => {
    const store = new TreeStore();
    const reader = restReader(fetchTreeVia(fake({ maxEntries: 1 })), store);
    const head = await reader.read(treeOf(repo.shas[4]!), -1, () => undefined, 0, 0);
    expect(flatten(store, head)).toEqual(lsTree(repo.shas[4]!));
  });

  it('counts entries below each folder', async () => {
    const store = new TreeStore();
    const reader = restReader(fetchTreeVia(fake()), store);
    const head = await reader.read(treeOf(repo.shas[4]!), -1, () => undefined, 0, 0);
    expect(store.count(head)).toBe(lsTree(repo.shas[4]!).length);
    expect(store.mode(head, store.find(head, 'lib', true))).toBe(MODE.tree);
  });
});

describe('graphql tree loader', () => {
  const query = (f: ReturnType<typeof fake>, log: number[] = []) => {
    const gh = gitHub({
      fetch: f as unknown as typeof fetch,
      api: API,
      token: 't',
      limit: Infinity,
    });
    return (q: string) => {
      log.push((q.match(/object\(/g) ?? []).length);
      return gh.graphql(q);
    };
  };

  it('reads every tree below the roots, each once, many to a query', async () => {
    const store = new TreeStore();
    const log: number[] = [];
    const loader = graphqlLoader(query(fake(), log), { owner: 'acme', name: 'app' }, store);
    for (const sha of repo.shas) loader.add(treeOf(sha));
    await loader.drain();
    for (const sha of repo.shas) {
      expect(flatten(store, store.id(treeOf(sha)))).toEqual(lsTree(sha));
    }
    expect(loader.stats.trees).toBe(store.trees);
    expect(log.length).toBeLessThan(store.trees);
  });

  it('halves its batch when GitHub fails a query, and finishes', async () => {
    const store = new TreeStore();
    const loader = graphqlLoader(
      query(gitHubFetch({ 'acme/app': { dir: repo.dir } }, { graphqlMaxEntries: 15 })),
      { owner: 'acme', name: 'app' },
      store,
      { batch: 8, concurrency: 1 },
    );
    // Five roots of five or six entries each: too many for one query, fine two at a time.
    for (const sha of repo.shas) loader.add(treeOf(sha));
    await loader.drain();
    expect(loader.stats.failed).toBeGreaterThan(0);
    expect(loader.gaveUp).toBe(false);
    for (const sha of repo.shas) {
      expect(flatten(store, store.id(treeOf(sha)))).toEqual(lsTree(sha));
    }
  });
});

/**
 * What the server's step job (removed with the Worker's computing) made of this repo, kept as
 * fixtures so the engine stays equal to it. Shas are stable: fixed contents, names and dates.
 */
function jobHistory(_f: unknown, recentCommits: number): History {
  return JSON.parse(
    readFileSync(new URL(`fixtures/history-recent-${recentCommits}.json`, import.meta.url), 'utf8'),
  ) as History;
}

function engine(f: ReturnType<typeof fake>, extra: Partial<EngineOptions> = {}) {
  return computeHistory({
    fetch: f as unknown as typeof fetch,
    api: API,
    repo: 'acme/app',
    branch: 'main',
    now: () => 0,
    ...extra,
  });
}

describe('browser engine', () => {
  it('yields the same history as the server job did', async () => {
    for (const recentCommits of [0, 2, 100]) {
      const expected = jobHistory(fake(), recentCommits);
      expect(expected.snapshots).toHaveLength(5);
      expect(expected.gone.map((g) => g.path).sort()).toEqual(['a/x.txt', 'a/y.txt', 'd/e/f.txt']);
      expect(await engine(fake(), { recentCommits })).toEqual(expected);
    }
  });

  it('yields the same history from truncated listings', async () => {
    const expected = jobHistory(fake(), 2);
    expect(await engine(fake({ maxEntries: 4 }), { recentCommits: 2 })).toEqual(expected);
  });

  it('dates paths through renames and deletions', async () => {
    const h = await engine(fake(), { recentCommits: 0 });
    const at = (i: number) => COMMITS[i]!.at;
    const row = (t: History['files'], path: string) => {
      const i = t.path.indexOf(path);
      return { changed: t.changed[i], born: t.born[i], churn: t.churn[i] };
    };
    expect(row(h.files, 'c/x.txt')).toEqual({ changed: at(1), born: at(1), churn: 0 });
    expect(row(h.files, 'keep.txt')).toEqual({ changed: at(2), born: at(2), churn: 0 });
    expect(row(h.files, 'm/n.txt')).toEqual({ changed: at(2), born: at(2), churn: 0 });
    expect(row(h.files, 'lib/two/2.ts')).toEqual({ changed: at(3), born: at(0), churn: 1 });
    expect(row(h.files, 'b/deep/er/w.txt')).toEqual({ changed: at(4), born: at(0), churn: 1 });
    expect(row(h.folders, 'b')).toEqual({ changed: at(4), born: at(0), churn: 2 });
    expect(h.gone).toContainEqual({ path: 'd/e/f.txt', born: at(3), gone: at(4) });
  });

  it('dates a folder from when it stopped being a file of the same name', async () => {
    // The server job keys rows by path, so it took the file for the folder's older version.
    const flip = makeRepo([
      { at: HEAD - 20 * DAY, files: { swap: 'file', 'x.txt': '1' } },
      { at: HEAD - 10 * DAY, files: { swap: null, 'swap/inner.txt': 'i' } },
      { at: HEAD, files: { 'x.txt': '2' } },
    ]);
    const h = await computeHistory({
      fetch: gitHubFetch({ 'acme/flip': { dir: flip.dir } }) as unknown as typeof fetch,
      api: API,
      repo: 'acme/flip',
      branch: 'main',
    });
    flip.remove();
    const i = h.folders.path.indexOf('swap');
    expect(h.folders.born[i]).toBe(HEAD - 10 * DAY);
    expect(h.folders.churn[i]).toBe(0);
    expect(h.files.path).toEqual(['swap/inner.txt', 'x.txt']);
  });

  it('reports rising progress that ends at 1', async () => {
    const seen: number[] = [];
    await engine(fake(), { onProgress: (p) => seen.push(p) });
    expect(seen.length).toBeGreaterThan(3);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it('runs requests several at a time, up to the limit', async () => {
    const f = fake();
    await engine(f, { concurrency: 3 });
    expect(f.state.peakInFlight).toBeGreaterThan(1);
    expect(f.state.peakInFlight).toBeLessThanOrEqual(3);
  });

  it('stops on abort: rejects with the reason and sends nothing after it', async () => {
    const f = fake();
    const controller = new AbortController();
    let after = 0;
    const counting = (async (input: string, init?: RequestInit) => {
      if (controller.signal.aborted) after++;
      const res = await f(input, init);
      if (input.includes('/git/trees/')) controller.abort();
      return res;
    }) as unknown as typeof fetch;
    await expect(
      computeHistory({
        fetch: counting,
        api: API,
        repo: 'acme/app',
        branch: 'main',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((r) => setTimeout(r, 50));
    expect(after).toBe(0);
  });

  it('turns a refused token into an UpstreamError', async () => {
    const f = gitHubFetch({ 'acme/app': { dir: repo.dir } }, { tokens: ['good'] });
    await expect(engine(f, { token: 'bad' })).rejects.toMatchObject({ kind: 'unauthorized' });
  });
});

const QUICK = { attempts: 4, maxWaitMs: 90_000, sleep: async () => undefined };

describe('graphql reader', () => {
  it('yields the same history as the server job did', async () => {
    for (const recentCommits of [0, 2]) {
      const expected = jobHistory(fake(), recentCommits);
      let stats: EngineStats | undefined;
      const h = await engine(fake(), {
        recentCommits,
        token: 't',
        onStats: (s) => (stats = s),
      });
      expect(h).toEqual(expected);
      expect(stats!.requests.graphql).toBeGreaterThan(0);
      expect(stats!.requests.trees).toBe(0);
    }
  });

  it('falls back to REST when GraphQL keeps failing', async () => {
    const expected = jobHistory(fake(), 2);
    const f = gitHubFetch(
      { 'acme/app': { dir: repo.dir } },
      {
        inject: (url) =>
          url.pathname === '/graphql'
            ? Promise.resolve({ status: 502, body: '', kind: 'graphql', extra: {} })
            : undefined,
      },
    );
    let stats: EngineStats | undefined;
    const h = await engine(f, {
      recentCommits: 2,
      token: 't',
      retry: QUICK,
      onStats: (s) => (stats = s),
    });
    expect(h).toEqual(expected);
    expect(stats!.graphql!.gaveUp).toBe(true);
    expect(stats!.requests.trees).toBeGreaterThan(0);
  });
});

describe('graphql limits and timeouts', () => {
  const run = (options: Parameters<typeof gitHubFetch>[1], waits: number[] = []) => {
    const f = gitHubFetch({ 'acme/app': { dir: repo.dir } }, options);
    let stats: EngineStats | undefined;
    const done = engine(f, {
      recentCommits: 2,
      token: 't',
      retry: { ...QUICK, sleep: async (ms: number) => void waits.push(ms) },
      onStats: (s) => (stats = s),
    });
    return { f, done, stats: () => stats! };
  };

  it('fails a spent GraphQL budget as rate-limited at its reset, without resending', async () => {
    const { f, done } = run({ graphqlRemaining: 0, resetInS: 3600 });
    const error = await done.catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'rate-limited' });
    const resetAt = (error as { resetAt: number }).resetAt;
    expect(Math.abs(resetAt - (f.state.resetAt * 1000 + 1000))).toBeLessThan(5000);
    expect(f.state.kinds.graphql!.requests).toBe(1);
  });

  it('waits out a RATE_LIMITED reply that resets soon, then carries on', async () => {
    const waits: number[] = [];
    const { done, stats } = run(
      { graphqlFaults: ['rate-limited'], resetInS: 5, graphqlRemaining: 1000 },
      waits,
    );
    expect(await done).toEqual(jobHistory(fake(), 2));
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(3000);
    expect(waits[0]).toBeLessThanOrEqual(6000);
    expect(stats().graphql!.failed).toBe(0);
  });

  it('waits out secondary limits, as a 403 with Retry-After or as a 200 with the message', async () => {
    const waits: number[] = [];
    const { done, stats } = run({ graphqlFaults: ['secondary-403', 'secondary-200'] }, waits);
    expect(await done).toEqual(jobHistory(fake(), 2));
    expect(waits).toEqual([30_000, 60_000]);
    expect(stats().graphql!.failed).toBe(0);
  });

  it('splits a query that timed out (200 error, 502 or 504) at once, without retrying it', async () => {
    const waits: number[] = [];
    const { f, done, stats } = run(
      { graphqlFaults: ['timeout-502', 'timeout-504', 'timeout-200'] },
      waits,
    );
    expect(await done).toEqual(jobHistory(fake(), 2));
    expect(waits).toEqual([]);
    expect(stats().graphql!.failed).toBe(3);
    expect(stats().graphql!.gaveUp).toBe(false);
    expect(f.state.kinds.trees?.requests ?? 0).toBe(0);
  });

  it('asks again for the trees a partial reply left null', async () => {
    const { f, done, stats } = run({ graphqlFaults: ['partial'] });
    expect(await done).toEqual(jobHistory(fake(), 2));
    expect(stats().graphql!.failed).toBe(0);
    expect(f.state.kinds.trees?.requests ?? 0).toBe(0);
  });

  it('keeps REST and GraphQL budgets apart', async () => {
    const f = gitHubFetch({ 'acme/app': { dir: repo.dir } }, { graphqlRemaining: 10 });
    const gh = gitHub({ fetch: f as unknown as typeof fetch, api: API, token: 't', limit: 9 });
    await gh.json('/repos/acme/app');
    await gh.graphql('query{repository(owner:"acme",name:"app"){id}}');
    expect(gh.limits.core.remaining).toBe(4999);
    expect(gh.limits.graphql.remaining).toBe(9);
  });
});

describe('retries and resuming', () => {
  /** A fake whose first `n` requests of a kind fail with `status` (and a body, headers). */
  function flaky(
    n: number,
    match: RegExp,
    reply: { status: number; body?: string; extra?: Record<string, string> },
  ) {
    let left = n;
    return gitHubFetch(
      { 'acme/app': { dir: repo.dir } },
      {
        inject: (url) =>
          match.test(url.pathname) && left-- > 0
            ? Promise.resolve({
                status: reply.status,
                body: reply.body ?? '',
                kind: 'injected',
                extra: reply.extra ?? {},
              })
            : undefined,
      },
    );
  }

  it('retries server errors, secondary limits and Retry-After, then succeeds', async () => {
    const expected = jobHistory(fake(), 2);
    const waits: number[] = [];
    const retry = { ...QUICK, sleep: async (ms: number) => void waits.push(ms) };
    for (const [f, wait] of [
      [flaky(2, /git\/trees/, { status: 502 }), 0],
      [
        flaky(1, /commits/, { status: 403, body: 'You have exceeded a secondary rate limit' }),
        60_000,
      ],
      [flaky(1, /git\/trees/, { status: 429, extra: { 'retry-after': '7' } }), 7_000],
    ] as const) {
      waits.length = 0;
      let stats: EngineStats | undefined;
      expect(await engine(f, { recentCommits: 2, retry, onStats: (s) => (stats = s) })).toEqual(
        expected,
      );
      expect(stats!.retried).toBeGreaterThan(0);
      if (wait) expect(waits).toContain(wait);
    }
  });

  it('gives up after its attempts, and fails a long wait at once as rate-limited', async () => {
    await expect(
      engine(flaky(99, /git\/trees/, { status: 502 }), { retry: QUICK }),
    ).rejects.toMatchObject({ kind: 'upstream' });
    const reset = String(Math.floor(Date.now() / 1000) + 3600);
    const spent = flaky(99, /git\/trees/, {
      status: 403,
      extra: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
    });
    await expect(engine(spent, { retry: QUICK })).rejects.toMatchObject({ kind: 'rate-limited' });
  });

  it('resumes from a checkpoint without reading anything twice', async () => {
    const expected = jobHistory(fake(), 2);
    const checkpoint = createCheckpoint();
    // The budget runs out after a few trees.
    let trees = 0;
    const read: string[] = [];
    const failing = gitHubFetch(
      { 'acme/app': { dir: repo.dir } },
      {
        inject: (url) =>
          url.pathname.includes('/git/trees/') && ++trees > 2
            ? Promise.resolve({ status: 502, body: '', kind: 'injected', extra: {} })
            : undefined,
        log: (l) => read.push(l),
      },
    );
    const plan = { requestBytes: 0, entryBytes: 1, prior: 0, priorWeight: 1, firstPrior: 0 };
    await expect(
      engine(failing, { recentCommits: 2, checkpoint, plan, retry: { attempts: 0, maxWaitMs: 0 } }),
    ).rejects.toMatchObject({ kind: 'upstream' });
    const held = checkpoint.store.trees;
    expect(held).toBeGreaterThan(0);
    const again = fake();
    const log: string[] = [];
    const logged = gitHubFetch({ 'acme/app': { dir: repo.dir } }, { log: (l) => log.push(l) });
    expect(await engine(logged, { recentCommits: 2, checkpoint, plan })).toEqual(expected);
    // Nothing read before is asked for again, but the head's page (the branch may have moved).
    expect(log.filter((l) => /\/commits\?sha=main&per_page=100$/.test(l))).toHaveLength(1);
    expect(log.filter((l) => /\/commits\?sha=[0-9a-f]{40}/.test(l))).toHaveLength(0);
    const fresh = await engine(again, { recentCommits: 2, plan });
    expect(fresh).toEqual(expected);
    const trees200 = read
      .filter((l) => l.startsWith('200 ') && l.includes('/git/trees/'))
      .map((l) => l.slice(4));
    expect(trees200.length).toBeGreaterThan(0);
    for (const path of trees200) expect(log.map((l) => l.replace(/^\d+ /, ''))).not.toContain(path);
    expect(log.length).toBeLessThanOrEqual(again.state.requests);
  });

  it('resumes onto the new head when the branch moved during the wait', async () => {
    const checkpoint = createCheckpoint();
    const before = gitHubFetch(
      { 'acme/app': { dir: repo.dir, head: repo.shas[3]! } },
      {
        inject: (url) =>
          url.pathname.includes('/git/trees/')
            ? Promise.resolve({ status: 502, body: '', kind: 'injected', extra: {} })
            : undefined,
      },
    );
    await expect(
      engine(before, { recentCommits: 2, checkpoint, retry: { attempts: 0, maxWaitMs: 0 } }),
    ).rejects.toMatchObject({ kind: 'upstream' });
    const h = await engine(fake(), { recentCommits: 2, checkpoint });
    expect(h.head).toBe(repo.shas[4]);
    expect(h).toEqual(jobHistory(fake(), 2));
  });
});

describe('commit files', () => {
  it("reads every page of a big commit, and records GitHub's 3,000-file cap", async () => {
    // Written straight to disk and added at once: makeRepo adds file by file.
    const big = makeRepo([{ at: HEAD - 20 * DAY, files: { 'seed.txt': 's' } }]);
    const commit = (n: number, v: string, at: number) => {
      mkdirSync(join(big.dir, 'f'), { recursive: true });
      for (let i = 0; i < n; i++) writeFileSync(join(big.dir, 'f', `${i}.txt`), v);
      const date = new Date(at).toISOString();
      execFileSync('git', ['-C', big.dir, 'add', '-A']);
      execFileSync('git', ['-c', 'commit.gpgsign=false', '-C', big.dir, 'commit', '-q', '-m', v], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'ada',
          GIT_AUTHOR_EMAIL: 'ada@example.com',
          GIT_COMMITTER_NAME: 'ada',
          GIT_COMMITTER_EMAIL: 'ada@example.com',
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      });
    };
    commit(3001, 'a', HEAD - 10 * DAY);
    commit(320, 'b', HEAD);
    const log: string[] = [];
    const h = await computeHistory({
      fetch: gitHubFetch(
        { 'acme/big': { dir: big.dir } },
        { log: (l) => log.push(l) },
      ) as unknown as typeof fetch,
      api: API,
      repo: 'acme/big',
      branch: 'main',
    });
    big.remove();
    expect(log.filter((l) => /\/commits\/[0-9a-f]{40}\?page=2/.test(l))).toHaveLength(2);
    expect(log.filter((l) => /\?page=10$/.test(l))).toHaveLength(1);
    expect(h.gaps).toContain('commit-files-capped');
    // f/319.txt changed in the head commit: the second page of its files.
    expect(h.files.changed[h.files.path.indexOf('f/319.txt')]).toBe(HEAD);
  }, 60_000);
});

describe('first-parent snapshots', () => {
  /**
   * A mainline committed by `linus` that merges a topic branch each week, the topic commits
   * committed by `topic`.
   */
  function merged(topic = 'dev') {
    const dir = mkdtempSync(join(tmpdir(), 'history-merge-'));
    const git = (args: string[], who = 'linus', at = 0) =>
      execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: who,
          GIT_AUTHOR_EMAIL: `${who}@example.com`,
          GIT_COMMITTER_NAME: who,
          GIT_COMMITTER_EMAIL: `${who}@example.com`,
          GIT_AUTHOR_DATE: new Date(at).toISOString(),
          GIT_COMMITTER_DATE: new Date(at).toISOString(),
        },
      }).trim();
    git(['init', '-q', '-b', 'main']);
    const start = HEAD - 12 * 7 * DAY - 3 * DAY;
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
      git(['add', path]);
    };
    write('main.txt', '0');
    git(['commit', '-q', '-m', 'root'], 'linus', start);
    // Each week: a mainline commit on day 1, topic commits on days 2 and 2.5, the merge on day
    // 4. The head lands on day 3, so every weekly target falls between a topic commit and its
    // merge, where the newest commit by date is on the topic branch.
    for (let w = 0; w < 12; w++) {
      const at = start + w * 7 * DAY;
      git(['checkout', '-q', '-b', `t${w}`]);
      for (let k = 0; k < 2; k++) {
        write(`topic/${w}-${k}.txt`, String(k));
        git(['commit', '-q', '-m', `topic ${w}.${k}`], topic, at + 2 * DAY + k * DAY * 0.5);
      }
      git(['checkout', '-q', 'main']);
      write('main.txt', String(w + 1));
      git(['commit', '-q', '-m', `main ${w}`], 'linus', at + DAY);
      git(['merge', '-q', '--no-ff', '--no-edit', `t${w}`], 'linus', at + 4 * DAY);
    }
    write('main.txt', 'head');
    git(['commit', '-q', '-m', 'head'], 'linus', start + 12 * 7 * DAY + 3 * DAY);
    const chain = new Set(git(['rev-list', '--first-parent', 'main']).split('\n'));
    return { dir, chain, remove: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('picks every snapshot on the first-parent chain', async () => {
    // Topic commits by another committer (Linux), and by the same one (where only walking
    // first parents through the listings tells them apart).
    const walked: number[] = [];
    for (const topic of ['dev', 'linus']) {
      const m = merged(topic);
      let stats: EngineStats | undefined;
      const h = await computeHistory({
        fetch: gitHubFetch({ 'acme/m': { dir: m.dir } }) as unknown as typeof fetch,
        api: API,
        repo: 'acme/m',
        branch: 'main',
        recentCommits: 0,
        onStats: (s) => (stats = s),
      });
      m.remove();
      expect(stats!.mainline).toBe('linus@example.com');
      expect(h.snapshots.length).toBeGreaterThan(8);
      for (const s of h.snapshots) expect(m.chain.has(s.sha)).toBe(true);
      walked.push(stats!.picks.walked);
    }
    expect(Math.min(...walked)).toBeGreaterThan(0);
  }, 60_000);

  it('keeps the date pick for a linear history', () => {
    const c = (sha: string, parent: string, committer: string): CommitSummary =>
      ({
        sha,
        parents: parent ? [parent] : [],
        committer,
        at: 0,
        tree: '',
        author: committer,
        merge: false,
      }) as unknown as CommitSummary;
    expect(mainlineCommitter([c('b', 'a', 'x'), c('a', '', 'y')])).toBeNull();
    // A merge commit's second parent listed before its first: not a straight line.
    const merge = { ...c('m', 'a', 'x'), parents: ['a', 'b'], merge: true };
    expect(mainlineCommitter([merge, c('b', 'z', 'y'), c('a', 'z', 'x'), c('z', '', 'x')])).toBe(
      'x',
    );
  });
});

describe('tree budget', () => {
  it('thins the snapshots once the head shows the repo is big', async () => {
    const whole = await engine(fake(), { recentCommits: 0, maxSnapshots: 80 });
    const many = makeRepo(
      Array.from({ length: 40 }, (_, i) => ({
        at: HEAD - (39 - i) * 7 * DAY,
        files: { [`f${i % 5}.txt`]: String(i) },
      })),
    );
    const run = (treeBudget?: number) =>
      computeHistory({
        fetch: gitHubFetch({ 'acme/many': { dir: many.dir } }) as unknown as typeof fetch,
        api: API,
        repo: 'acme/many',
        branch: 'main',
        recentCommits: 0,
        ...(treeBudget ? { treeBudget } : {}),
      });
    const all = await run();
    const few = await run(5 * 10);
    many.remove();
    expect(whole.snapshots).toHaveLength(5);
    expect(all.snapshots.length).toBeGreaterThan(20);
    // A 5-entry head and a 50-entry budget leave room for 9 targets, plus the head and the root.
    expect(few.snapshots.length).toBeGreaterThan(5);
    expect(few.snapshots.length).toBeLessThanOrEqual(11);
    expect(few.snapshots[few.snapshots.length - 1]!.sha).toBe(
      all.snapshots[all.snapshots.length - 1]!.sha,
    );
    // Builds a 40-commit git repo and runs three engines: slow on a busy machine.
  }, 20_000);
});

describe('thin', () => {
  it('keeps the first and last targets and spreads the rest evenly', () => {
    const targets = Array.from({ length: 50 }, (_, i) => 1000 - i);
    const kept = thin(targets, 6);
    expect(kept).toEqual([1000, 990, 980, 971, 961, 951]);
    expect(thin(targets, 80)).toEqual(targets);
  });
});
