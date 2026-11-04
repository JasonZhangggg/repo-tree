import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitHubFetch } from '../scripts/fake-github.mjs';
import { ownersOf, parseCodeowners } from '../src/core/codeowners';
import { schedule } from '../src/core/commits';
import { computeHistory } from '../src/core/engine';
import type { History } from '../src/shape';
import { DAY, makeRepo, type Commit } from './repo';

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
const TOKEN = 'gho_visitorvisitorvisitor';

let repo: ReturnType<typeof makeRepo>;
beforeAll(() => {
  repo = makeRepo(COMMITS);
});
afterAll(() => repo.remove());

function compute(options: { maxEntries?: number; name?: string; token?: string } = {}) {
  const fetch = gitHubFetch({ 'acme/app': { dir: repo.dir } }, { ...options, tokens: [TOKEN] });
  return computeHistory({
    fetch: fetch as unknown as typeof globalThis.fetch,
    api: 'https://api.github.test',
    token: options.token ?? TOKEN,
    repo: options.name ?? 'acme/app',
    branch: 'main',
    recentCommits: 2,
    now: () => HEAD + DAY,
  });
}

const row = (t: History['files'], path: string) => {
  const i = t.path.indexOf(path);
  expect(i, path).toBeGreaterThanOrEqual(0);
  return { changed: t.changed[i], born: t.born[i], churn: t.churn[i], commits: t.commits[i] };
};
const at = (i: number) => COMMITS[i]!.at;

describe('history', () => {
  it('describes the head with snapshots back to the root', async () => {
    const history = await compute();
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
    const { files, folders, gone } = await compute();
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
    expect(gone).toEqual([{ path: 'old/x.txt', born: at(0), gone: at(1) }]);
  });

  it('names owners from recent commits, interval authors and CODEOWNERS', async () => {
    const history = await compute();
    const byFolder = Object.fromEntries(history.owners.map((o) => [o.folder, o]));
    expect(Object.keys(byFolder)).toEqual(['', '.github', 'docs', 'src']);
    expect(byFolder.src!.authors[0]).toEqual({ name: 'cy', commits: 1, weight: 2 });
    expect(byFolder.src!.codeowners).toEqual(['@src-team']);
    expect(byFolder.docs!.codeowners).toEqual(['@docs-team']);
    expect(byFolder['']!.codeowners).toEqual(['@team']);
    expect(byFolder['']!.authors[0]).toMatchObject({ name: 'ada', commits: 1 });
  });

  it('leaves bots out of the owners', async () => {
    const bots = makeRepo([
      { at: HEAD - 9 * DAY, author: 'ada', files: { 'lib/a.ts': '1' } },
      { at: HEAD - 2 * DAY, author: 'renovate[bot]', files: { 'lib/a.ts': '2' } },
      { at: HEAD - DAY, author: 'renovate[bot]', files: { 'lib/a.ts': '3' } },
    ]);
    const history = await computeHistory({
      fetch: gitHubFetch({ 'acme/bots': { dir: bots.dir } }) as unknown as typeof fetch,
      api: 'https://api.github.test',
      repo: 'acme/bots',
      branch: 'main',
      now: () => HEAD,
    });
    bots.remove();
    expect(history.owners).toEqual([
      { folder: 'lib', authors: [{ name: 'ada', commits: 1, weight: 0 }], codeowners: [] },
    ]);
  });

  it('reads truncated trees folder by folder and reaches the same result', async () => {
    const whole = await compute();
    const split = await compute({ maxEntries: 3 });
    expect(split).toEqual(whole);
  });

  it('rejects for a repo GitHub does not know, and for a token it refuses', async () => {
    await expect(compute({ name: 'acme/nope' })).rejects.toMatchObject({ kind: 'not-found' });
    await expect(compute({ token: 'gho_revokedrevokedrevoked' })).rejects.toMatchObject({
      kind: 'unauthorized',
    });
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
