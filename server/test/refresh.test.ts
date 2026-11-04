import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { gitHubFetch } from '../scripts/fake-github.mjs';
import { computeHistory, type EngineOptions, type EngineStats } from '../src/core/engine';
import { churnDelta, droppedRuns, keepOld } from '../src/core/refresh';
import { schedule, type Sample } from '../src/core/commits';
import { MODE, TreeStore } from '../src/core/trees';
import { followsSchedule } from '../src/core/upload';
import type { History } from '../src/shape';
import worker, { type Env } from '../src/worker';
import { DAY, makeRepo, type Commit } from './repo';

const HEAD = Date.UTC(2026, 9, 1);
const API = 'https://api.github.test';
const TOKEN = 'gho_fakefakefakefakefake';
const PACK = 'https://history.test/v1/git/acme/app/git-upload-pack';
const QUICK = { attempts: 4, maxWaitMs: 90_000, sleep: async () => undefined };

type Fake = ReturnType<typeof gitHubFetch>;

/** GitHub (the fake) with the history Worker in front of its git endpoint, as the page sees them. */
function viaWorker(f: Fake): typeof fetch {
  return (async (input: string, init?: RequestInit) => {
    if (!input.startsWith('https://history.test/')) return f(input, init);
    vi.stubGlobal('fetch', f);
    try {
      const env = { GITHUB_API: API, GITHUB_WEB: 'https://github.test' } as unknown as Env;
      const headers = new Headers(init?.headers);
      headers.set('Origin', 'https://jasonzhangggg.github.io');
      return await worker.fetch(new Request(input, { ...init, headers }), env);
    } finally {
      vi.unstubAllGlobals();
    }
  }) as unknown as typeof fetch;
}

function run(dir: string, head: string, extra: Partial<EngineOptions> = {}) {
  let stats: EngineStats | undefined;
  let samples: { sha: string; at: number; tree: string }[] = [];
  const f = gitHubFetch({ 'acme/app': { dir, head } });
  return computeHistory({
    fetch: viaWorker(f),
    api: API,
    repo: 'acme/app',
    branch: 'main',
    token: TOKEN,
    packUrl: PACK,
    now: () => 0,
    retry: QUICK,
    onStats: (s) => (stats = s),
    onSamples: (s) => (samples = s),
    ...extra,
  })
    .then((history) => ({ history, stats: stats!, samples }))
    .finally(() => f.close());
}

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

/** Each path of a commit's tree with its object id; folders keyed `path/`, the root `/`. */
function paths(dir: string, sha: string): Map<string, string> {
  const out = new Map([['/', git(dir, 'rev-parse', `${sha}^{tree}`)]]);
  for (const line of git(dir, 'ls-tree', '-r', '-t', sha).split('\n').filter(Boolean)) {
    const [meta = '', path = ''] = line.split('\t');
    const [, type, oid = ''] = meta.split(' ');
    out.set(type === 'tree' ? `${path}/` : path, oid);
  }
  return out;
}

/**
 * What a full fold of exactly these snapshots says about each head path, from git itself: the
 * oldest snapshot of its unbroken run, the oldest still holding the head's version, and the
 * snapshot intervals in which it changed.
 */
function reference(dir: string, snapshots: History['snapshots']) {
  const newest = [...snapshots].reverse().map((s) => ({ at: s.at, paths: paths(dir, s.sha) }));
  const out = new Map<string, { born: number; changed: number; churn: number }>();
  for (const [key, oid] of newest[0]!.paths) {
    let born = newest[0]!.at;
    let changed = born;
    let churn = 0;
    let same = true;
    for (let j = 1; j < newest.length; j++) {
      const was = newest[j]!.paths.get(key);
      if (was === undefined) break;
      born = newest[j]!.at;
      if (was !== newest[j - 1]!.paths.get(key)) {
        churn++;
        same = false;
      }
      if (same && was === oid) changed = newest[j]!.at;
    }
    out.set(key, { born, changed, churn });
  }
  return out;
}

const rows = (h: History) => {
  const out = new Map<string, { born: number; changed: number; churn: number }>();
  const add = (t: History['files'], folder: boolean) =>
    t.path.forEach((p, i) =>
      out.set(folder ? (p ? `${p}/` : '/') : p, {
        born: t.born[i]!,
        changed: t.changed[i]!,
        churn: t.churn[i]!,
      }),
    );
  add(h.files, false);
  add(h.folders, true);
  return out;
};

