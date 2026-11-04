import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitHubFetch } from '../scripts/fake-github.mjs';
import { ownersOf, parseCodeowners } from '../src/core/codeowners';
import { schedule } from '../src/core/job';
import { HEAD_TTL_S, serveHistory, type Deps } from '../src/core/service';
import type { History, HistoryReply } from '../src/shape';
import { DAY, makeRepo, memoryStore, type Commit } from './repo';

const HEAD = Date.UTC(2026, 9, 1);
const CODEOWNERS = '* @team\n/src/ @src-team\ndocs/ @docs-team  # writers\n';
const COMMITS: Commit[] = [
  {
    at: HEAD - 1000 * DAY,
    author: 'ada',
    files: {
      'README.md': 'a',
      'src/a.ts': 'a1',
      'docs/guide.md': 'g',
      'old/x.txt': 'x',
      '.github/CODEOWNERS': CODEOWNERS,
    },
  },
  { at: HEAD - 400 * DAY, author: 'bob', files: { 'src/a.ts': 'a2', 'old/x.txt': null } },
  { at: HEAD - 100 * DAY, author: 'bob', files: { 'src/b.ts': 'b1' } },
  { at: HEAD - 20 * DAY, author: 'cy', files: { 'src/b.ts': 'b2' } },
  { at: HEAD - 3 * DAY, author: 'cy', files: { 'docs/guide.md': 'g2', 'src/c.ts': 'c' } },
  { at: HEAD, author: 'ada', files: { 'README.md': 'a2' } },
];

let repo: ReturnType<typeof makeRepo>;
beforeAll(() => {
  repo = makeRepo(COMMITS);
});
afterAll(() => repo.remove());

const TOKEN = 'gho_visitorvisitorvisitor';

function setup(options: { maxEntries?: number; remaining?: number; deps?: Partial<Deps> } = {}) {
  const fetch = gitHubFetch(
    { 'acme/app': { dir: repo.dir }, 'acme/secret': { dir: repo.dir, private: true } },
    { ...options, tokens: [TOKEN] },
  );
  const store = memoryStore();
  const clock = { now: HEAD + DAY };
  const deps: Deps = {
    store,
    fetch: fetch as unknown as typeof globalThis.fetch,
    api: 'https://api.github.test',
    now: () => clock.now,
    token: TOKEN,
    limits: { stepRequests: 5, recentCommits: 2 },
    ...options.deps,
  };
  const ask = (q = { owner: 'acme', repo: 'app' }) => serveHistory(q, deps);
  return { fetch, store, clock, deps, ask };
}

async function untilReady(
  ask: () => Promise<{ reply: HistoryReply; after?: Promise<void> }>,
  polls = 50,
): Promise<{ history: History; replies: HistoryReply[] }> {
  const replies: HistoryReply[] = [];
  for (let i = 0; i < polls; i++) {
    const { reply, after } = await ask();
    await after;
    replies.push(reply);
    if (reply.status === 'ready' && !reply.stale) return { history: reply.history, replies };
    if (reply.status === 'error') throw new Error(`error reply: ${reply.error}`);
  }
  throw new Error('never ready');
}

const row = (t: History['files'], path: string) => {
  const i = t.path.indexOf(path);
  expect(i, path).toBeGreaterThanOrEqual(0);
  return { changed: t.changed[i], born: t.born[i], churn: t.churn[i], commits: t.commits[i] };
};
const at = (i: number) => COMMITS[i]!.at;

