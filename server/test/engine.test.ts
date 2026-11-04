import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitHubFetch } from '../scripts/fake-github.mjs';
import { computeHistory, thin, type EngineOptions } from '../src/core/engine';
import { gitHub } from '../src/core/github';
import { DEFAULT_LIMITS, createJob, step } from '../src/core/job';
import { summarize } from '../src/core/summarize';
import { MODE, treeReader, type Node, type TreeFetch } from '../src/core/trees';
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

/** Every path below a node, as `git ls-tree -r -t` names them, with its sha. */
function flatten(node: Node, prefix = ''): string[] {
  const out: string[] = [];
  node.names.forEach((name, i) => {
    out.push(`${prefix}${name} ${node.shas[i]}`);
    const kid = node.kids[i];
    if (kid) out.push(...flatten(kid, `${prefix}${name}/`));
  });
  return out;
}

function lsTree(commit: string): string[] {
  return execFileSync('git', ['-C', repo.dir, 'ls-tree', '-r', '-t', commit], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => {
      const [meta = '', path = ''] = line.split('\t');
      return `${path} ${meta.split(' ')[2]}`;
    });
}

const kid = (node: Node, name: string) => node.kids[node.names.indexOf(name)]!;

describe('pruned tree reading', () => {
  it('reads the head whole in one request', async () => {
    const log: string[] = [];
    const reader = treeReader(fetchTreeVia(fake(), log));
    const head = await reader.read(treeOf(repo.shas[4]!), null, () => undefined, 0);
    expect(log).toHaveLength(1);
    expect(flatten(head)).toEqual(lsTree(repo.shas[4]!));
  });

  it('shares unchanged folders with the newer snapshot and fetches only what changed', async () => {
    const log: string[] = [];
    const reader = treeReader(fetchTreeVia(fake(), log), {
      requestBytes: 0,
      entryBytes: 1,
      prior: 0,
      priorWeight: 1,
      firstPrior: 0,
    });
    const newer = await reader.read(treeOf(repo.shas[4]!), null, () => undefined, 0);
    log.length = 0;
    const older = await reader.read(treeOf(repo.shas[3]!), newer, () => undefined, 0);
    expect(flatten(older)).toEqual(lsTree(repo.shas[3]!));
    // lib/, c/ and m/ did not change between these snapshots: the very same objects.
    for (const name of ['lib', 'c', 'm']) expect(kid(older, name)).toBe(kid(newer, name));
    expect(kid(kid(older, 'b'), 'deep')).not.toBe(kid(kid(newer, 'b'), 'deep'));
    // The root, b/ and b/deep/ a level at a time; b/deep/er/ (one file, a tie) and d/ (new
    // here, no size to go by) whole.
    expect(log.filter((l) => l.startsWith('L'))).toHaveLength(3);
    expect(log.filter((l) => l.startsWith('R'))).toHaveLength(2);
  });

  it('reuses a renamed folder by its sha instead of fetching it', async () => {
    const log: string[] = [];
    const levels = { requestBytes: 0, entryBytes: 1, prior: 0, priorWeight: 1, firstPrior: 0 };
    const reader = treeReader(fetchTreeVia(fake(), log), levels);
    const newer = await reader.read(treeOf(repo.shas[1]!), null, () => undefined, 0);
    log.length = 0;
    const older = await reader.read(treeOf(repo.shas[0]!), newer, () => undefined, 1);
    expect(log).toHaveLength(1);
    expect(flatten(older)).toEqual(lsTree(repo.shas[0]!));
    expect(kid(older, 'a')).toBe(kid(newer, 'c'));
    expect(reader.stats.moved).toBeGreaterThanOrEqual(1);
  });

  it('keeps the complete folders of a truncated listing and reads only the rest', async () => {
    const log: string[] = [];
    const reader = treeReader(fetchTreeVia(fake({ maxEntries: 8 }), log));
    const head = await reader.read(treeOf(repo.shas[4]!), null, () => undefined, 0);
    expect(flatten(head)).toEqual(lsTree(repo.shas[4]!));
    expect(reader.stats.truncated).toBeGreaterThanOrEqual(1);
    expect(reader.stats.salvaged).toBeGreaterThanOrEqual(1);
    const whole = lsTree(repo.shas[4]!).length;
    expect(whole).toBeGreaterThan(8);
    // Far fewer requests than one per folder.
    const folders = flatten(head).filter((l) => !l.split(' ')[0]!.includes('.')).length;
    expect(log.length).toBeLessThan(folders + 1);
  });

  it('reads truncated listings correctly even when no folder can be salvaged', async () => {
    const reader = treeReader(fetchTreeVia(fake({ maxEntries: 1 })));
    const head = await reader.read(treeOf(repo.shas[4]!), null, () => undefined, 0);
    expect(flatten(head)).toEqual(lsTree(repo.shas[4]!));
  });

  it('counts entries below each folder', async () => {
    const reader = treeReader(fetchTreeVia(fake()));
    const head = await reader.read(treeOf(repo.shas[4]!), null, () => undefined, 0);
    expect(head.count).toBe(lsTree(repo.shas[4]!).length);
    expect(head.modes[head.names.indexOf('lib')]).toBe(MODE.tree);
  });
});

async function jobHistory(f: ReturnType<typeof fake>, recentCommits: number): Promise<History> {
  const limits = { ...DEFAULT_LIMITS, recentCommits };
  const job = createJob('acme/app', 'main', repo.shas[4]!);
  while (job.phase !== 'done') {
    await step(job, gitHub({ fetch: f as unknown as typeof fetch, api: API, limit: 40 }), limits);
  }
  return summarize(job, 0);
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
  it('yields the same history as the server job', async () => {
    for (const recentCommits of [0, 2, 100]) {
      const expected = await jobHistory(fake(), recentCommits);
      expect(expected.snapshots).toHaveLength(5);
      expect(expected.gone.map((g) => g.path).sort()).toEqual(['a/x.txt', 'a/y.txt', 'd/e/f.txt']);
      expect(await engine(fake(), { recentCommits })).toEqual(expected);
    }
  });

  it('yields the same history from truncated listings', async () => {
    const expected = await jobHistory(fake(), 2);
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
  });
});

describe('thin', () => {
  it('keeps the first and last targets and spreads the rest evenly', () => {
    const targets = Array.from({ length: 50 }, (_, i) => 1000 - i);
    const kept = thin(targets, 6);
    expect(kept).toEqual([1000, 990, 980, 971, 961, 951]);
    expect(thin(targets, 80)).toEqual(targets);
  });
});