describe('refresh onto a stored history', () => {
  // Every commit lands in its own weekly snapshot, so a refresh keeps exactly the snapshots a
  // full run would pick, and the two must agree on everything.
  const COMMITS: Commit[] = [
    {
      at: HEAD - 40 * DAY,
      author: 'ada',
      files: { 'a/x.txt': 'x', 'a/y.txt': 'y', 'b/z.txt': 'z1', 'keep.txt': 'k1', 'lib/1.ts': '1' },
    },
    {
      at: HEAD - 30 * DAY,
      author: 'bob',
      files: { 'a/x.txt': null, 'c/x.txt': 'x', 'keep.txt': null },
    },
    { at: HEAD - 20 * DAY, author: 'cy', files: { 'keep.txt': 'k2', 'm/n.txt': 'n' } },
    { at: HEAD - 10 * DAY, author: 'bob', files: { 'b/z.txt': 'z2', 'd/e/f.txt': 'f' } },
    { at: HEAD, author: 'ada', files: { 'd/e/f.txt': null, 'b/z.txt': 'z3', 'n.txt': '1' } },
  ];
  let repo: ReturnType<typeof makeRepo>;
  beforeAll(() => {
    repo = makeRepo(COMMITS);
  });
  afterAll(() => repo.remove());

  it('yields what a full run yields, reading only the new trees and the stored head', async () => {
    for (const recentCommits of [0, 2, 100]) {
      const stored = await run(repo.dir, repo.shas[3]!, { recentCommits });
      const full = await run(repo.dir, repo.shas[4]!, { recentCommits });
      const fresh = await run(repo.dir, repo.shas[4]!, { recentCommits, base: stored.history });
      expect(fresh.stats.refresh).toMatchObject({ fresh: 1, dropped: 0, corrected: true });
      expect(fresh.history).toEqual(full.history);
      expect(fresh.samples).toEqual(full.samples);
      // The fetch wants the new head and the stored one, not every snapshot (and, as in a full
      // run, the recent commits it diffs with their parents).
      if (recentCommits === 0) {
        expect(full.stats.pack).toMatchObject({ wants: 5 });
        expect(fresh.stats.pack).toMatchObject({ wants: 2 });
      }
    }
  });

  it('computes from scratch when the stored head is not an ancestor any more', async () => {
    const other = makeRepo([
      { at: HEAD - 25 * DAY, author: 'eve', files: { 'z.txt': 'z' } },
      { at: HEAD - 15 * DAY, author: 'eve', files: { 'z.txt': 'zz' } },
    ]);
    try {
      const rewritten = await run(other.dir, other.shas[1]!, { recentCommits: 0 });
      const full = await run(repo.dir, repo.shas[4]!, { recentCommits: 0 });
      // GitHub does not know the stored snapshots: the look-up fails and nothing is reused.
      const fresh = await run(repo.dir, repo.shas[4]!, {
        recentCommits: 0,
        base: rewritten.history,
      });
      expect(fresh.stats.refresh).toBeNull();
      expect(fresh.history).toEqual(full.history);
    } finally {
      other.remove();
    }
  });

  it('computes from scratch when a stored snapshot has another time on GitHub', async () => {
    const stored = await run(repo.dir, repo.shas[3]!, { recentCommits: 0 });
    const full = await run(repo.dir, repo.shas[4]!, { recentCommits: 0 });
    const wrong: History = {
      ...stored.history,
      snapshots: stored.history.snapshots.map((s, i) => (i === 1 ? { ...s, at: s.at + 1 } : s)),
    };
    const fresh = await run(repo.dir, repo.shas[4]!, { recentCommits: 0, base: wrong });
    expect(fresh.stats.refresh).toBeNull();
    expect(fresh.history).toEqual(full.history);
  });
});