describe('history', () => {
  it('reports pending with rising progress, then a history of the head', async () => {
    const { ask } = setup();
    const { history, replies } = await untilReady(ask);
    const pending = replies.filter((r) => r.status === 'pending');
    expect(pending.length).toBeGreaterThan(1);
    const progress = pending.map((r) => (r.status === 'pending' ? r.progress : 0));
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);

    expect(history.head).toBe(repo.shas[5]);
    expect(history.branch).toBe('main');
    expect(history.gaps).toEqual([]);
    expect(history.recent).toEqual({ since: at(4), commits: 2 });
    expect(history.snapshots.map((s) => s.sha)).toEqual([0, 1, 2, 3, 5].map((i) => repo.shas[i]));
    expect(history.files.path).toEqual([
      '.github/CODEOWNERS',
      'README.md',
      'docs/guide.md',
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
    ]);
  });

  it('dates recent changes exactly and older ones to the snapshot that first shows them', async () => {
    const { history } = await untilReady(setup().ask);
    const { files, folders } = history;
    expect(row(files, 'README.md')).toEqual({ changed: at(5), born: at(0), churn: 1, commits: 1 });
    expect(row(files, 'src/c.ts')).toEqual({ changed: at(4), born: at(4), churn: 0, commits: 1 });
    expect(row(files, 'src/b.ts')).toEqual({ changed: at(3), born: at(2), churn: 1, commits: 0 });
    expect(row(files, 'src/a.ts')).toEqual({ changed: at(1), born: at(0), churn: 1, commits: 0 });
    expect(row(folders, 'src')).toMatchObject({
      changed: at(4),
      born: at(0),
      commits: 1,
      churn: 4,
    });
    expect(row(folders, '')).toMatchObject({ changed: at(5), commits: 2 });
    expect(history.gone).toEqual([{ path: 'old/x.txt', born: at(0), gone: at(1) }]);
  });

  it('names owners from recent commits, interval authors and CODEOWNERS', async () => {
    const { history } = await untilReady(setup().ask);
    const byFolder = Object.fromEntries(history.owners.map((o) => [o.folder, o]));
    expect(Object.keys(byFolder)).toEqual(['', '.github', 'docs', 'src']);
    expect(byFolder.src!.authors[0]).toEqual({ name: 'cy', commits: 1, weight: 2 });
    expect(byFolder.src!.codeowners).toEqual(['@src-team']);
    expect(byFolder.docs!.codeowners).toEqual(['@docs-team']);
    expect(byFolder['']!.codeowners).toEqual(['@team']);
    expect(byFolder['']!.authors[0]).toMatchObject({ name: 'ada', commits: 1 });
  });

  it('answers probes from the kept listing without ending the step', async () => {
    const { ask } = setup({ deps: { limits: { stepRequests: 40, recentCommits: 2 } } });
    const { replies } = await untilReady(ask);
    expect(replies).toHaveLength(1);
  });

  it('leaves bots out of the owners', async () => {
    const bots = makeRepo([
      { at: HEAD - 9 * DAY, author: 'ada', files: { 'lib/a.ts': '1' } },
      { at: HEAD - 2 * DAY, author: 'renovate[bot]', files: { 'lib/a.ts': '2' } },
      { at: HEAD - DAY, author: 'renovate[bot]', files: { 'lib/a.ts': '3' } },
    ]);
    const deps: Deps = {
      store: memoryStore(),
      fetch: gitHubFetch({ 'acme/bots': { dir: bots.dir } }) as unknown as typeof fetch,
      api: 'https://api.github.test',
      now: () => HEAD,
      token: TOKEN,
    };
    const { history } = await untilReady(() => serveHistory({ owner: 'acme', repo: 'bots' }, deps));
    expect(history.owners).toEqual([
      { folder: 'lib', authors: [{ name: 'ada', commits: 1, weight: 0 }], codeowners: [] },
    ]);
    bots.remove();
  });

  it('serves a ready history from the cache with no GitHub request', async () => {
    const { ask, fetch } = setup();
    await untilReady(ask);
    const before = fetch.state.requests;
    const { reply } = await ask();
    expect(reply).toMatchObject({ status: 'ready', stale: false });
    expect(fetch.state.requests).toBe(before);
  });

  it('serves the old history as stale while the new head computes', async () => {
    const extra = makeRepo([...COMMITS, { at: HEAD + 2 * DAY, files: { 'src/d.ts': 'd' } }]);
    const fetch = gitHubFetch({ 'acme/app': { dir: repo.dir } });
    const { ask, clock, deps } = setup();
    await untilReady(ask);
    clock.now += (HEAD_TTL_S + 1) * 1000;
    deps.fetch = gitHubFetch({
      'acme/app': { dir: extra.dir },
    }) as unknown as typeof globalThis.fetch;
    const first = await ask();
    expect(first.reply).toMatchObject({ status: 'ready', stale: true });
    expect(first.reply.status === 'ready' && first.reply.history.head).toBe(repo.shas[5]);
    await first.after;
    const { history } = await untilReady(ask);
    expect(history.head).toBe(extra.shas[6]);
    expect(history.files.path).toContain('src/d.ts');
    expect(fetch.state.requests).toBe(0);
    extra.remove();
  });

  it('reads a truncated tree folder by folder and reaches the same result', async () => {
    const whole = (await untilReady(setup().ask)).history;
    const split = (await untilReady(setup({ maxEntries: 3 }).ask)).history;
    expect(split.gaps).toEqual([]);
    expect({ ...split, computedAt: 0 }).toEqual({ ...whole, computedAt: 0 });
  });

  it('keeps truncated older snapshots once the split budget is spent, assuming their unlisted tail unchanged', async () => {
    const whole = (await untilReady(setup().ask)).history;
    const { ask } = setup({
      maxEntries: 5,
      deps: { limits: { stepRequests: 5, recentCommits: 2, splitRequests: 0 } },
    });
    const cheap = (await untilReady(ask)).history;
    expect(cheap.gaps).toEqual(['tree-truncated']);
    expect(cheap.files.path).toEqual(whole.files.path);
    expect(cheap.snapshots).toEqual(whole.snapshots);
    expect(row(cheap.files, 'README.md')).toEqual(row(whole.files, 'README.md'));
    expect(row(cheap.files, '.github/CODEOWNERS')).toEqual(row(whole.files, '.github/CODEOWNERS'));
  });

  it('reports a repo GitHub does not know', async () => {
    const { ask } = setup();
    expect((await ask({ owner: 'acme', repo: 'nope' })).reply).toEqual({
      status: 'error',
      error: 'not-found',
    });
  });

  it('waits for the token budget to reset instead of failing, then resumes', async () => {
    const { ask, deps, store } = setup({ remaining: 6 });
    let reply: HistoryReply | undefined;
    for (let i = 0; i < 5 && !(reply?.status === 'pending' && reply.retryAfter > 2); i++) {
      reply = (await ask()).reply;
    }
    expect(reply).toMatchObject({ status: 'pending' });
    expect(reply?.status === 'pending' && reply.retryAfter).toBeGreaterThan(60);
    expect([...store.data.keys()].some((k) => k.startsWith('job:'))).toBe(true);
    deps.fetch = gitHubFetch(
      { 'acme/app': { dir: repo.dir } },
      { tokens: [TOKEN] },
    ) as unknown as typeof fetch;
    expect((await untilReady(ask)).history.head).toBe(repo.shas[5]);
  });

  it('asks a signed-out visitor to sign in for an uncached repo, and serves cached ones to anyone', async () => {
    const { ask, deps, fetch } = setup();
    deps.token = undefined;
    expect((await ask()).reply).toEqual({ status: 'needs-auth' });
    expect(fetch.state.requests).toBe(0);
    deps.token = TOKEN;
    await untilReady(ask);
    deps.token = undefined;
    const before = fetch.state.requests;
    expect((await ask()).reply).toMatchObject({ status: 'ready', stale: false });
    expect(fetch.state.requests).toBe(before);
  });

  it('refuses a token GitHub refuses, and stores nothing', async () => {
    const { ask, deps, store } = setup();
    deps.token = 'gho_revokedrevokedrevoked';
    expect((await ask()).reply).toEqual({ status: 'error', error: 'unauthorized' });
    expect(store.data.size).toBe(0);
  });

  it('never computes or stores a private repo', async () => {
    const { ask, store } = setup();
    expect((await ask({ owner: 'acme', repo: 'secret' })).reply).toEqual({
      status: 'error',
      error: 'private',
    });
    expect(store.data.size).toBe(0);
  });

  it('turns away a new repo when the host says no, but not a cached one', async () => {
    const allow = { ok: true };
    const { ask } = setup({ deps: { mayStart: async () => allow.ok } });
    await untilReady(ask);
    allow.ok = false;
    expect((await ask()).reply).toMatchObject({ status: 'ready' });
    const other = setup({ deps: { mayStart: async () => false } });
    expect((await other.ask()).reply).toMatchObject({ status: 'error', error: 'busy' });
  });
});