describe('refresh as old weeks age into months', () => {
  // A commit every week for 40 weeks, then three more: the stored weekly snapshots past the
  // 26th week no longer fit the schedule, so some are dropped and their intervals merge.
  const weekly = (i: number): Commit => ({
    at: HEAD - (42 - i) * 7 * DAY,
    author: i % 3 === 0 ? 'ada' : 'bob',
    files: {
      [`hot/f${i % 3}.txt`]: String(i),
      ...(i % 4 === 0 ? { [`cold/c${i % 8}.txt`]: String(i) } : {}),
      ...(i === 5 ? { 'gone/old.txt': 'x' } : {}),
      ...(i === 30 ? { 'gone/old.txt': null } : {}),
    },
  });
  let repo: ReturnType<typeof makeRepo>;
  beforeAll(() => {
    repo = makeRepo(Array.from({ length: 43 }, (_, i) => weekly(i)));
  });
  afterAll(() => repo.remove());

  it('drops what aged out, keeps the schedule, and keeps churn true to its own snapshots', async () => {
    const stored = await run(repo.dir, repo.shas[39]!, { recentCommits: 0 });
    const full = await run(repo.dir, repo.shas[42]!, { recentCommits: 0 });
    const fresh = await run(repo.dir, repo.shas[42]!, { recentCommits: 0, base: stored.history });
    const r = fresh.stats.refresh!;
    expect(r.dropped).toBeGreaterThan(0);
    expect(r.corrected).toBe(true);
    expect(followsSchedule(fresh.history.snapshots)).toBe(true);
    expect(fresh.samples.map(({ sha, at }) => ({ sha, at }))).toEqual(fresh.history.snapshots);
    expect(fresh.history.snapshots.at(-1)!.sha).toBe(repo.shas[42]);
    expect(fresh.history.snapshots[0]!.sha).toBe(repo.shas[0]);
    // Every date and churn count is what a full fold of the kept snapshots says.
    const want = reference(repo.dir, fresh.history.snapshots);
    expect(rows(fresh.history)).toEqual(want);
    expect(fresh.history.files.path).toEqual(full.history.files.path);
    expect(fresh.history.gone.map((g) => g.path)).toEqual(['gone/old.txt']);
    // Far less to download than a full run.
    const objects = (s: EngineStats) => ('objects' in s.pack! ? s.pack.objects : Infinity);
    expect(objects(fresh.stats)).toBeLessThan(objects(full.stats) / 2);
  }, 30_000);

  it('keeps refreshing week after week without drifting', async () => {
    let history = (await run(repo.dir, repo.shas[36]!, { recentCommits: 0 })).history;
    for (const at of [37, 38, 40, 42]) {
      const next = await run(repo.dir, repo.shas[at]!, { recentCommits: 0, base: history });
      expect(next.stats.refresh).not.toBeNull();
      history = next.history;
      expect(followsSchedule(history.snapshots)).toBe(true);
      expect(rows(history)).toEqual(reference(repo.dir, history.snapshots));
    }
  }, 60_000);
});

describe('keepOld', () => {
  const s = (at: number, sha = `s${at}`): Sample => ({ sha, at, tree: `t${at}` });
  it('keeps each target its newest stored snapshot, and the root', () => {
    const W = 7 * DAY;
    const head = 100 * W;
    const targets = schedule(head, 0, 80);
    const picked = [s(head), s(head - W)];
    // The stored snapshots: weekly from two weeks back, one between two targets, the root.
    const old = [s(head - 2 * W), s(head - 2.5 * W), s(head - 3 * W), s(head - 4 * W), s(1)];
    expect(keepOld(targets, picked, old)).toEqual([true, false, true, true, true]);
    const all = [...picked, ...old];
    const runs = droppedRuns(all, [true, true, true, false, true, true, true]);
    expect(runs).toEqual([{ newer: old[0], dropped: [old[1]], older: old[2] }]);
  });
});

describe('churnDelta', () => {
  it('counts a merged interval once, for paths in every tree of the chain', () => {
    const store = new TreeStore();
    const tree = (oid: string, entries: [string, string][]) => {
      const t = store.id(oid);
      store.add(
        t,
        entries.map(([name, sha]) => ({ name, oid: sha, mode: MODE.file })),
      );
      return t;
    };
    const blob = (n: number) => n.toString(16).padEnd(40, '0');
    // a.txt: 1 → 2 → 1 (back again), b.txt: 1 → 2 → 3, c.txt only in the middle.
    const newer = tree('a'.repeat(40), [
      ['a.txt', blob(1)],
      ['b.txt', blob(3)],
    ]);
    const mid = tree('b'.repeat(40), [
      ['a.txt', blob(2)],
      ['b.txt', blob(2)],
      ['c.txt', blob(9)],
    ]);
    const older = tree('c'.repeat(40), [
      ['a.txt', blob(1)],
      ['b.txt', blob(1)],
    ]);
    const d = churnDelta(store, [newer, mid, older]);
    expect(Object.fromEntries(d)).toEqual({ 'a.txt': -2, 'b.txt': -1, '/': -1 });
  });
});