describe('schedule', () => {
  it('samples weekly, then monthly, then yearly back to the root', () => {
    const times = schedule(HEAD, HEAD - 10 * 365 * DAY, 80);
    const gaps = times.slice(1).map((t, i) => Math.round((times[i]! - t) / DAY));
    expect(gaps.slice(0, 25).every((g) => g === 7)).toBe(true);
    expect(times).toHaveLength(26 + 18 + 7);
    expect(times.every((t) => t > HEAD - 10 * 365 * DAY)).toBe(true);
  });

  it('keeps room for the head and the root under the cap', () => {
    expect(schedule(HEAD, null, 20)).toHaveLength(18);
  });
});

describe('codeowners', () => {
  const rules = parseCodeowners(
    '# comment\n*.js @js\n/apps/ @apps\nlib/** @lib\n*  @all\ndocs/ @docs\n',
  );
  it('takes the last rule that covers the folder', () => {
    expect(ownersOf('apps', rules)).toEqual(['@all']);
    expect(ownersOf('docs', rules)).toEqual(['@docs']);
    expect(ownersOf('', rules)).toEqual(['@all']);
    expect(ownersOf('lib', parseCodeowners('lib/** @lib'))).toEqual(['@lib']);
    expect(ownersOf('src', parseCodeowners('*.js @js'))).toEqual([]);
    expect(ownersOf('apps', parseCodeowners('/apps/ @apps\n*.md @md'))).toEqual(['@apps']);
  });
});
